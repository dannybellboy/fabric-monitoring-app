"""Data access for the dependency graph (orch.dependencygraph).

The app edits this table directly with plain T-SQL -- no staging copy, no
drift comparison, no publish step. It is the same table NB_Orchestrator_WH
reads to decide what to run.

Every function here takes an optional `env` and defaults to DEV, whose
`graph_fqn` and warehouse are exactly the top-level `edit_table`/`warehouse`
settings, so a call with no environment behaves precisely as it did when this
module could only ever see DEV. Reads work in any configured environment;
writes are refused anywhere `Environment.writable` is false (see `_for_write`)
-- an environment still reading a lakehouse copy, whose SQL analytics endpoint
is read-only however the statement is phrased. All four environments are on
the warehouse layout today, so this refusal has no current target; it stays in
place for whatever is added next in that state.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from config import CONFIG
from models import RowIn
from endpoints import sql_endpoint_for
from warehouse import execute, query, query_one

def _env(env=None):
    """Default to DEV, the environment `edit_table` names."""
    return env if env is not None else CONFIG.environments[0]


def _at(env) -> dict:
    """Connection kwargs aiming a statement at `env`'s own warehouse.

    Passed explicitly even for DEV: load_config() keeps DEV's sql_endpoint and
    warehouse aligned with the top-level settings, so this resolves to the same
    connection the untargeted default would have used.
    """
    return {"server": sql_endpoint_for(env), "database": env.warehouse}


class ReadOnlyEnvironmentError(RuntimeError):
    """Refused: this environment's graph table cannot accept DML."""


def _for_write(env):
    """Resolve `env` for a write, refusing one that cannot accept DML.

    The check lives here rather than at the endpoint so that no route, present or
    future, can reach a read-only environment with an UPDATE by forgetting it --
    warehouse.execute() will happily target whatever it is given.
    """
    env = _env(env)
    if not env.writable:
        raise ReadOnlyEnvironmentError(
            f"{env.label} cannot be edited from dg_tool: its dependency graph is "
            f"read from {env.graph_fqn}, a lakehouse table whose SQL endpoint is "
            "read-only. It becomes editable once that environment moves to the "
            "warehouse orch schema like the others."
        )
    return env

# The columns that define a process. Used by update_row()'s "did anything
# change" check -- audit columns are deliberately excluded so that re-saving a
# row with no edits doesn't churn LastModifiedDate/ModifiedBy.
BUSINESS_COLUMNS = (
    "readyForUAT",
    "readyForProd",
    "isStoredPro",
    "RunTimes",
    "RequiresHashing",
    "isGold",
    "WarehouseName",
    "WorkspacePrefix",
    "NeedsTimestamp",
    "lookbackRequired",
    "isActive",
)

# Key columns identify a row's natural key; not otherwise treated specially.
KEY_COLUMNS = ("Process", "Dependency")

_ALL_EDITABLE = KEY_COLUMNS + BUSINESS_COLUMNS

# Every column the editable Row shape needs, in SELECT order.
_ROW_COLUMNS = (
    "RowId",
    "Process",
    "Dependency",
    "readyForUAT",
    "readyForProd",
    "isStoredPro",
    "RunTimes",
    "RequiresHashing",
    "isGold",
    "WarehouseName",
    "WorkspacePrefix",
    "NeedsTimestamp",
    "lookbackRequired",
    "isActive",
    "LastModifiedDate",
    "CreatedBy",
    "createdDate",
    "ModifiedBy",
)

# The bit columns, with what to select when an environment's table predates one.
# Row types them as plain bools, so a NULL would fail model validation; isActive
# stands in as 1 because a row the orchestrator can see is one it would run.
_BIT_DEFAULTS = {
    "readyForUAT": 0,
    "readyForProd": 0,
    "isStoredPro": 0,
    "RequiresHashing": 0,
    "isGold": 0,
    "NeedsTimestamp": 0,
    "lookbackRequired": 0,
    "isActive": 1,
}

