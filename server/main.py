"""dg_tool API.

Dependency graph: read/write orch.dependencygraph directly (real T-SQL DML) --
the same table NB_Orchestrator_WH reads to decide what to run.
Health/Lineage: read-only, per environment, over each environment's own orch
tables.

Run it with:  uvicorn main:app --reload --port 8000
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import requests
from mcp import ClientSession
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client
from mcp.types import CallToolResult

import datadog_embed
import deployments
import fabric_auth
import fabric_jobs
import graph_diff
import preflight
import queries
import roles
import s2t
import version
from config import CONFIG
from endpoints import EndpointUnavailable
from fabric_auth import SignInRequired, get_identity
from models import (
    Deployment,
    DeploymentIn,
    DeploymentRequest,
    EnvironmentInfo,
    ERDResponse,
    FailureDetail,
    GateRequest,
    GraphApplyRequest,
    GraphApplyResult,
    GraphDiff,
    GraphRow,
    Identity,
    Issue,
    LiveJobStatus,
    ReleaseSummary,
    Row,
    RowIn,
    S2TColumnRequest,
    S2TMapping,
    S2TMetadataRequest,
    S2TProcedureTable,
    S2TTableRef,
    S2TTarget,
    S2TValidation,
    S2TValidateAllRequest,
    S2TValidateAllResponse,
    StatusReport,
)
from validation import validate_change, validate_graph
from warehouse import MissingOdbcDriver, ping

logging.basicConfig(level=logging.INFO,
                    format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("dg_tool")

app = FastAPI(title="dg_tool",
              description="CRUD for the orchestrator dependency graph")

# The Vite dev server runs on a different port, so the browser needs CORS. Only
# loopback origins are allowed: this is a local tool, and a wildcard would let any
# page the user visits drive their authenticated backend.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
    ],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(MissingOdbcDriver)
def _missing_driver(request: Request, exc: MissingOdbcDriver) -> JSONResponse:
    """503 with install instructions.

    This is an environment problem on the user's machine, not a bug in the request,
    and it is the single most likely thing to go wrong on a teammate's first run --
    so it must never surface as a 500 with a traceback.
    """
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(SignInRequired)
def _sign_in_required(request: Request, exc: SignInRequired) -> JSONResponse:
    """401 with the reason, so the UI can show its sign-in gate."""
    return JSONResponse(status_code=401, content={"detail": str(exc)})


@app.get("/api/auth")
def auth() -> dict:
    """Whether we can act, plus any in-progress sign-in. Polled by the UI's gate."""
    return fabric_auth.auth_status()


@app.post("/api/auth/signin")
def auth_signin(method: str = "browser") -> dict:
    """Start an interactive sign-in and return immediately.

    The flow blocks until the person finishes it in their browser, so it runs in a
    background thread and the UI polls /api/auth. Holding the request open would be
    indistinguishable from a hang.
    """
    try:
        return fabric_auth.sign_in(method)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/auth/signout")
def auth_signout() -> dict:
    fabric_auth.sign_out()
    return {"signedIn": False}


@app.get("/api/preflight")
def api_preflight() -> dict:
    """Environment checks with plain-English fixes."""
    return preflight.run()


@app.exception_handler(queries.ReadOnlyEnvironmentError)
def _read_only_environment(
    request: Request, exc: queries.ReadOnlyEnvironmentError
) -> JSONResponse:
    """409: a dependency-graph write aimed at an environment that cannot take DML.

    The write endpoints already refuse this before touching the warehouse, so
    reaching here means a code path found its way to queries.py without going
    through _writable_environment. Answered rather than left as a 500, because
    the reason is worth reading either way.
    """
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(EndpointUnavailable)
def _endpoint_unavailable(request: Request, exc: EndpointUnavailable) -> JSONResponse:
    """An environment's SQL endpoint could not be resolved from its workspace.

    Surfaced as 502 with the underlying reason -- usually no access to that
    workspace, or its lakehouse SQL endpoint still provisioning -- rather than a
    bare 500 that says nothing actionable.
    """
    return JSONResponse(status_code=502, content={"detail": str(exc)})


def _author() -> str:
    return get_identity()["name"]


def _author_email() -> str:
    """Email, not display name — HDX.* rows use that form (e.g. jsmith@example.com)."""
    identity = get_identity()
    return identity["username"] or identity["name"]


def _errors(issues: list[Issue]) -> list[Issue]:
    return [i for i in issues if i.level == "error"]


def _require_valid(issues: list[Issue]) -> None:
    errors = _errors(issues)
    if errors:
        raise HTTPException(
            status_code=422,
            detail={"issues": [i.model_dump() for i in issues]},
        )


@app.on_event("startup")
def _startup() -> None:
    """Report what is reachable, without refusing to start if something is not.

    This is where the one-time device-code sign-in surfaces, so the prompt appears
    in the terminal the user just started rather than mid-click. But a dead Azure
    session must not prevent the app from starting: the UI shell and
    /api/environments work regardless, and the data endpoints then return a clear
    error instead of the whole thing failing to boot.
    """
    # Never blocks and never raises: an unsigned-in start is normal now, because
    # signing in happens in the browser after the UI loads.
    preflight.log_summary()


@app.get("/api/me", response_model=Identity)
def me() -> Identity:
    identity = get_identity()
    return Identity(
        version=version.label(),
        name=identity["name"],
        username=identity["username"],
        warehouse=CONFIG.warehouse,
        monitoringConfigured=datadog_embed.configured(),
        isAdmin=roles.is_admin(),
        adminEnv=(
            admin_env.label
            if (admin_env := roles.admin_environment())
            else CONFIG.admin_env.upper()
        ),
    )


