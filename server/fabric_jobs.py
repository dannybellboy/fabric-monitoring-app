"""Read failure detail for a process's last run from the Fabric API.

ProcessExecutionStatus stores the last run's `RunInstanceId`, which is a **pipeline
job instance** id. Two endpoints describe it:

* `GET  /items/{item}/jobs/instances/{run}` — one job-level `failureReason`.
* `POST /datapipelines/pipelineruns/{run}/queryactivityruns` — per-activity detail.

The second is far more useful. For a failed Gold stored proc, the job-level message
is only *"Stored procedure has failed in the Gold Warehouse"*, while the activity
level gives the actual cause: *"Invalid column name 'appointment_date'. …"*. So both
are fetched and the activity that really failed is identified as the root cause.

Resolving the pipeline item follows the same rules NB_Orchestrator uses to trigger:

| Process | Pipeline item |
| --- | --- |
| not a stored proc | the process's own pipeline, named after the process |
| stored proc, isGold | `PL_Run_Gold_Proc` |
| stored proc, otherwise | `PL_Run_Proc` |

(The job-instance endpoint turns out to resolve a run even when a different item id
is in the path, but relying on that would be depending on undocumented leniency.)
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import net  # noqa: F401  -- imported for its TLS side effect, before requests
import requests

from fabric_auth import FABRIC_SCOPE, get_token

log = logging.getLogger("dg_tool.jobs")

FABRIC_API = "https://api.fabric.microsoft.com/v1"
# Short: a lookup may try more than one candidate pipeline, and this sits behind a
# user clicking "Why?" -- a fast partial answer beats a slow complete one.
TIMEOUT = 30

# The workspace holds ~100 pipelines and the list is needed for every lookup, so
# it is cached briefly. Short enough that a newly created pipeline appears without
# a restart.
_PIPELINE_TTL_SECONDS = 300

# Activity types that only ever fail *because something inside them failed*. They
# are containers or explicit Fail activities, so their message ("Activity failed
# because an inner activity failed") is noise -- never the root cause.
_WRAPPER_TYPES = {
    "Fail",
    "IfCondition",
    "Switch",
    "Until",
    "ForEach",
    "ExecutePipeline",
    "InvokePipeline",
}
_WRAPPER_ERROR_CODES = {"ActionFailed"}

_lock = threading.Lock()
# Cached per workspace: each environment has its own set of pipelines.
_pipelines: dict[str, tuple[dict[str, str], float]] = {}

# A job instance is immutable once Fabric has recorded it, so its failure detail
# never goes stale -- unlike the pipeline cache above, this needs no TTL. Keyed by
# run id alone (they are GUIDs, so collisions across workspaces are not a concern).
_failure_lock = threading.Lock()
_failure_cache: dict[str, dict] = {}
_failure_inflight: set[str] = set()
# Small: this only ever races the Fabric API on behalf of a user who has not
# clicked anything yet, so it must never compete meaningfully with a real request.
_prefetch_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="failure-prefetch")


class JobLookupError(RuntimeError):
    """The run could not be described (unknown pipeline, aged-out run, API error)."""


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {get_token(FABRIC_SCOPE)}",
        "Content-Type": "application/json",
    }


class WorkspaceRoleHidden(RuntimeError):
    """Fabric refused to list a workspace's role assignments.

    Meaningful rather than merely a failure: the endpoint requires Admin or
    Member on the workspace itself, so a refusal is Fabric saying the caller
    holds neither. roles.py reads it that way instead of guessing.
    """


def workspace_role_assignments(workspace_id: str) -> list[dict]:
    """Every principal with a role on `workspace_id`, as Fabric reports them.

    Each entry is {'role': 'Admin'|'Member'|'Contributor'|'Viewer', 'principal':
    {'id', 'type', 'displayName'}}. Not cached here -- roles.py caches the one
    question it asks of this, which is much smaller than the whole list.
    """
    response = requests.get(
        f"{FABRIC_API}/workspaces/{workspace_id}/roleAssignments",
        headers=_headers(),
        timeout=TIMEOUT,
    )
    if response.status_code in (401, 403):
        raise WorkspaceRoleHidden(
            f"Not permitted to list role assignments for workspace {workspace_id} "
            f"({response.status_code}): {response.text[:200]}"
        )
    if response.status_code != 200:
        raise JobLookupError(
            f"Could not list role assignments for workspace {workspace_id} "
            f"({response.status_code}): {response.text[:300]}"
        )
    return response.json().get("value", [])


def pipelines_by_name(workspace_id: str, refresh: bool = False) -> dict[str, str]:
    """displayName -> item id for every data pipeline in `workspace_id`."""
    with _lock:
        cached = _pipelines.get(workspace_id)
    if cached and not refresh and time.monotonic() - cached[1] < _PIPELINE_TTL_SECONDS:
        return cached[0]

    # The HTTP call is deliberately outside the lock: one slow workspace must not
    # block lookups for another environment.
    response = requests.get(
        f"{FABRIC_API}/workspaces/{workspace_id}/dataPipelines",
        headers=_headers(),
        timeout=TIMEOUT,
    )
    if response.status_code != 200:
        raise JobLookupError(
            f"Could not list pipelines ({response.status_code}): {response.text[:300]}"
        )

    found = {p["displayName"]: p["id"] for p in response.json().get("value", [])}
    with _lock:
        _pipelines[workspace_id] = (found, time.monotonic())
    log.info("Cached %d pipeline ids for workspace %s", len(found), workspace_id)
    return found


def lakehouse_sql_endpoint(workspace_id: str, lakehouse: str) -> str:
    """The SQL analytics endpoint host serving `lakehouse` in that workspace.

    Every item in a Fabric workspace shares one SQL endpoint host, so this doubles
    as the host for the workspace's warehouses. Resolving it from the API means an
    environment only has to supply its workspace id -- nobody has to go and copy a
    40-character hostname out of the portal.
    """
    response = requests.get(
        f"{FABRIC_API}/workspaces/{workspace_id}/lakehouses",
        headers=_headers(),
        timeout=TIMEOUT,
    )
    if response.status_code != 200:
        raise JobLookupError(
            f"Could not list lakehouses in workspace {workspace_id} "
            f"({response.status_code}): {response.text[:300]}"
        )

    items = response.json().get("value", [])
    match = next((i for i in items if i["displayName"] == lakehouse), None)
    if match is None:
        available = ", ".join(i["displayName"] for i in items[:6]) or "none"
        raise JobLookupError(
            f"No lakehouse named '{lakehouse}' in workspace {workspace_id}. "
            f"Found: {available}."
        )

    detail = requests.get(
        f"{FABRIC_API}/workspaces/{workspace_id}/lakehouses/{match['id']}",
        headers=_headers(),
        timeout=TIMEOUT,
    )
    if detail.status_code != 200:
        raise JobLookupError(
            f"Could not read lakehouse {match['id']} ({detail.status_code}): "
            f"{detail.text[:300]}"
        )

    sql = (detail.json().get("properties") or {}).get("sqlEndpointProperties") or {}
    host = sql.get("connectionString")
    if not host:
        raise JobLookupError(
            f"'{lakehouse}' in workspace {workspace_id} reports no SQL endpoint yet "
            f"(provisioning status: {sql.get('provisioningStatus', 'unknown')})."
        )
    return host


def pipeline_candidates(
    process: str, is_stored_proc: bool | None, is_gold: bool | None
) -> list[str]:
    """Pipeline names that might own this process's job instances, best first.

    A list rather than a single name because the graph flags can be unknown: an
    orphaned status row (a renamed or removed process) has no graph row to read
    isStoredPro from. The naming convention resolves those -- every process is
    either `SP_*` (a stored proc, run by a wrapper pipeline) or `PL_*` (its own
    pipeline) -- and the remaining ambiguity is settled by trying each in turn.
    """
    wrappers = ["PL_Run_Gold_Proc", "PL_Run_Proc"]

    if is_stored_proc is None:
        # Unknown: fall back to the naming convention.
        is_stored_proc = process.upper().startswith("SP_")

    if not is_stored_proc:
        return [process]

    if is_gold is None:
        return wrappers
    # Both wrappers are tried even when isGold is known, because a process can be
    # flipped between Gold and Silver after the run that is being inspected.
    return wrappers if is_gold else list(reversed(wrappers))


def resolve_pipeline(
    workspace_id: str, process: str, is_stored_proc: bool | None, is_gold: bool | None
) -> list[tuple[str, str]]:
    """Candidate (pipelineName, itemId) pairs that exist in the workspace."""
    known = pipelines_by_name(workspace_id)
    names = pipeline_candidates(process, is_stored_proc, is_gold)

    resolved = [(n, known[n]) for n in names if n in known]
    if not resolved:
        # Possibly a pipeline created since the cache was filled.
        known = pipelines_by_name(workspace_id, refresh=True)
        resolved = [(n, known[n]) for n in names if n in known]
    return resolved


def job_instance_status(
    workspace_id: str,
    process: str,
    run_id: str,
    is_stored_proc: bool | None,
    is_gold: bool | None,
) -> dict:
    """Live job-instance status only -- job level, no activity detail.

    For a fast, frequent poll of a run the status table still shows as
    Running, so the Health tab can catch up before the table's own ~20-minute
    write. Deliberately skips queryactivityruns: that call is only useful once
    something has failed, and failure_detail() already covers that case once
    the table itself flags the row critical. Deliberately uncached, unlike
    cached_failure_detail: the point of calling this repeatedly is that the
    status is exactly what may have just changed.
    """
    if not run_id:
        raise JobLookupError(f"No RunInstanceId recorded for {process}.")

    candidates = resolve_pipeline(workspace_id, process, is_stored_proc, is_gold)
    if not candidates:
        raise JobLookupError(f"No pipeline in this workspace matches '{process}'.")

    for pipeline_name, item_id in candidates:
        response = requests.get(
            f"{FABRIC_API}/workspaces/{workspace_id}"
            f"/items/{item_id}/jobs/instances/{run_id}",
            headers=_headers(),
            timeout=TIMEOUT,
        )
        if response.status_code == 200:
            job = response.json()
            return {
                "process": process,
                "runId": run_id,
                "pipelineName": pipeline_name,
                "status": job.get("status"),
                "startTimeUtc": _parse_time(job.get("startTimeUtc")),
                "endTimeUtc": _parse_time(job.get("endTimeUtc")),
            }
        if response.status_code != 404:
            log.warning(
                "Live status lookup for %s under %s returned %s",
                process,
                pipeline_name,
                response.status_code,
            )

    raise JobLookupError(f"Fabric has no job instance {run_id} for '{process}'.")


def _parse_time(value) -> datetime | None:
    if not value:
        return None
    try:
        # Fabric returns 7-digit fractional seconds, which fromisoformat rejects
        # before 3.11 and still dislikes with a trailing Z; normalise both.
        text = str(value).replace("Z", "+00:00")
        if "." in text:
            head, _, tail = text.partition(".")
            digits = "".join(c for c in tail if c.isdigit())[:6]
            offset = tail[len(digits) :] if len(tail) > len(digits) else ""
            offset = "".join(c for c in offset if c in "+-:0123456789")
            text = f"{head}.{digits}{offset}"
        parsed = datetime.fromisoformat(text)
        return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
    except (TypeError, ValueError):
        return None


def _activity(raw: dict) -> dict:
    error = raw.get("error") or {}
    return {
        "name": raw.get("activityName") or "(unnamed)",
        "type": raw.get("activityType"),
        "status": raw.get("status"),
        "errorCode": None if error.get("errorCode") in ("", None) else str(error.get("errorCode")),
        "message": error.get("message") or None,
        "failureType": error.get("failureType") or None,
        "start": _parse_time(raw.get("activityRunStart")),
        "end": _parse_time(raw.get("activityRunEnd")),
    }


def _pick_root_cause(activities: list[dict]) -> dict | None:
    """The failed activity that actually explains the failure.

    A failed pipeline usually reports several failed activities: the real one, the
    conditions wrapping it, and an explicit Fail activity used to surface the
    error. Only the real one carries a useful message.
    """
    failed = [a for a in activities if a["status"] == "Failed"]
    if not failed:
        return None

    real = [
        a
        for a in failed
        if a["type"] not in _WRAPPER_TYPES and a["errorCode"] not in _WRAPPER_ERROR_CODES
    ]
    candidates = real or failed
    # Earliest failure first: later ones are consequences of it.
    candidates.sort(key=lambda a: (a["start"] is None, a["start"] or datetime.max))
    return candidates[0]


def failure_detail(
    workspace_id: str,
    process: str,
    run_id: str,
    is_stored_proc: bool | None,
    is_gold: bool | None,
) -> dict:
    """Describe a run: job-level status plus every activity, with a root cause.

    Deliberately degrades rather than raising. A process can be orphaned, its run
    can have aged out, or the pipeline can have been renamed -- in each case the
    caller should still get whatever detail is obtainable, plus a warning saying
    what was missing, so it can fall back to the orchestrator's log.
    """
    if not run_id:
        raise JobLookupError(f"No RunInstanceId recorded for {process}.")

    detail: dict = {
        "process": process,
        "runId": run_id,
        "pipelineName": None,
        "status": None,
        "startTimeUtc": None,
        "endTimeUtc": None,
        "errorCode": None,
        "message": None,
        "activities": [],
        "rootCause": None,
        "warnings": [],
    }

    # --- job level -----------------------------------------------------------
    # Best-effort: needs the owning pipeline's item id, which is not always
    # knowable. The activity call below does not, so this failing is not fatal.
    candidates = resolve_pipeline(workspace_id, process, is_stored_proc, is_gold)
    if not candidates:
        detail["warnings"].append(
            f"No pipeline in this workspace matches '{process}', so job-level detail "
            "is unavailable. It may have been renamed or removed."
        )

    aged_out = False
    for pipeline_name, item_id in candidates:
        job_response = requests.get(
            f"{FABRIC_API}/workspaces/{workspace_id}"
            f"/items/{item_id}/jobs/instances/{run_id}",
            headers=_headers(),
            timeout=TIMEOUT,
        )
        if job_response.status_code == 200:
            job = job_response.json()
            reason = job.get("failureReason") or {}
            detail["pipelineName"] = pipeline_name
            detail["status"] = job.get("status")
            detail["startTimeUtc"] = _parse_time(job.get("startTimeUtc"))
            detail["endTimeUtc"] = _parse_time(job.get("endTimeUtc"))
            detail["errorCode"] = (
                None
                if reason.get("errorCode") in ("", None)
                else str(reason.get("errorCode"))
            )
            detail["message"] = reason.get("message") or None
            break
        if job_response.status_code == 404:
            aged_out = True
            continue  # wrong pipeline guess, or the run has expired -- try the next
        log.warning(
            "Job lookup for %s under %s returned %s",
            process,
            pipeline_name,
            job_response.status_code,
        )

    if detail["status"] is None and aged_out:
        detail["warnings"].append(
            "Fabric no longer has this job instance — runs are retained for a limited "
            "period, so the detail for an old failure may have expired."
        )

    # --- activity level ------------------------------------------------------
    # This endpoint keys off the run id alone, so it works even when the owning
    # pipeline could not be identified. It is the richer of the two: for a Gold
    # stored proc the job-level message is only "Stored procedure has failed in the
    # Gold Warehouse", while the activity carries the actual SQL error.
    activity_response = requests.post(
        f"{FABRIC_API}/workspaces/{workspace_id}"
        f"/datapipelines/pipelineruns/{run_id}/queryactivityruns",
        headers=_headers(),
        json={"lastUpdatedBefore": datetime.now(timezone.utc).isoformat()},
        timeout=TIMEOUT,
    )
    if activity_response.status_code == 200:
        body = activity_response.json()
        raw = body if isinstance(body, list) else body.get("value", [])
        activities = [_activity(item) for item in raw]
        activities.sort(key=lambda a: (a["start"] is None, a["start"] or datetime.max))
        detail["activities"] = activities
        detail["rootCause"] = _pick_root_cause(activities)
    elif activity_response.status_code != 404:
        detail["warnings"].append(
            f"Activity-level detail is unavailable ({activity_response.status_code})."
        )

    if not detail["message"] and not detail["rootCause"] and not detail["warnings"]:
        detail["warnings"].append("Fabric reported no failure detail for this run.")

    return detail


def cached_failure_detail(
    workspace_id: str,
    process: str,
    run_id: str,
    is_stored_proc: bool | None,
    is_gold: bool | None,
) -> dict:
    """`failure_detail`, memoized by run id so a background prefetch (see
    `prefetch_failures`) can make the "Why?" button instant instead of a live
    Fabric round trip."""
    with _failure_lock:
        cached = _failure_cache.get(run_id)
    if cached is not None:
        return cached

    detail = failure_detail(workspace_id, process, run_id, is_stored_proc, is_gold)
    with _failure_lock:
        _failure_cache[run_id] = detail
    return detail


def prefetch_failures(
    workspace_id: str,
    rows: list[tuple[str, str, bool | None, bool | None]],
) -> None:
    """Warm the failure-detail cache for currently-failing rows, off the caller's
    thread.

    Meant to be called every time the Health dashboard reads /api/status -- most
    calls find everything already cached (or already in flight) and do nothing,
    since a run's detail never changes once recorded. Only rows still missing get
    a Fabric lookup queued, so opening the app pays this cost once in the
    background instead of every "Why?" click paying it live.

    `rows` is (process, run_id, is_stored_proc, is_gold); failures are swallowed
    since nobody is waiting on this -- a real click still falls back to a live,
    error-reporting lookup via `cached_failure_detail`.
    """
    for process, run_id, is_stored_proc, is_gold in rows:
        if not run_id:
            continue
        with _failure_lock:
            if run_id in _failure_cache or run_id in _failure_inflight:
                continue
            _failure_inflight.add(run_id)

        def _warm(
            process=process, run_id=run_id, is_stored_proc=is_stored_proc, is_gold=is_gold
        ) -> None:
            try:
                cached_failure_detail(workspace_id, process, run_id, is_stored_proc, is_gold)
            except Exception:
                log.info("Background failure-detail prefetch failed for %s", process, exc_info=True)
            finally:
                with _failure_lock:
                    _failure_inflight.discard(run_id)

        _prefetch_pool.submit(_warm)