_columns_cache: dict[str, frozenset[str]] = {}


def graph_columns(env=None) -> frozenset[str]:
    """Which of `_ROW_COLUMNS` this environment's graph table actually has.

    The four environments' tables are not guaranteed to be the same shape. DEV's
    is the one sql/01_create_graph_table.sql builds, but the others were created
    at different times -- lookbackRequired in particular was added later by
    sql/06_add_lookback_column.sql, and Fabric Warehouse cannot add a NOT NULL
    column to a populated table, which is why it is the one nullable flag.

    Probing means a missing column degrades to a default instead of failing the
    whole read with "Invalid column name" and taking the tab down with it.
    Cached per environment: changing this table's shape is a migration, not a
    runtime event.
    """
    env = _env(env)
    cached = _columns_cache.get(env.key)
    if cached is not None:
        return cached

    # INFORMATION_SCHEMA is per database, so a table read by three-part name has
    # to be looked up in its own catalog -- the same cross-database hop the graph
    # read itself already makes for an environment still on a lakehouse copy.
    catalog = f"[{env.lakehouse}]." if env.lakehouse else ""
    rows = query(
        f"""
        SELECT COLUMN_NAME FROM {catalog}INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        """,
        env.schema,
        env.graph_table,
        **_at(env),
    )
    present = {str(r["COLUMN_NAME"]).lower() for r in rows}
    found = frozenset(c for c in _ROW_COLUMNS if c.lower() in present)

    # No rows means the probe could not see the table at all, not that the table
    # has no columns -- selecting the all-defaults shape that would imply returns
    # a table of literals and no data. Assume the canonical shape instead, which
    # is the unguarded SELECT this code used before the probe existed.
    if not found:
        found = frozenset(_ROW_COLUMNS)

    _columns_cache[env.key] = found
    return found


def _select_rows(env) -> str:
    """A SELECT of the editable row shape, filling in whatever `env` lacks.

    lookbackRequired is read through ISNULL wherever it exists, for the reason
    given in graph_columns().
    """
    available = graph_columns(env)
    parts = []
    for column in _ROW_COLUMNS:
        if column in available:
            parts.append(
                f"ISNULL({column}, 0) AS {column}"
                if column == "lookbackRequired"
                else column
            )
        elif column in _BIT_DEFAULTS:
            parts.append(f"CAST({_BIT_DEFAULTS[column]} AS bit) AS {column}")
        else:
            parts.append(f"NULL AS {column}")
    return f"SELECT {', '.join(parts)}\nFROM {env.graph_fqn}\n"


def _now() -> datetime:
    # Naive UTC, matching the existing datetime2 values written by the notebook's
    # current_timestamp(). Mixing in an offset here would make comparisons and
    # the Delta merge behave inconsistently.
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _to_bools(row: dict) -> dict:
    """Convert the driver's 0/1 bit values into real booleans."""
    for column in _ALL_EDITABLE:
        if column in row and isinstance(row[column], int) and column not in KEY_COLUMNS:
            row[column] = bool(row[column])
    return row


def list_rows(env=None) -> list[dict]:
    env = _env(env)
    rows = query(
        _select_rows(env) + " ORDER BY Process, Dependency", **_at(env)
    )
    return [_to_bools(r) for r in rows]


def get_row(row_id: str, env=None) -> dict | None:
    """One row by RowId, matched against the shape _select_rows builds.

    Filtered outside a derived table rather than with a plain WHERE on the raw
    table, so the row comes back through the same column shaping (ISNULL
    defaults, bit casts) that list_rows applies -- a bare `WHERE RowId = ?`
    against `env.graph_fqn` would skip that.
    """
    env = _env(env)
    row = query_one(
        f"SELECT * FROM (\n{_select_rows(env)}) AS r WHERE r.RowId = ?",
        row_id,
        **_at(env),
    )
    return _to_bools(row) if row else None