@app.get("/api/rows", response_model=list[Row])
def get_rows(env: str | None = None) -> list[dict]:
    """The dependency graph as one environment's own table holds it.

    Defaults to DEV, which is the table `edit_table` names -- so an unqualified
    call is what it always was. Unlike /api/graph this is the unfiltered,
    editable shape (RowId and audit columns, no promotion filter applied), because
    the Dependency Graph tab has to show and address the rows that are really
    there rather than the subset that environment's orchestrator would run.
    """
    return queries.list_rows(_environment(env))


@app.get("/api/rows/{row_id}", response_model=Row)
def get_row(row_id: str, env: str | None = None) -> dict:
    row = queries.get_row(row_id, _environment(env))
    if row is None:
        raise HTTPException(status_code=404, detail="No such row.")
    return row


def _writable_environment(key: str | None):
    """Resolve an environment for a dependency-graph write.

    Every write route funnels through here, so neither the admin check nor the
    read-only check can be lost by adding a route later and forgetting one.
    """
    env = _environment(key)
    roles.require_admin(env)
    if not env.writable:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{env.label} cannot be edited from dg_tool: its dependency graph "
                f"is read from {env.graph_fqn}, a lakehouse table whose SQL "
                "endpoint is read-only however the statement is phrased. It "
                "becomes editable once that environment moves to the warehouse "
                "orch schema like the others."
            ),
        )
    if "RowId" not in queries.graph_columns(env):
        raise HTTPException(
            status_code=409,
            detail=(
                f"{env.label}'s {env.graph_fqn} has no RowId column, so rows there "
                "cannot be addressed individually. Add one (see "
                "sql/01_create_graph_table.sql) to edit this environment."
            ),
        )
    return env


@app.post("/api/rows", response_model=Row, status_code=201)
def create_row(payload: RowIn, env: str | None = None) -> dict:
    target = _writable_environment(env)

    existing = queries.find_by_natural_key(
        payload.Process, payload.Dependency, env=target)
    if existing:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{payload.Process} -> {payload.Dependency or '(no dependency)'} "
                f"already exists in {target.label}."
            ),
        )

    # Validated against the environment being written to, not DEV: a cycle is a
    # property of the graph the new row is joining.
    _require_valid(validate_change(
        queries.list_rows(target), payload.model_dump(), None))

    row_id = queries.create_row(payload, _author(), env=target)
    return queries.get_row(row_id, target)


@app.put("/api/rows/{row_id}", response_model=Row)
def update_row(row_id: str, payload: RowIn, env: str | None = None) -> dict:
    target = _writable_environment(env)

    current = queries.get_row(row_id, target)
    if current is None:
        raise HTTPException(status_code=404, detail="No such row.")

    clash = queries.find_by_natural_key(
        payload.Process, payload.Dependency, row_id, env=target)
    if clash:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{payload.Process} -> {payload.Dependency or '(no dependency)'} "
                f"already exists on another row in {target.label}."
            ),
        )

    _require_valid(validate_change(
        queries.list_rows(target), payload.model_dump(), row_id))

    queries.update_row(row_id, payload, _author(), current, env=target)
    return queries.get_row(row_id, target)


@app.delete("/api/rows/{row_id}", status_code=204)
def delete_row(row_id: str, env: str | None = None) -> None:
    """Hard-delete one dependency edge -- the edit form's "remove" button.

    Unlike /active, this really removes the row, with no audit trail left
    behind. Meant for cleaning up one wrong or no-longer-needed dependency,
    not for deactivating a whole process -- that stays soft (see set_active).
    """
    target = _writable_environment(env)

    current = queries.get_row(row_id, target)
    if current is None:
        raise HTTPException(status_code=404, detail="No such row.")

    try:
        queries.delete_row(row_id, env=target)
    except queries.LastRowError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/rows/{row_id}/active", response_model=Row)
def set_active(row_id: str, active: bool, env: str | None = None) -> dict:
    """Soft delete (active=false) or restore (active=true).

    The default way to remove a process's row from live orchestration --
    keeps the row and its audit trail, the orchestrator just skips it. See
    DELETE /api/rows/{row_id} for actually removing a dependency edge.
    """
    target = _writable_environment(env)

    current = queries.get_row(row_id, target)
    if current is None:
        raise HTTPException(status_code=404, detail="No such row.")

    if active:
        # Reactivating can close a cycle that deactivation had broken, so the
        # graph is re-checked before the row goes live again.
        projected = {**current, "isActive": True}
        _require_valid(validate_change(
            queries.list_rows(target), projected, row_id))

    queries.set_active(row_id, active, _author(), env=target)
    return queries.get_row(row_id, target)


@app.post("/api/rows/{row_id}/ready", response_model=Row)
def set_ready(
    row_id: str,
    field: Literal["readyForUAT", "readyForProd"],
    value: bool,
    env: str | None = None,
) -> dict:
    """Ready-for-UAT / ready-for-Prod, ticked once per process in the UI (see
    RowTable.tsx) but stored per row, so each row on file gets its own call.

    No re-validation, unlike reactivating a row: neither flag can affect
    cycle-detection or anything else validate_change checks.
    """
    target = _writable_environment(env)

    current = queries.get_row(row_id, target)
    if current is None:
        raise HTTPException(status_code=404, detail="No such row.")

    queries.set_ready(row_id, field, value, _author(), env=target)
    return queries.get_row(row_id, target)


