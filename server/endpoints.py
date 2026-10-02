"""Resolve each environment's SQL endpoint host.

An environment only has to supply its `workspace_id`. If `sql_endpoint` is left
empty, it is looked up once from the Fabric API and cached for the process --
every item in a workspace shares one SQL endpoint host, so the lakehouse's host is
also the warehouse's.

Kept separate from config.py so that loading configuration stays free of network
calls: importing config must not require a live Azure session.
"""
from __future__ import annotations

import logging
import threading

import fabric_jobs

log = logging.getLogger("dg_tool.endpoints")

_lock = threading.Lock()
_resolved: dict[str, str] = {}


class EndpointUnavailable(RuntimeError):
    """The environment's SQL endpoint could not be determined."""


def sql_endpoint_for(env) -> str:
    """Host to connect to for `env`, resolving from the workspace if needed."""
    if env.sql_endpoint:
        return env.sql_endpoint

    with _lock:
        cached = _resolved.get(env.key)
    if cached:
        return cached

    if not env.workspace_id:
        raise EndpointUnavailable(
            f"{env.label} has no workspace_id, so its SQL endpoint cannot be found."
        )

    # Outside the lock: a slow or failing workspace must not block other
    # environments. A duplicate lookup under a race is harmless.
    try:
        # endpoint_lakehouse, not lakehouse: an environment reading orch-schema
        # tables straight from its warehouse has a blank `lakehouse` and would
        # otherwise have no item to resolve a host from.
        host = fabric_jobs.lakehouse_sql_endpoint(
            env.workspace_id, env.endpoint_lakehouse
        )
    except fabric_jobs.JobLookupError as exc:
        raise EndpointUnavailable(
            f"Could not resolve {env.label}'s SQL endpoint: {exc}"
        ) from exc

    with _lock:
        _resolved[env.key] = host
    log.info("Resolved %s SQL endpoint: %s", env.label, host)
    return host


def known() -> dict[str, str]:
    """Endpoints resolved so far, for diagnostics."""
    with _lock:
        return dict(_resolved)