def _dependency_key(dependency: str | None) -> str:
    """"No dependency", in the one form both NULL and '' compare equal to.

    The live tables hold both: sql/01 says NULL and RowIn._clean writes NULL,
    but every environment also carries a handful of empty strings put there by
    something else -- 8 of them in DEV. Matching on `Dependency IS NULL` alone
    therefore cannot find those rows at all, which made them impossible to look
    up by natural key and so impossible to copy between environments.

    Collapsing both to '' is also exactly how graph_diff._key matches edges, so
    a row the comparison pairs up is a row this can then find.
    """
    return (dependency or "").strip().lower()


def row_by_natural_key(process: str, dependency: str | None, env=None) -> dict | None:
    """The whole editable shape for one edge, matched on its natural key.

    Unlike find_by_natural_key, which answers "does this clash with anything?"
    and needs only an id, this is for reading a row in order to copy it. Goes
    through _select_rows so it applies the same column shaping as list_rows,
    and so is safe to point at any configured environment as a source.
    """
    env = _env(env)
    row = query_one(
        f"""
        SELECT * FROM (
        {_select_rows(env)}) AS r
        WHERE LOWER(LTRIM(RTRIM(r.Process))) = ?
          AND LOWER(LTRIM(RTRIM(ISNULL(r.Dependency, '')))) = ?
        """,
        process.strip().lower(),
        _dependency_key(dependency),
        **_at(env),
    )
    return _to_bools(row) if row else None


def find_by_natural_key(
    process: str,
    dependency: str | None,
    exclude_row_id: str | None = None,
    env=None,
) -> dict | None:
    """Look up a row by the (Process, Dependency) pair, case-insensitively.

    NULL and '' are the same dependency here -- see _dependency_key. This is the
    duplicate check behind create and update, so treating them as different
    would let a second copy of an edge in under whichever spelling the first one
    did not use.
    """
    env = _env(env)
    sql = f"""
        SELECT RowId, Process, Dependency FROM {env.graph_fqn}
        WHERE LOWER(LTRIM(RTRIM(Process))) = ?
          AND LOWER(LTRIM(RTRIM(ISNULL(Dependency, '')))) = ?
    """
    params: list = [
        process.strip().lower(),
        _dependency_key(dependency),
    ]
    if exclude_row_id:
        sql += " AND RowId <> ?"
        params.append(exclude_row_id)
    return query_one(sql, *params, **_at(env))


def create_row(payload: RowIn, author: str, env=None) -> str:
    """Insert one dependency edge, naming only columns `env`'s table has.

    Built from graph_columns() rather than written out, so an environment whose
    table predates a column (lookbackRequired, most likely -- see graph_columns)
    takes the insert without it instead of failing on an unknown column name.
    """
    env = _for_write(env)
    row_id = str(uuid.uuid4())
    now = _now()
    values = {
        "RowId": row_id,
        "Process": payload.Process,
        "Dependency": payload.Dependency,
        "readyForUAT": payload.readyForUAT,
        "readyForProd": payload.readyForProd,
        "isStoredPro": payload.isStoredPro,
        "RunTimes": payload.RunTimes,
        "RequiresHashing": payload.RequiresHashing,
        "isGold": payload.isGold,
        "WarehouseName": payload.WarehouseName,
        "WorkspacePrefix": payload.WorkspacePrefix,
        "NeedsTimestamp": payload.NeedsTimestamp,
        "lookbackRequired": payload.lookbackRequired,
        "isActive": payload.isActive,
        "LastModifiedDate": now,
        "CreatedBy": author,
        "createdDate": now,
        "ModifiedBy": author,
    }
    columns = [c for c in _ROW_COLUMNS if c in graph_columns(env)]
    execute(
        f"""
        INSERT INTO {env.graph_fqn} ({", ".join(columns)})
        VALUES ({", ".join("?" for _ in columns)})
        """,
        *(values[c] for c in columns),
        **_at(env),
    )
    return row_id