@app.get("/api/validate", response_model=list[Issue])
def validate(env: str | None = None) -> list[Issue]:
    """Validate one environment's whole table, for the health panel."""
    return validate_graph(queries.list_rows(_environment(env)))


@app.get("/api/graph/diff", response_model=GraphDiff)
def graph_contents_diff(left: str | None = None, right: str | None = None) -> dict:
    """Compare two environments' dependency-graph table contents.

    A data diff, not a DDL one: which edges only one side has, and which flags
    disagree on the edges both hold. See graph_diff.py for why it is a pair
    rather than all four, and why RowId cannot be the match key.
    """
    first = _environment(left)
    if right is None:
        # Unqualified means "DEV against the next environment along" rather than
        # DEV against itself, which _environment's default would otherwise give.
        following = next(
            (e for e in CONFIG.environments if e.key != first.key and e.configured),
            None,
        )
        if following is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Only {first.label} is configured, so there is nothing to "
                    "compare it against."
                ),
            )
        second = following
    else:
        second = _environment(right)

    if first.key == second.key:
        raise HTTPException(
            status_code=400,
            detail=f"Pick two different environments; both were {first.label}.",
        )
    return graph_diff.compare(first.key, second.key)


@app.post("/api/graph/apply", response_model=GraphApplyResult)
def apply_graph_row(payload: GraphApplyRequest) -> GraphApplyResult:
    """Copy one edge from the environment that has it right to the one that does not.

    The write behind the diff view's "use this side" buttons. Whole-row, for the
    reason GraphApplyRequest gives, and it only ever adds or updates -- there is
    no path here that deletes an edge from the target. Reconciling an edge that
    exists only in UAT by removing it therefore is not offered; that stays a
    deliberate deletion through the Dependency Graph tab.

    Admin-only wherever it points, DEV included -- unlike a hand edit, which is
    open to anyone in DEV. Deciding that one environment is authoritative and
    overwriting another with it is a different act from editing the staging
    table, and it is the reason this exists at all. Otherwise subject to the
    same checks: a target whose table can take DML, and the same graph
    validation, run against the target's own rows because a cycle is a property
    of the graph being joined.
    """
    roles.require_admin_everywhere("Copying rows between environments")

    source = _environment(payload.source)
    target = _writable_environment(payload.target)
    if source.key == target.key:
        raise HTTPException(
            status_code=400,
            detail=f"Source and target are both {source.label}; nothing to copy.",
        )

    row = queries.row_by_natural_key(payload.process, payload.dependency, source)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"{payload.process} -> {payload.dependency or '(no dependency)'} "
                f"no longer exists in {source.label}. Refresh the comparison."
            ),
        )

    fields = {name: row.get(name) for name in RowIn.model_fields}
    incoming = RowIn(**fields)

    existing = queries.row_by_natural_key(
        payload.process, payload.dependency, target)

    if existing is None:
        _require_valid(validate_change(
            queries.list_rows(target), incoming.model_dump(), None))
        queries.create_row(incoming, _author(), env=target)
        action, changed = "created", []
    else:
        _require_valid(validate_change(
            queries.list_rows(target), incoming.model_dump(), existing["RowId"]))
        proposed = incoming.model_dump()
        changed = [
            name for name in queries.BUSINESS_COLUMNS
            if proposed.get(name) != existing.get(name)
        ]
        written = queries.update_row(
            existing["RowId"], incoming, _author(), existing, env=target)
        action = "updated" if written else "unchanged"

    log.info(
        "Copied %s -> %s from %s to %s (%s), requested by %s",
        payload.process, payload.dependency or "(none)",
        source.label, target.label, action, _author(),
    )
    return GraphApplyResult(
        process=payload.process,
        dependency=payload.dependency,
        source=source.key,
        target=target.key,
        action=action,
        changed=changed,
    )


def _environment(key: str | None):
    """Resolve an environment key, rejecting unknown or unconfigured ones."""
    try:
        env = CONFIG.environment(key)
    except KeyError:
        known = ", ".join(e.key for e in CONFIG.environments)
        raise HTTPException(
            status_code=404, detail=f"Unknown environment '{key}'. Known: {known}."
        ) from None

    if not env.configured:
        raise HTTPException(
            status_code=503,
            detail=(
                f"{env.label} is not configured yet — add its workspace_id to "
                "server/config.json. The SQL endpoint is resolved automatically."
            ),
        )
    return env


# ---------------------------------------------------------------------------
# Source-to-target spec (HDX.Table_Metadata / HDX.Table_Columns)
#
# These live in the warehouse, which accepts DML, so this is real CRUD against the
# live spec -- no staging copy, no publish step. Neither table has a surrogate key,
# so s2t.py refuses any write whose natural key matches more than one row.
# ---------------------------------------------------------------------------


def _s2t_guard(call):
    """Translate s2t's key errors into meaningful HTTP status codes."""
    try:
        return call()
    except s2t.AmbiguousKey as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except s2t.DuplicateKey as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except s2t.StaleWrite as exc:
        # 412 rather than 409: the request was well-formed, its precondition was
        # not met. The UI special-cases it with a Reload action.
        raise HTTPException(status_code=412, detail=str(exc)) from exc
    except s2t.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        # Anything else (e.g. a warehouse/pyodbc error) would otherwise fall through
        # to a bare, detail-less 500 -- surface the real error instead.
        log.exception('s2t write failed')
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/s2t/targets", response_model=list[S2TTarget])
def s2t_targets() -> list[dict]:
    return s2t.targets()


