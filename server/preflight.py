"""Start-up checks, phrased for someone who did not build this.

A teammate who double-clicks the launcher and hits a pyodbc stack trace has no way
to act on it. Each check therefore reports what is wrong *and the specific thing to
do about it*, and the same list is shown in the browser rather than only a console.

Checks are ordered by dependency, and later ones are skipped rather than failed when
an earlier one makes them impossible -- a "warehouse unreachable" error is noise if
the real problem is that nobody has signed in.
"""
from __future__ import annotations

import logging
from pathlib import Path

import fabric_auth
from config import CONFIG

log = logging.getLogger("dg_tool.preflight")

# The ODBC driver dg_tool connects through. It is a system component, so it cannot
# be shipped inside the app.
REQUIRED_DRIVER = "ODBC Driver 18 for SQL Server"
DRIVER_DOWNLOAD = "https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server"

Status = str  # "ok" | "fail" | "warn" | "skip"


def _check(name: str, status: Status, detail: str, fix: str | None = None) -> dict:
    return {"name": name, "status": status, "detail": detail, "fix": fix}


def _odbc_driver() -> dict:
    try:
        import pyodbc
    except Exception as exc:  # noqa: BLE001
        return _check(
            "ODBC driver",
            "fail",
            f"pyodbc could not load: {exc}",
            "This is a packaging problem, not something you can fix — tell whoever built the app.",
        )

    # Ask the connection layer which driver it will actually use, so this check
    # cannot disagree with what happens on the first query.
    from warehouse import MissingOdbcDriver, resolve_driver

    drivers = list(pyodbc.drivers())
    try:
        chosen = resolve_driver()
    except MissingOdbcDriver as exc:
        return _check(
            "ODBC driver",
            "fail",
            f"no supported driver installed (found: {', '.join(drivers) or 'none'})",
            # Flatten the paragraphs so it reads as one actionable line in a list.
            " ".join(str(exc).split()),
        )

    if chosen == REQUIRED_DRIVER:
        return _check("ODBC driver", "ok", chosen)

    # An older driver is fine for everything dg_tool does; say which is in use so
    # nobody wonders, but do not make it a problem to solve.
    return _check(
        "ODBC driver",
        "warn",
        f"using {chosen} ({REQUIRED_DRIVER} is not installed)",
        f"This works. To move to the current driver, install it from {DRIVER_DOWNLOAD}",
    )


def _sign_in() -> dict:
    state = fabric_auth.auth_status()
    if state["signedIn"]:
        return _check("Azure sign-in", "ok", f"{state['name']} <{state['username']}>")
    return _check(
        "Azure sign-in",
        "fail",
        state.get("reason") or "Not signed in",
        "Use the Sign in button — it opens your browser. Nothing to install.",
    )


def _warehouse() -> dict:
    from warehouse import ping

    try:
        info = ping()
        return _check(
            "Warehouse",
            "ok",
            f"{info.get('warehouse')} as {info.get('login_name')}",
        )
    except Exception as exc:  # noqa: BLE001
        message = str(exc)
        fix = (
            "Check you are on the corporate network or VPN, then restart dg_tool. "
            "If it persists, your account may not have access to "
            f"{CONFIG.warehouse}."
        )
        if "Login failed" in message or "18456" in message:
            fix = (
                f"Your account signed in to Azure but cannot open {CONFIG.warehouse}. "
                "Ask for read access to that warehouse."
            )
        return _check("Warehouse", "fail", message[:300], fix)


def _graph_table() -> dict:
    import queries

    try:
        if queries.graph_table_exists():
            return _check("Dependency Graph table", "ok", CONFIG.edit_table)
        return _check(
            "Dependency Graph table",
            "warn",
            f"{CONFIG.edit_table} does not exist",
            "The S2T and Health tabs still work. To enable the Dependency Graph tab, "
            "someone needs to run sql/01_create_graph_table.sql once.",
        )
    except Exception as exc:  # noqa: BLE001
        return _check("Dependency Graph table", "skip", f"Not checked: {exc}"[:200])


def _tracker_table() -> dict:
    import deployments

    try:
        if deployments.table_exists():
            return _check("Deployment tracker table", "ok", deployments.TRACKER)
        return _check(
            "Deployment tracker table",
            "warn",
            f"{deployments.TRACKER} does not exist",
            "Every other tab still works. To enable the Deployments tab, someone "
            "needs to run sql/04_create_deployment_tracker.sql once.",
        )
    except Exception as exc:  # noqa: BLE001
        return _check("Deployment tracker table", "skip", f"Not checked: {exc}"[:200])


def _frontend() -> dict:
    dist = Path(__file__).resolve().parent.parent / "web" / "dist" / "index.html"
    if dist.is_file():
        return _check("Web UI", "ok", "built assets found")
    return _check(
        "Web UI",
        "warn",
        "web/dist is missing, so this server has no UI to serve",
        "Run `npm run build` in web/, or use the Vite dev server on port 5173.",
    )


def _environments() -> dict:
    ready = [e.label for e in CONFIG.environments if e.configured]
    pending = [e.label for e in CONFIG.environments if not e.configured]
    if not pending:
        return _check("Health environments", "ok", ", ".join(ready))
    return _check(
        "Health environments",
        "warn",
        f"ready: {', '.join(ready) or 'none'}; not configured: {', '.join(pending)}",
        "Add each missing environment's workspace_id to server/config.json. "
        "The SQL endpoint is resolved automatically.",
    )


def run() -> dict:
    """Every check, ordered by dependency. Cheap enough to run on demand."""
    checks = [_odbc_driver(), _frontend(), _environments(), _sign_in()]

    signed_in = any(c["name"] == "Azure sign-in" and c["status"] == "ok" for c in checks)
    driver_ok = any(c["name"] == "ODBC driver" and c["status"] != "fail" for c in checks)

    if signed_in and driver_ok:
        checks.append(_warehouse())
        if checks[-1]["status"] == "ok":
            checks.append(_graph_table())
            checks.append(_tracker_table())
        else:
            checks.append(
                _check("Dependency Graph staging table", "skip", "Warehouse is unreachable")
            )
            checks.append(
                _check("Deployment tracker table", "skip", "Warehouse is unreachable")
            )
    else:
        reason = "Not signed in" if not signed_in else "ODBC driver missing"
        checks.append(_check("Warehouse", "skip", reason))
        checks.append(_check("Dependency Graph staging table", "skip", reason))
        checks.append(_check("Deployment tracker table", "skip", reason))

    blocking = [c for c in checks if c["status"] == "fail"]
    return {
        "ok": not blocking,
        "checks": checks,
        # True when the app cannot function at all, as opposed to a degraded tab.
        "blocked": bool(blocking),
    }


def log_summary() -> dict:
    """Run the checks and write them to the console the launcher opened."""
    report = run()
    symbol = {"ok": "ok  ", "fail": "FAIL", "warn": "warn", "skip": "skip"}
    print("", flush=True)
    import version

    print(f"  dg_tool {version.label()} preflight", flush=True)
    for check in report["checks"]:
        print(f"    [{symbol.get(check['status'], '?')}] {check['name']}: {check['detail']}", flush=True)
        if check["fix"] and check["status"] in ("fail", "warn"):
            print(f"           -> {check['fix']}", flush=True)
    print("", flush=True)
    return report