def update_row(row_id: str, payload: RowIn, author: str, current: dict, env=None) -> bool:
    """Apply an edit. Returns False (and writes nothing) if nothing changed.

    Skipping no-op saves keeps LastModifiedDate meaningful and avoids churning
    the audit trail every time someone opens and closes the edit form.
    """
    env = _for_write(env)
    incoming = payload.model_dump()
    if all(incoming[c] == current.get(c) for c in _ALL_EDITABLE):
        return False

    assignments = {
        "Process": payload.Process,
        "Dependency": payload.Dependency,
        "readyForUAT": payload.readyForUAT,
        "readyForProd": payload.readyForProd,
        "isStoredPro": payload.isStoredPro,
        "RunTimes": payload.RunTimes,
        "RequiresHashing": payload.RequiresHashing,
        "isGold": payload.isGold,
        "WarehouseName": payload.WarehouseName,
        "WorkspacePrefix": payload.WorkspacePrefix,
        "NeedsTimestamp": payload.NeedsTimestamp,
        "lookbackRequired": payload.lookbackRequired,
        "isActive": payload.isActive,
        "LastModifiedDate": _now(),
        "ModifiedBy": author,
    }
    # Same reason as create_row: only set columns this environment actually has.
    columns = [c for c in assignments if c in graph_columns(env)]
    execute(
        f"""
        UPDATE {env.graph_fqn}
        SET {", ".join(f"{c} = ?" for c in columns)}
        WHERE RowId = ?
        """,
        *(assignments[c] for c in columns),
        row_id,
        **_at(env),
    )
    return True


def set_active(row_id: str, active: bool, author: str, env=None) -> bool:
    """Soft delete / restore. The row is never physically removed.

    dg_tool has no hard-delete path by design: this table drives live
    orchestration, and a deactivated row stays auditable while the orchestrator
    skips it. Physical removal remains a deliberate manual operation.
    """
    env = _for_write(env)
    changed = execute(
        f"""
        UPDATE {env.graph_fqn}
        SET isActive = ?, LastModifiedDate = ?, ModifiedBy = ?
        WHERE RowId = ? AND isActive <> ?
        """,
        active,
        _now(),
        author,
        row_id,
        active,
        **_at(env),
    )
    return bool(changed)


class LastRowError(RuntimeError):
    """Refused: this is the only row left for the process."""


def delete_row(row_id: str, env=None) -> bool:
    """Hard-delete one dependency edge. Returns False if row_id doesn't exist.

    Unlike set_active, this really removes the row -- for cleaning up one
    (Process, Dependency) edge from the edit form's "remove" button, not for
    deactivating a whole process (that stays soft, via set_active, so it
    keeps its audit trail). Refuses to delete a process's last remaining row:
    that would silently erase the process itself rather than one dependency.
    """
    env = _for_write(env)
    row = query_one(
        f"SELECT Process FROM {env.graph_fqn} WHERE RowId = ?", row_id, **_at(env)
    )
    if row is None:
        return False

    remaining = query_one(
        f"""
        SELECT COUNT(*) AS n FROM {env.graph_fqn}
        WHERE LOWER(LTRIM(RTRIM(Process))) = LOWER(LTRIM(RTRIM(?))) AND RowId <> ?
        """,
        row["Process"],
        row_id,
        **_at(env),
    )
    if not remaining or remaining["n"] == 0:
        raise LastRowError(
            f"{row['Process']} has no other rows on file -- deactivate the process "
            "instead of deleting its only dependency."
        )

    return bool(
        execute(
            f"DELETE FROM {env.graph_fqn} WHERE RowId = ?", row_id, **_at(env)
        )
    )


_READY_COLUMNS = {"readyForUAT": "readyForUAT", "readyForProd": "readyForProd"}