@app.get("/api/s2t/suggestions")
def s2t_suggestions() -> dict[str, list[str]]:
    """Values offered in the form's datalists — canonical first, then existing variants."""
    return s2t.suggestions()


@app.get("/api/s2t/tables", response_model=list[S2TTableRef])
def s2t_tables(target: str) -> list[dict]:
    return s2t.tables(target)


@app.get("/api/s2t/procedures", response_model=list[S2TProcedureTable])
def s2t_procedures() -> list[dict]:
    """Procedure -> table it builds, with that table's sources. Feeds the Lineage tab."""
    return s2t.procedure_tables()


@app.get("/api/s2t/orphans", response_model=list[S2TTableRef])
def s2t_orphans(target: str) -> list[dict]:
    """Tables with columns but no metadata row — otherwise invisible and uneditable."""
    return [{"table_name": r["table_name"], "columns": r["columns"]} for r in s2t.orphan_tables(target)]


@app.get("/api/s2t/mapping", response_model=S2TMapping)
def s2t_mapping(target: str, table: str) -> dict:
    return {
        "metadata": s2t.metadata_for(table, target),
        "columns": s2t.columns_for(table, target),
        "duplicates": s2t.duplicates(table, target),
    }


@app.get("/api/s2t/validate", response_model=S2TValidation)
def s2t_validate(target: str, table: str) -> dict:
    """Diff a mapping against the live table's INFORMATION_SCHEMA in its warehouse."""
    try:
        return s2t.validate_against_ddl(table, target)
    except s2t.UnsupportedLayer as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/s2t/validate-all")
def s2t_validate_all(request: S2TValidateAllRequest) -> dict:
    """Run DDL validation across many tables and return only mismatches as JSON.

    Lightweight sync implementation: suitable for development and small runs.
    """
    try:
        # Determine targets to check
        if not request.targets or request.targets == 'all':
            targets = [t['target'] for t in s2t.targets()]
        elif isinstance(request.targets, list):
            targets = request.targets
        else:
            targets = [str(request.targets)]

        envs = request.environments or list(s2t.VALIDATION_ENVIRONMENTS)

        generated = s2t._now().isoformat()
        summary: dict[str, dict[str, int]] = {
            e: {'mismatch_tables': 0, 'checked_tables': 0} for e in envs}
        results: dict[str, list[dict]] = {e: [] for e in envs}

        for target in targets:
            try:
                tables = [r['table_name'] for r in s2t.tables(target)]
            except Exception:
                # If listing tables fails for this target, skip it
                continue

            for table in tables:
                try:
                    val = s2t.validate_against_ddl(table, target)
                except s2t.UnsupportedLayer:
                    continue
                except Exception as exc:
                    # Record an error entry per environment
                    for env in envs:
                        results[env].append(
                            {'table': table, 'target': target, 'error': str(exc)})
                    continue

                # For each environment, collect mismatched columns
                for env in envs:
                    if env not in val['environments']:
                        continue
                    # Skip envs where table is not found or access not ok
                    if not val['table_found'].get(env, False) or val['access'].get(env) != 'ok':
                        continue
                    summary[env]['checked_tables'] += 1
                    issues = []
                    for col in val['columns']:
                        env_cell = col['environments'].get(env)
                        if not env_cell:
                            continue
                        if env_cell.get('matches') is False:
                            issues.append(
                                {
                                    'column_name': col['column_name'],
                                    'mapped_data_type': col.get('mapped_data_type'),
                                    'mapped_not_null': col.get('mapped_not_null'),
                                    'live': {
                                        'present': env_cell.get('present'),
                                        'data_type': env_cell.get('data_type'),
                                        'not_null': env_cell.get('not_null'),
                                    },
                                }
                            )
                    if issues:
                        summary[env]['mismatch_tables'] += 1
                        results[env].append(
                            {'table': table, 'target': target, 'issues': issues})

        return {
            'generatedAt': generated,
            'summary': summary,
            'results': results,
        }
    except Exception as exc:
        log.exception('s2t_validate_all failed')
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/s2t/mapping", response_model=S2TMapping, status_code=201)
def s2t_create_mapping(request: S2TMetadataRequest) -> dict:
    _s2t_guard(
        lambda: s2t.create_metadata(
            request.table_name, request.medallion_layer, request.values.model_dump(), _author_email()
        )
    )
    return s2t_mapping(request.medallion_layer, request.table_name)


@app.put("/api/s2t/mapping", response_model=S2TMapping)
def s2t_update_mapping(request: S2TMetadataRequest) -> dict:
    _s2t_guard(
        lambda: s2t.update_metadata(
            request.table_name,
            request.medallion_layer,
            request.values.model_dump(),
            _author_email(),
            expected=request.expected_last_modified,
        )
    )
    return s2t_mapping(request.medallion_layer, request.table_name)


@app.delete("/api/s2t/mapping")
def s2t_delete_mapping(
    target: str, table: str, expected_last_modified: str | None = None
) -> dict:
    """Delete a mapping and all its columns. The UI confirms by typing the name."""
    removed = _s2t_guard(
        lambda: s2t.delete_mapping(
            table, target, expected=expected_last_modified)
    )
    return {
        "message": (
            f"Deleted {table} from {target}: {removed['metadata']} metadata row and "
            f"{removed['columns']} column(s)."
        ),
        **removed,
    }


@app.post("/api/s2t/columns", response_model=S2TMapping, status_code=201)
def s2t_create_column(request: S2TColumnRequest) -> dict:
    _s2t_guard(
        lambda: s2t.create_column(
            request.table_name,
            request.medallion_layer,
            request.column_name,
            request.values.model_dump(),
            _author_email(),
        )
    )
    return s2t_mapping(request.medallion_layer, request.table_name)


@app.put("/api/s2t/columns", response_model=S2TMapping)
def s2t_update_column(request: S2TColumnRequest) -> dict:
    _s2t_guard(
        lambda: s2t.update_column(
            request.table_name,
            request.medallion_layer,
            request.column_name,
            request.values.model_dump(),
            _author_email(),
            rename_to=request.rename_to,
            expected=request.expected_last_modified,
        )
    )
    return s2t_mapping(request.medallion_layer, request.table_name)


@app.delete("/api/s2t/columns", response_model=S2TMapping)
def s2t_delete_column(
    target: str, table: str, column: str, expected_last_modified: str | None = None
) -> dict:
    _s2t_guard(
        lambda: s2t.delete_column(
            table, target, column, expected=expected_last_modified)
    )
    return s2t_mapping(target, table)


# ---------------------------------------------------------------------------
# Deployment tracker (deploy.DeploymentTracker)
#
# Also live warehouse DML, and dg_tool owns the table outright -- so unlike the
# S2T tables it has a surrogate key, and unlike the dependency graph a delete
# here is a real delete. Writes carry the row version the client read, so two
# people tracking the same release cannot silently overwrite each other.
# ---------------------------------------------------------------------------


def _deployment_guard(call):
    """Translate the tracker's write errors into meaningful HTTP status codes."""
    try:
        return call()
    except deployments.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except deployments.DuplicateKey as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except deployments.StaleWrite as exc:
        # 412 rather than 409: the request was well-formed, its precondition was
        # not met. The UI special-cases it with a Reload action.
        raise HTTPException(status_code=412, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/deployments", response_model=list[Deployment])
def list_deployments(release: str | None = None) -> list[dict]:
    """Every tracked component, or one release's. Filtering is done in the UI."""
    return deployments.list_rows(release)


@app.get("/api/deployments/releases", response_model=list[ReleaseSummary])
def deployment_releases() -> list[dict]:
    return deployments.releases()


@app.get("/api/deployments/suggestions")
def deployment_suggestions() -> dict[str, list[str]]:
    """Values offered in the form's datalists — canonical first, then existing ones."""
    return deployments.suggestions()


@app.post("/api/deployments", response_model=Deployment, status_code=201)
def create_deployment(payload: DeploymentIn) -> dict:
    deployment_id = _deployment_guard(
        lambda: deployments.create(payload.model_dump(), _author_email())
    )
    return deployments.get(deployment_id)


@app.get("/api/deployments/{deployment_id}", response_model=Deployment)
def get_deployment(deployment_id: str) -> dict:
    row = deployments.get(deployment_id)
    if row is None:
        raise HTTPException(
            status_code=404, detail="No such tracked component.")
    return row


@app.put("/api/deployments/{deployment_id}", response_model=Deployment)
def update_deployment(deployment_id: str, request: DeploymentRequest) -> dict:
    _deployment_guard(
        lambda: deployments.update(
            deployment_id,
            request.values.model_dump(),
            _author_email(),
            expected=request.expected_last_modified,
        )
    )
    return deployments.get(deployment_id)


@app.post("/api/deployments/{deployment_id}/gate", response_model=Deployment)
def set_deployment_gate(deployment_id: str, request: GateRequest) -> dict:
    """Tick or clear one gate. Every other field on the row is left alone."""
    _deployment_guard(
        lambda: deployments.set_gate(
            deployment_id,
            request.gate,
            request.passed,
            request.passedOn,
            _author_email(),
            signer=_author(),
            expected=request.expected_last_modified,
        )
    )
    return deployments.get(deployment_id)


@app.delete("/api/deployments/{deployment_id}")
def delete_deployment(
    deployment_id: str, expected_last_modified: str | None = None
) -> dict:
    """Remove a tracked component. The UI confirms by name first."""
    removed = _deployment_guard(
        lambda: deployments.delete(
            deployment_id, expected=expected_last_modified)
    )
    # ComponentName is nullable, so the message falls back to the item.
    return {"message": f"Removed {deployments.label_of(removed)} from the tracker."}


@app.get("/api/environments", response_model=list[EnvironmentInfo])
def environments() -> list[EnvironmentInfo]:
    """Environments the Health, Lineage and Dependency Graph tabs can read.

    `editable` describes the table, not the caller: whether its dependency graph
    can take DML at all. Whether *this* user may use that outside DEV is
    Identity.isAdmin, and the server checks it again on every write.

    Deliberately answered from configuration alone, with no warehouse round-trip:
    the UI shell blocks on this call, and it has to keep working when Azure is
    unreachable (see _startup). The finer check -- that the table really has a
    RowId to address rows by -- costs a query, so it waits until a write actually
    arrives, in _writable_environment.
    """
    return [
        EnvironmentInfo(
            key=env.key,
            label=env.label,
            configured=env.configured,
            promotionColumn=env.promotion_column,
            editable=env.writable,
            statusWritable=queries.status_writable(env),
        )
        for env in CONFIG.environments
    ]


@app.get("/api/erd", response_model=ERDResponse)
def get_erd(env: str | None = "prd") -> ERDResponse:
    """Entity-Relationship Diagram for the Silver layer.

    Built from HDX.Table_Metadata / HDX.Table_Columns -- one shared spec, not one
    per orchestration environment -- with relationships inferred from Primary Key
    / Foreign Key column names. See s2t.erd().

    `env` cuts the diagram to the tables that actually exist in that
    environment's warehouse, and defaults to PRD: the spec also covers tables
    that are only planned, and drawing those alongside real ones misleads.
    `env=all` keeps the whole spec.
    """
    target = None if env in (None, "", "all") else _environment(env)
    try:
        return s2t.erd(target)
    except s2t.CatalogueUnreadable as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/datadog/embed-url")
def datadog_embed_url() -> dict:
    """A freshly signed URL for the Monitoring tab's embedded dashboard.

    Minted on every call rather than cached: Datadog's token is single-use and
    only valid for 30 minutes, and the tab asks for a new one each time it loads.
    """
    if not datadog_embed.configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "The Datadog dashboard is not configured. Set datadog_dashboard_url "
                "in server/config.json and the DD_EMBED_CREDENTIAL environment "
                "variable, then restart dg_tool."
            ),
        )
    try:
        return {"url": datadog_embed.signed_url()}
    except datadog_embed.DatadogEmbedUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