def set_ready(row_id: str, field: str, value: bool, author: str, env=None) -> bool:
    """Tick/untick readyForUAT or readyForProd on one row.

    Mirrors set_active: a single-field UPDATE with no re-validation, since
    neither flag affects cycle-detection or anything else validate_change
    checks. `field` is looked up in a whitelist rather than interpolated
    directly, even though main.py's Literal type already restricts it to the
    same two names -- belt and suspenders against ever building SQL from a
    raw caller-supplied column name.
    """
    env = _for_write(env)
    column = _READY_COLUMNS[field]
    changed = execute(
        f"""
        UPDATE {env.graph_fqn}
        SET {column} = ?, LastModifiedDate = ?, ModifiedBy = ?
        WHERE RowId = ? AND {column} <> ?
        """,
        value,
        _now(),
        author,
        row_id,
        value,
        **_at(env),
    )
    return bool(changed)


def graph_table_exists(env=None) -> bool:
    env = _env(env)
    catalog = f"[{env.lakehouse}]." if env.lakehouse else ""
    found = query_one(
        f"""
        SELECT 1 AS ok FROM {catalog}INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        """,
        env.schema,
        env.graph_table,
        **_at(env),
    )
    return found is not None


# --------------------------------------------------------------------------
# Execution status (read-only)
# --------------------------------------------------------------------------

# ProcessExecutionStatus is written by the orchestrator, which is driven by the
# *Lakehouse* dependency graph -- so "is this process in the graph?" is answered
# against the Lakehouse, not against staging. If the two ever diverge, the
# dashboard should describe what the orchestrator actually sees.

# Only these columns may gate an environment. The value comes from config, so it
# is not user input, but it is interpolated into SQL -- an allowlist keeps that
# true even if config is ever loaded from somewhere less trusted.
_PROMOTION_COLUMNS = {"readyForUAT", "readyForProd"}


def _promotion_filter(env) -> str:
    """WHERE clause restricting the graph to what this environment runs.

    NB_Orchestrator filters `readyForUAT` in UAT and `readyForProd` in PRD, and
    applies no filter in DEV or QA. Mirroring that here means "in the graph" and
    "untracked" both mean what they mean *to that environment's orchestrator*.
    """
    column = env.promotion_column
    if not column:
        return ""
    if column not in _PROMOTION_COLUMNS:
        raise ValueError(f"Unsupported promotion column: {column!r}")
    return f"WHERE {column} = 1"


def _graph_aggregate(env) -> str:
    """One row per process, flags OR-ed together.

    MAX() because a process has one row per dependency: it is a stored proc, or
    Gold, or promoted, if *any* of its rows says so -- the same "any edge" rule
    the orchestrator applies.
    """
    return f"""
        SELECT Process,
               MAX(CAST(readyForUAT AS int))  AS readyForUAT,
               MAX(CAST(readyForProd AS int)) AS readyForProd,
               MAX(CAST(isActive AS int))     AS isActive,
               MAX(CAST(isStoredPro AS int))  AS isStoredPro,
               MAX(CAST(isGold AS int))       AS isGold
        FROM {env.graph_fqn}
        {_promotion_filter(env)}
        GROUP BY Process
    """


def graph_rows(env) -> list[dict]:
    """Dependency-graph edges as this environment's own orchestrator sees them.

    Reads `env.graph_fqn` directly, the same published table `status_rows`
    enriches against -- so, unlike `list_rows` (always the DEV staging table),
    a UAT/PRD read reflects whatever was actually deployed there, not DEV's
    current promotion flags. Scoped by the same promotion filter the
    orchestrator applies, so "in the graph" matches this environment's reality.
    """
    rows = query(
        f"""
        SELECT Process, Dependency, readyForUAT, readyForProd, isStoredPro,
               RunTimes, RequiresHashing, isGold, WarehouseName, WorkspacePrefix,
               NeedsTimestamp, isActive
        FROM {env.graph_fqn}
        {_promotion_filter(env)}
        ORDER BY Process, Dependency
        """,
        server=sql_endpoint_for(env),
        database=env.warehouse,
    )
    return [_to_bools(r) for r in rows]