"""Which workspace's data agents the chat can talk to, and which one it opens on.

Both overridable by environment so this does not stay a pair of GUIDs in source
forever; the defaults are the workspace and agent the chat originally hard-coded.
"""
DATA_AGENT_WORKSPACE_ID = os.environ.get("FABRIC_DATA_AGENT_WORKSPACE", "")
DEFAULT_DATA_AGENT_ID = os.environ.get("FABRIC_DATA_AGENT_ID", "")

"""The only data agents this app will talk to.

A workspace can hold several data agents, most unrelated to this app (or
unpublished), so the chat is restricted to an explicit allow-list rather than
offering everything Fabric lists. Enforced in _list_data_agents, which is both
what fills the picker and what the chat endpoint validates against -- so an id
outside this set is refused even if it is asked for directly, not merely
absent from the dropdown.

Keyed by id rather than name, since a rename in Fabric must not silently widen it.
Empty by default -- set FABRIC_DATA_AGENT_IDS as a comma-separated list.
"""
_DEFAULT_ALLOWED_AGENT_IDS: tuple[str, ...] = ()
ALLOWED_DATA_AGENT_IDS = frozenset(
    part.strip().lower()
    for part in (
        os.environ.get("FABRIC_DATA_AGENT_IDS") or ",".join(_DEFAULT_ALLOWED_AGENT_IDS)
    ).split(",")
    if part.strip()
)

_GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _agent_mcp_url(agent_id: str) -> str:
    """The MCP endpoint for one published data agent.

    Only ever called with an id that came back from _list_data_agents, so the
    caller cannot steer this URL somewhere else.
    """
    return (
        f"https://api.fabric.microsoft.com/v1/mcp/workspaces/"
        f"{DATA_AGENT_WORKSPACE_ID}/dataagents/{agent_id}/agent"
    )


def _list_data_agents() -> list[dict]:
    """The data agents this app exposes, in name order.

    Fabric lists data agents like any other workspace item; this narrows that list
    to ALLOWED_DATA_AGENT_IDS. It is the one place the restriction lives, because
    it is both what fills the picker and what /api/oracle-mcp/chat validates
    against.
    """
    response = requests.get(
        f"https://api.fabric.microsoft.com/v1/workspaces/{DATA_AGENT_WORKSPACE_ID}/items",
        headers={"Authorization": f"Bearer {fabric_auth.get_token(fabric_auth.FABRIC_SCOPE)}"},
        params={"type": "DataAgent"},
        timeout=60,
        verify=os.environ.get("FABRIC_SSL_VERIFY", "false").lower() not in {"0", "false", "no", "off"},
    )
    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Could not list the workspace's data agents: {response.text[:500]}",
        )

    # description is passed through for the chat's opening line. Every agent in the
    # workspace currently leaves it blank, but it costs nothing to use when set.
    agents = [
        {
            "id": item["id"],
            "name": item.get("displayName") or item["id"],
            "description": (item.get("description") or "").strip(),
        }
        for item in response.json().get("value", [])
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item["id"].lower() in ALLOWED_DATA_AGENT_IDS
    ]
    agents.sort(key=lambda agent: agent["name"].lower())
    return agents


@app.get("/api/oracle-mcp/agents")
def oracle_mcp_agents() -> dict:
    """The agent picker's options, plus which one to select initially."""
    agents = _list_data_agents()
    default = DEFAULT_DATA_AGENT_ID if any(a["id"] == DEFAULT_DATA_AGENT_ID for a in agents) else None
    return {"agents": agents, "default": default or (agents[0]["id"] if agents else None)}


def _mcp_failure(exc: BaseException) -> str:
    """Flatten the cause out of an exception.

    The mcp SDK runs its transport in an anyio task group, so a transport failure
    arrives as an ExceptionGroup whose own str() is just "unhandled errors in a
    TaskGroup" -- the real cause is only in its sub-exceptions.
    """
    if isinstance(exc, BaseExceptionGroup):
        return "; ".join(_mcp_failure(sub) for sub in exc.exceptions)
    return f"{type(exc).__name__}: {exc}"