# What the cross-environment diff compares: a row's identity plus every field
# that changes what the orchestrator does with it. The audit columns are left out
# deliberately -- LastModifiedDate and ModifiedBy differ between environments as a
# matter of course, because each table was written at a different time by a
# different deployment, and reporting that as drift would bury the real differences.
DIFF_COLUMNS = (
    "readyForUAT",
    "readyForProd",
    "isStoredPro",
    "RunTimes",
    "RequiresHashing",
    "isGold",
    "WarehouseName",
    "WorkspacePrefix",
    "NeedsTimestamp",
    "lookbackRequired",
    "isActive",
)


def graph_contents(env=None) -> list[dict]:
    """Every row in this environment's dependency graph table, unfiltered.

    Deliberately not graph_rows(): that applies the promotion filter, so it
    answers "what does this environment run". Comparing table contents has to
    answer "what is actually stored here" instead -- a row that exists in UAT
    with readyForUAT switched off is precisely the sort of difference worth
    seeing, and the filter would hide it.

    Columns absent from this environment's table are omitted rather than
    defaulted, so the diff can tell "this environment says 0" apart from "this
    environment has no such column" instead of inventing a difference.
    """
    env = _env(env)
    available = graph_columns(env)
    columns = ["Process", "Dependency"] + [
        c for c in DIFF_COLUMNS if c in available
    ]
    rows = query(
        f"SELECT {', '.join(columns)} FROM {env.graph_fqn}", **_at(env)
    )
    return [_to_bools(r) for r in rows]