async def _ask_oracle_mcp(question: str, token: str, agent_id: str) -> CallToolResult:
    """Ask the data agent its question over MCP: initialize, tools/list, tools/call.

    This is an MCP server, not a REST endpoint -- it answers only that protocol
    conversation. A published data agent advertises exactly one tool (itself), and
    the tool's own schema names its question argument, so neither is hard-coded.
    """
    async with create_mcp_http_client({"Authorization": f"Bearer {token}"}) as http_client:
        async with streamable_http_client(_agent_mcp_url(agent_id), http_client=http_client) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()

                tools = (await session.list_tools()).tools
                if not tools:
                    raise HTTPException(
                        status_code=503,
                        detail=(
                            "The Fabric data agent advertises no MCP tools. Its MCP "
                            "endpoint only works once the data agent is published."
                        ),
                    )

                tool = tools[0]
                question_arg = next(iter(tool.input_schema["properties"]))
                return await session.call_tool(tool.name, {question_arg: question})


@app.post("/api/oracle-mcp/chat")
async def oracle_mcp_chat(request: Request) -> dict:
    """Proxy the Oracle Fabric data agent through the backend so the token stays server-side."""
    try:
        body = await request.json()
    except Exception as exc:  # pragma: no cover - validation path
        raise HTTPException(status_code=400, detail="Request body must be valid JSON.") from exc

    messages = body.get("messages") if isinstance(body, dict) else None
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="Expected a non-empty 'messages' array.")

    # The data agent tool answers one question per call; it keeps no conversation
    # state, so the newest user turn is all there is to send.
    question = next(
        (
            message["content"].strip()
            for message in reversed(messages)
            if isinstance(message, dict)
            and message.get("role") == "user"
            and isinstance(message.get("content"), str)
            and message["content"].strip()
        ),
        None,
    )
    if question is None:
        raise HTTPException(status_code=400, detail="Expected at least one user message with text.")

    # Which agent to ask. The id is checked against the workspace's real agents
    # rather than trusted, because it is interpolated into the MCP URL -- an
    # unchecked value there would let a request steer the server at an arbitrary
    # host. A bad id is the caller's mistake, so it is a 400.
    agent_id = body.get("agent") if isinstance(body, dict) else None
    if agent_id is None:
        agent_id = DEFAULT_DATA_AGENT_ID
    if not isinstance(agent_id, str) or not _GUID.match(agent_id):
        raise HTTPException(status_code=400, detail="'agent' must be a data agent id.")

    known = await run_in_threadpool(_list_data_agents)
    if not any(agent["id"] == agent_id for agent in known):
        raise HTTPException(
            status_code=400,
            detail="That data agent is not one this app can use. Reload to refresh the agent list.",
        )

    # Any agent in the workspace can be picked, so messages below name the one that
    # was actually asked rather than assuming the Oracle agent.
    agent_name = next((agent["name"] for agent in known if agent["id"] == agent_id), agent_id)

    # Every other endpoint here is a sync `def`, which Starlette runs in a thread.
    # This one is async, so the blocking token fetch has to be handed to a thread
    # explicitly or it stalls the event loop -- including the SSE reads of any MCP
    # call already in flight.
    token = await run_in_threadpool(fabric_auth.get_token, fabric_auth.FABRIC_SCOPE)

    try:
        result = await _ask_oracle_mcp(question, token, agent_id)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("MCP call to data agent %s failed", agent_name)
        failure = _mcp_failure(exc)

        # An unpublished data agent is listed like any other but its MCP endpoint
        # 404s with "Failed to get publish info" -- which says nothing to whoever
        # just picked it out of the dropdown. Several agents in the workspace are
        # in this state, so name the cause instead of reporting a transport error.
        if "publish info" in failure.lower():
            raise HTTPException(
                status_code=503,
                detail=(
                    f"The data agent '{agent_name}' is not published. Open it in Fabric and "
                    "publish it, or pick a different agent."
                ),
            ) from exc

        raise HTTPException(
            status_code=502,
            detail=f"Could not reach the data agent '{agent_name}': {failure}",
        ) from exc

    reply = "\n".join(block.text for block in result.content if block.type == "text").strip()

    if result.is_error:
        raise HTTPException(
            status_code=502,
            detail=reply[:1000] or f"The data agent '{agent_name}' reported an error.",
        )

    return {"reply": reply or f"The data agent '{agent_name}' did not return any text content."}


@app.get("/api/graph", response_model=list[GraphRow])
def graph(env: str | None = None) -> list[dict]:
    """Dependency-graph edges as this environment's orchestrator actually runs.

    Unlike /api/rows (always the editable DEV staging table), this reads that
    environment's own published orch-schema table, so the Lineage and Health
    tabs show UAT/PRD as they really are rather than DEV's rows re-filtered by
    promotion flags.
    """
    target = _environment(env)
    return queries.graph_rows(target)


@app.get("/api/status", response_model=StatusReport)
def status(env: str | None = None) -> StatusReport:
    """Execution status for the health dashboard, for one environment.

    Read-only: ProcessExecutionStatus belongs to the orchestrator. The single
    exception is reset_retry_count, which touches RetryCount and nothing else,
    and only where both the table can take a write and the caller is entitled
    to make it -- so reading this endpoint can never itself lead to a write.
    """
    from datetime import datetime, timezone

    target = _environment(env)
    rows = queries.status_rows(target)
    _prefetch_failures(target, rows)
    return StatusReport(
        env=target.key,
        rows=rows,
        untracked=queries.untracked_processes(target),
        generatedAt=datetime.now(timezone.utc).replace(tzinfo=None),
    )


def _prefetch_failures(target, rows: list[dict]) -> None:
    """Warm the Fabric failure-detail cache for whatever is failing right now, so
    the Health tab's "Why?" button reads from cache instead of waiting on a live
    Fabric round trip. Mirrors StatusDashboard's `severityOf` critical test
    (health.ts) rather than importing it, since one is Python and one is TS.
    """
    candidates = [
        (row["Process"], row["RunInstanceId"],
         row["isStoredPro"], row["isGold"])
        for row in rows
        if row["RunInstanceId"]
        and row["inGraph"]
        and row["isActive"] is not False
        and (row["Status"] == "Failed" or row["LastSuccess"] is None)
    ]
    if candidates:
        fabric_jobs.prefetch_failures(target.workspace_id, candidates)


@app.get("/api/failure", response_model=FailureDetail)
def failure(process: str, env: str | None = None) -> FailureDetail:
    """Why a process's last run failed, straight from the Fabric API.

    Passed as query parameters rather than path segments so process names never
    need URL-escaping. Read-only: this only describes an existing job instance, in
    whichever environment's workspace the run belongs to.
    """
    target = _environment(env)

    row = queries.status_for(target, process)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=f"No execution-status row for '{process}' in {target.label}.",
        )

    try:
        detail = fabric_jobs.cached_failure_detail(
            workspace_id=target.workspace_id,
            process=row["Process"],
            run_id=row["RunInstanceId"],
            # Left as None when the process has no graph row, so the resolver can
            # fall back to the SP_/PL_ naming convention instead of guessing False.
            is_stored_proc=None if row["isStoredPro"] is None else bool(
                row["isStoredPro"]),
            is_gold=None if row["isGold"] is None else bool(row["isGold"]),
        )
    except fabric_jobs.JobLookupError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach the Fabric API: {exc}",
        ) from exc

    # Fabric retains job instances only for a limited window, so a months-old
    # outage returns nothing. Fall back to whatever the orchestrator logged at the
    # time -- kept in separate fields so the UI can label its provenance.
    if not detail["message"] and not detail["rootCause"]:
        logged = queries.last_failure_log(target, row["Process"])
        if logged:
            detail["loggedMessage"] = logged["message"]
            detail["loggedAt"] = logged["timestamp"]
            detail["loggedRunId"] = logged["run_id"]

    return FailureDetail(**detail)


@app.get("/api/status/live", response_model=LiveJobStatus)
def status_live(process: str, env: str | None = None) -> LiveJobStatus:
    """Live job-instance status, straight from the Fabric API, for a row the
    status table still shows as Running.

    Meant to be polled on a much faster cadence than /api/status. Unlike
    /api/failure it is not restricted to critical rows and is not cached --
    the whole point is to catch a run finishing before the table's own next
    ~20-minute write.
    """
    target = _environment(env)

    row = queries.status_for(target, process)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=f"No execution-status row for '{process}' in {target.label}.",
        )

    try:
        detail = fabric_jobs.job_instance_status(
            workspace_id=target.workspace_id,
            process=row["Process"],
            run_id=row["RunInstanceId"],
            is_stored_proc=None if row["isStoredPro"] is None else bool(
                row["isStoredPro"]),
            is_gold=None if row["isGold"] is None else bool(row["isGold"]),
        )
    except fabric_jobs.JobLookupError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach the Fabric API: {exc}",
        ) from exc

    return LiveJobStatus(**detail)


@app.post("/api/status/retry-reset")
def reset_retry_count(process: str, env: str | None = None) -> dict:
    """Zero one process's RetryCount so the orchestrator will re-attempt it.

    The only write dg_tool makes outside its own tables. Available in DEV to
    anyone who can reach the app, and elsewhere only to a production admin --
    the same rule the dependency graph follows, since re-running a process in
    UAT is the same kind of act as changing what UAT runs.

    Deliberately narrow: one named process, RetryCount only. Status and the
    timestamps stay as the orchestrator left them, so nothing here can make a
    failed run look like it succeeded.
    """
    target = _environment(env)
    roles.require_admin(target, action="Resetting retry counts in")

    try:
        previous = queries.reset_retry_count(target, process)
    except queries.RetryResetError as exc:
        # 404 for "no such row", 409 for the rest: a read-only environment or
        # duplicate rows are both states the caller has to resolve, not retry.
        status_code = 404 if "No execution-status row" in str(exc) else 409
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc

    log.info(
        "Reset RetryCount for %s in %s (was %s), requested by %s",
        process, target.label, previous, _author(),
    )
    return {"process": process, "previousRetryCount": previous, "retryCount": 0}


# Windows' mimetypes module resolves .js/.css via HKEY_CLASSES_ROOT, and on some
# machines another installed program has rewritten .js there as text/plain --
# which makes browsers refuse to run it as a module script ("Strict MIME type
# checking"). Forcing the type for the handful of extensions Vite emits means
# asset serving never depends on that registry key.
_FORCED_MIME_TYPES = {".js": "application/javascript",
                      ".mjs": "application/javascript", ".css": "text/css"}


class AssetFiles(StaticFiles):
    def file_response(self, full_path, stat_result, scope, status_code: int = 200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        forced = _FORCED_MIME_TYPES.get(Path(full_path).suffix.lower())
        if forced and response.status_code == 200:
            response.media_type = forced
            response.headers["content-type"] = forced
        return response


# Serve the production build when it exists, so `npm run build` gives a
# single-URL app. In development the Vite dev server serves the UI instead.
_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"
if _DIST.is_dir():
    app.mount("/assets", AssetFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_DIST / "index.html")

    @app.get("/logo.png")
    def logo() -> FileResponse:
        return FileResponse(_DIST / "logo.png")