def status_rows(env) -> list[dict]:
    """Read every execution-status row for `env`, enriched from its graph."""
    rows = query(
        f"""
        SELECT s.Process, s.Status, s.LastRunTime, s.LastSuccess, s.RunInstanceId,
               s.LastCheckedTime, s.RetryCount,
               CASE WHEN g.Process IS NULL THEN 0 ELSE 1 END AS inGraph,
               g.readyForUAT, g.readyForProd, g.isActive, g.isStoredPro, g.isGold
        FROM {env.status_fqn} s
        LEFT JOIN ({_graph_aggregate(env)}) g
          ON LOWER(LTRIM(RTRIM(g.Process))) = LOWER(LTRIM(RTRIM(s.Process)))
        """,
        server=sql_endpoint_for(env),
        database=env.warehouse,
    )

    now = _now()
    for row in rows:
        row["inGraph"] = bool(row["inGraph"])
        for flag in ("readyForUAT", "readyForProd", "isActive", "isStoredPro", "isGold"):
            row[flag] = None if row[flag] is None else bool(row[flag])

        success, run = row.get("LastSuccess"), row.get("LastRunTime")
        row["daysSinceSuccess"] = (now - success).days if success else None
        row["hoursSinceRun"] = int((now - run).total_seconds() // 3600) if run else None

    return rows


def status_for(env, process: str) -> dict | None:
    """One status row with the graph flags needed to resolve its pipeline."""
    return query_one(
        f"""
        SELECT s.Process, s.Status, s.RunInstanceId, s.LastRunTime,
               MAX(CAST(g.isStoredPro AS int)) AS isStoredPro,
               MAX(CAST(g.isGold AS int))      AS isGold
        FROM {env.status_fqn} s
        LEFT JOIN {env.graph_fqn} g
          ON LOWER(LTRIM(RTRIM(g.Process))) = LOWER(LTRIM(RTRIM(s.Process)))
        WHERE LOWER(LTRIM(RTRIM(s.Process))) = ?
        GROUP BY s.Process, s.Status, s.RunInstanceId, s.LastRunTime
        """,
        process.strip().lower(),
        server=sql_endpoint_for(env),
        database=env.warehouse,
    )


def last_failure_log(env, process: str) -> dict | None:
    """The most recent logged failure message for a process.

    Fabric only retains job instances for a limited window, so the API cannot
    explain an outage that started months ago. The orchestrator's own log table
    keeps the message it captured at the time, which is the only record left for
    those. Always labelled as coming from the log, never mixed with live API text.
    """
    return query_one(
        f"""
        SELECT TOP 1 timestamp, process, status, message, run_id
        FROM {env.logs_fqn}
        WHERE LOWER(LTRIM(RTRIM(process))) = ?
          AND status = 'Failed'
          AND message IS NOT NULL
        ORDER BY timestamp DESC
        """,
        process.strip().lower(),
        server=sql_endpoint_for(env),
        database=env.warehouse,
    )


def untracked_processes(env) -> list[str]:
    """Processes this environment should run but has no status row for.

    Scoped by the promotion filter, so in UAT this means "promoted to UAT but
    never tracked" rather than counting rows UAT would never run anyway.
    """
    rows = query(
        f"""
        SELECT DISTINCT g.Process
        FROM ({_graph_aggregate(env)}) g
        WHERE NOT EXISTS (
            SELECT 1 FROM {env.status_fqn} s
            WHERE LOWER(LTRIM(RTRIM(s.Process))) = LOWER(LTRIM(RTRIM(g.Process)))
        )
        ORDER BY g.Process
        """,
        server=sql_endpoint_for(env),
        database=env.warehouse,
    )
    return [r["Process"] for r in rows]


class RetryResetError(RuntimeError):
    """Refused: this environment's retry count cannot be reset."""


def status_writable(env) -> bool:
    """Whether `env`'s execution-status rows can be written at all.

    A capability of the table, not a permission of the caller: it has to live in
    the warehouse rather than a lakehouse, because a lakehouse SQL analytics
    endpoint is read-only however the statement is phrased. Nothing is ruled out
    by this today -- all four environments' status tables are warehouse-resident.

    Who may use it is a separate question, answered by roles.require_admin --
    DEV for anyone, elsewhere only a production admin. Same split as
    Environment.writable and the dependency graph.
    """
    return not env.lakehouse


def reset_retry_count(env, process: str) -> int:
    """Zero one process's RetryCount, so the orchestrator will re-attempt it.

    The one write dg_tool makes to a table it does not own, so it is kept as
    narrow as it can be: one named process, one column, no other field touched.
    Status and the timestamps are left exactly as the orchestrator wrote them.

    ProcessExecutionStatus has no surrogate key, so a Process matching more than
    one row is refused rather than updated -- the same rule s2t.py applies to its
    natural-key writes. Returns the previous RetryCount.
    """
    if not status_writable(env):
        raise RetryResetError(
            f"{env.label}'s execution-status table cannot be written from here: "
            f"it is read from {env.status_fqn}, a lakehouse table whose SQL "
            "endpoint is read-only however the statement is phrased."
        )

    matches = query(
        f"""
        SELECT Process, RetryCount FROM {env.status_fqn}
        WHERE LOWER(LTRIM(RTRIM(Process))) = ?
        """,
        process.strip().lower(),
        **_at(env),
    )
    if not matches:
        raise RetryResetError(f"No execution-status row for '{process}' in {env.label}.")
    if len(matches) > 1:
        raise RetryResetError(
            f"'{process}' has {len(matches)} execution-status rows in {env.label}; "
            "refusing to reset until the duplicates are sorted out."
        )

    execute(
        f"""
        UPDATE {env.status_fqn} SET RetryCount = 0
        WHERE LOWER(LTRIM(RTRIM(Process))) = ?
        """,
        process.strip().lower(),
        **_at(env),
    )
    return matches[0]["RetryCount"] or 0
