"""CRUD over the source-to-target spec in WH_HDX_DE_Silver.HDX.

Two tables drive stored-proc and table generation:

* `HDX.Table_Metadata` — one row per (table_name, medallion_layer): the load method
  and the join / filter / base-table SQL.
* `HDX.Table_Columns` — one row per (table_name, column_name, medallion_layer): the
  column spec, its transformation and its mapping/dev status.

Unlike dependencygraph, these live in the **warehouse**, which accepts DML — so this
is real CRUD with no staging table and no publish step.

## Row addressing

Neither table has a surrogate key, so rows are addressed by natural key. That key is
**not unique in the current data** (three duplicates as of 2026-08-14), and adding an
id column would mean altering a shared table other tooling reads. So instead every
write first counts the rows its key matches and refuses to proceed unless exactly
one does. An ambiguous key is reported, not guessed at -- silently updating one of
two identical-looking rows is the worst available outcome.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pyodbc

import endpoints
from config import CONFIG
from endpoints import EndpointUnavailable
from warehouse import execute, query, query_one

METADATA = "HDX.Table_Metadata"
COLUMNS = "HDX.Table_Columns"

# Editable metadata fields, in form order. table_name and medallion_layer are the
# key and are handled separately.
METADATA_FIELDS = (
    "load_method",
    "procedure_name",
    "workflow",
    "base_table_logic",
    "join_logic",
    "filter_logic",
    "table_description",
)

# Editable column fields, in grid order.
COLUMN_FIELDS = (
    "column_ordinal",
    "data_type",
    "not_null",
    "field_category",
    "transformation",
    "source_table_name",
    "source_column_name",
    "mapping_status",
    "dev_status",
    "change_requiring_update",
    "business_description",
)

_BOOL_COLUMN_FIELDS = ("not_null", "change_requiring_update")


class AmbiguousKey(RuntimeError):
    """The natural key matches more than one row, so a write would be a guess."""


class NotFound(RuntimeError):
    """The natural key matches no row."""


class DuplicateKey(RuntimeError):
    """A create would collide with an existing row."""


class StaleWrite(RuntimeError):
    """The row changed after the client read it, so saving would silently clobber.

    HDX.* is a shared spec table written by colleagues and by HDX_Integration, and
    an update here rewrites every field of the row. Without this check, loading a
    mapping, waiting, and saving would overwrite whatever someone else changed in
    between -- the classic last-write-wins data loss, and invisible to both people.
    """

    def __init__(self, message: str, who: str | None, when: str | None):
        super().__init__(message)
        self.who = who
        self.when = when


def _stamp(value: datetime | None) -> str | None:
    """The comparison form of last_modified.

    Both columns are datetime2(6), which is exactly Python's microsecond
    precision, so a value read twice formats identically and this comparison has
    no truncation risk.
    """
    return value.isoformat() if value is not None else None


def _check_fresh(current: dict, expected: str | None, label: str) -> None:
    """Refuse the write if the row moved since the client read it.

    `expected` of None means the caller did not supply a version, which is treated
    as an explicit override -- useful for scripts, and always sent by the UI.
    """
    if expected is None:
        return

    actual = _stamp(current.get("last_modified"))
    # Normalise "" to None so a row that has never been stamped compares equal to
    # a client that round-tripped a null.
    if (expected or None) == actual:
        return

    who = current.get("last_modified_by") or "someone else"
    when = actual or "an unknown time"
    raise StaleWrite(
        f"{label} was changed by {who} at {when}, after you loaded it. "
        "Your save was not applied — reload to see their change, then redo yours.",
        who=who,
        when=actual,
    )


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _norm(value: str | None) -> str | None:
    """Trim, and treat blank as NULL.

    The existing data has both NULL and '' in the same nullable columns (374 blank
    field_category values alongside 384 NULLs, for instance). New writes settle on
    NULL so that "unset" has one representation going forward, without rewriting
    what is already there.
    """
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# --------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------


def targets() -> list[dict]:
    """Medallion layers present, with how many mappings each has."""
    return query(
        f"""
        SELECT medallion_layer AS target, COUNT(*) AS mappings
        FROM {METADATA}
        WHERE medallion_layer IS NOT NULL AND LTRIM(RTRIM(medallion_layer)) <> ''
        GROUP BY medallion_layer
        ORDER BY COUNT(*) DESC
        """
    )


def tables(target: str) -> list[dict]:
    """Tables mapped in one layer, with column counts and duplicate flags.

    Column counts come from a LEFT JOIN so a mapping with no columns still appears
    -- six currently have none, and hiding them would make them uneditable.
    """
    return query(
        f"""
        SELECT m.table_name,
               COUNT(c.column_name)     AS columns,
               m.load_method,
               m.workflow,
               m.procedure_name,
               m.last_modified
        FROM {METADATA} m
        LEFT JOIN {COLUMNS} c
               ON c.table_name = m.table_name
              AND c.medallion_layer = m.medallion_layer
        WHERE m.medallion_layer = ?
        GROUP BY m.table_name, m.load_method, m.workflow, m.procedure_name,
                 m.last_modified
        ORDER BY m.table_name
        """,
        target,
    )


def orphan_tables(target: str) -> list[dict]:
    """(table, layer) groups with columns but no metadata row.

    Surfaced rather than hidden: eight such groups exist, one with 67 columns, and
    they are invisible to any UI that lists tables from Table_Metadata alone.
    """
    return query(
        f"""
        SELECT c.table_name, COUNT(*) AS columns
        FROM {COLUMNS} c
        WHERE c.medallion_layer = ?
          AND NOT EXISTS (
              SELECT 1 FROM {METADATA} m
              WHERE m.table_name = c.table_name
                AND m.medallion_layer = c.medallion_layer
          )
        GROUP BY c.table_name
        ORDER BY c.table_name
        """,
        target,
    )


_SILVER = "Silver"


def _field_category_is(value: str | None, prefix: str) -> bool:
    """Loose match for a `field_category` value, which is a suggestion, not an enum.

    Existing data has case variants ("Primary Key" / "Primary key"), so this
    compares case-insensitively rather than requiring an exact canonical string.
    """
    return bool(value) and value.strip().lower().startswith(prefix)


class CatalogueUnreadable(RuntimeError):
    """An environment's table list could not be read, so existence is unknown."""


def live_tables(env) -> set[str]:
    """Every table and view that actually exists in `env`'s Silver warehouse.

    Returned lowercased as `schema.table`, the form `Table_Metadata.table_name`
    already takes, so the spec and the live catalogue intersect directly.

    One catalogue query rather than the probe-per-table validate_against_ddl
    does: the ERD asks about every Silver table at once, and 136 round trips to
    PRD would take minutes. Views count as existing -- "View" is a real
    `load_method` in the spec, and a view is a table as far as a diagram cares.
    """
    database = CONFIG.warehouse_for_layer("silver")
    # An unresolvable endpoint raises EndpointUnavailable, which main.py already
    # turns into a 502 naming the reason.
    server = endpoints.sql_endpoint_for(env)

    try:
        rows = query(
            """
            SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name
            FROM INFORMATION_SCHEMA.TABLES
            """,
            server=server,
            database=database,
        )
    except pyodbc.Error as exc:
        if _is_access_denied(exc):
            raise CatalogueUnreadable(
                f"{env.label} refused the table list for {database}: this account can "
                "read the HDX spec but not that warehouse's catalogue, so dg_tool "
                "cannot tell which tables exist there. Pick another environment, or "
                "'Full spec' to see every mapped table."
            ) from exc
        raise

    return {f"{row['schema_name']}.{row['table_name']}".lower() for row in rows}


def erd(env=None) -> dict:
    """Tables and key-based relationships for the ERD tab, Silver layer only.

    There is no foreign_key_target column in the spec -- `field_category` only
    says a column is a "Primary Key" or "Foreign Key", not which table the
    foreign key points to. So a relationship is inferred by name: a "Foreign
    Key" column is linked to whichever table declares a "Primary Key" column of
    the same name (e.g. `Encounter.EHR_Encounter.patient_id` links to
    `Patient.EHR_Patient.patient_id`). A name with no matching primary key stays
    an unlinked foreign key rather than a guessed relationship.

    With `env`, the diagram is cut to the tables that really exist in that
    environment's warehouse; the spec covers tables that are only planned, and a
    diagram of tables nobody can query is misleading. `None` keeps the whole
    spec.
    """
    columns = query(
        f"""
        SELECT table_name, column_name, data_type, not_null, field_category,
               column_ordinal, last_modified
        FROM {COLUMNS}
        WHERE medallion_layer = ?
        ORDER BY table_name, column_ordinal
        """,
        _SILVER,
    )

    metadata = query(
        f"""
        SELECT table_name, table_description, last_modified
        FROM {METADATA}
        WHERE medallion_layer = ?
        """,
        _SILVER,
    )
    meta_by_table = {row["table_name"]: row for row in metadata}

    columns_by_table: dict[str, list[dict]] = {}
    for row in columns:
        columns_by_table.setdefault(row["table_name"], []).append(row)

    # Every primary-key column name -> the table(s) that declare it, so a foreign
    # key can be matched to its target by name alone.
    primary_keys: dict[str, list[tuple[str, str]]] = {}
    for row in columns:
        if _field_category_is(row["field_category"], "primary"):
            norm = row["column_name"].strip().lower()
            primary_keys.setdefault(norm, []).append((row["table_name"], row["column_name"]))

    existing = live_tables(env) if env is not None else None

    tables = []
    relationships = []
    kept = set()
    hidden = 0

    for table_name in sorted(set(columns_by_table) | set(meta_by_table)):
        # Mapped but not built yet in this environment.
        if existing is not None and table_name.lower() not in existing:
            hidden += 1
            continue
        kept.add(table_name)
        schema_name, short_name = _split_table(table_name)
        meta = meta_by_table.get(table_name, {})
        cols = columns_by_table.get(table_name, [])

        table_columns = []
        for c in cols:
            is_fk = _field_category_is(c["field_category"], "foreign")
            target = None
            if is_fk:
                norm = c["column_name"].strip().lower()
                for target_table, target_column in primary_keys.get(norm, []):
                    # A column marked both PK and FK -- an identifying key, like
                    # Encounter_Diagnosis.encounter_id -- matches its own primary
                    # key entry. That is the same column seen twice, not a
                    # relationship, and drawing it puts a loop on the box.
                    if target_table == table_name and target_column == c["column_name"]:
                        continue
                    target = f"{target_table}.{target_column}"
                    relationships.append({
                        "from_table": table_name,
                        "from_column": c["column_name"],
                        "to_table": target_table,
                        "to_column": target_column,
                    })

            table_columns.append({
                "column_name": c["column_name"],
                "data_type": c["data_type"] or "",
                "is_primary_key": _field_category_is(c["field_category"], "primary"),
                "is_foreign_key": is_fk,
                "foreign_key_target": target,
                "nullable": not c["not_null"],
            })

        stamps = [meta.get("last_modified")] + [c["last_modified"] for c in cols]
        stamps = [s for s in stamps if s]

        tables.append({
            "schema_name": schema_name,
            "table_name": table_name,
            "short_name": short_name,
            "column_count": len(cols),
            "description": meta.get("table_description"),
            "last_modified": max(stamps) if stamps else None,
            "columns": table_columns,
        })

    # The child side is already known to be kept -- the loop skipped the rest --
    # but the primary-key side may have been one of the dropped tables.
    relationships = [rel for rel in relationships if rel["to_table"] in kept]
    relationships.sort(key=lambda r: (r["from_table"], r["from_column"], r["to_table"], r["to_column"]))

    return {
        "tables": tables,
        "relationships": relationships,
        "hidden": hidden,
        "env": env.key if env is not None else None,
    }


# source_table_name values that are not tables. `(system)` is by far the most
# common (750 columns): it marks audit columns the load stamps itself, and the
# other bracketed placeholders mark columns computed rather than read. They are a
# real part of the spec, but listing them as tables a table is built from would
# be wrong -- so the "curated from" list drops them.
#
# Only *wholly* bracketed values are dropped: plenty of genuine sources carry a
# trailing qualifier, like `Customer.Location (PG)`, and must survive.
_NOT_A_SOURCE_TABLE = {"n/a", "na", "none", "(multiple)"}


def _is_source_table(name: str) -> bool:
    text = name.strip()
    if not text or text.lower() in _NOT_A_SOURCE_TABLE:
        return False
    return not (text.startswith("(") and text.endswith(")"))


def procedure_tables() -> list[dict]:
    """Every stored proc in the spec, the table it builds, and that table's sources.

    Read whole rather than per-table: the Lineage diagram labels every stored-proc
    node at once, and the dependency graph only knows procedure names, so it needs
    the entire procedure -> table mapping in one go.

    A procedure appears once per layer it is mapped in -- a handful are mapped in
    both Gold and PostgreSQL -- because each layer declares its own sources.
    """
    metadata = query(
        f"""
        SELECT procedure_name, table_name, medallion_layer
        FROM {METADATA}
        WHERE procedure_name IS NOT NULL AND LTRIM(RTRIM(procedure_name)) <> ''
          AND table_name IS NOT NULL AND LTRIM(RTRIM(table_name)) <> ''
        """
    )

    sources = query(
        f"""
        SELECT table_name, medallion_layer, source_table_name, COUNT(*) AS columns
        FROM {COLUMNS}
        WHERE source_table_name IS NOT NULL AND LTRIM(RTRIM(source_table_name)) <> ''
        GROUP BY table_name, medallion_layer, source_table_name
        """
    )

    by_table: dict[tuple[str, str], list[dict]] = {}
    for row in sources:
        name = row["source_table_name"].strip()
        if not _is_source_table(name):
            continue
        key = (row["table_name"], row["medallion_layer"] or "")
        by_table.setdefault(key, []).append(
            {"table_name": name, "columns": row["columns"]}
        )

    # Most-mapped source first, so the base table a proc reads from leads and the
    # lookups it joins in for one or two columns follow.
    for entries in by_table.values():
        entries.sort(key=lambda e: (-e["columns"], e["table_name"].lower()))

    result = []
    for row in metadata:
        layer = row["medallion_layer"] or ""
        result.append(
            {
                "procedure_name": row["procedure_name"].strip(),
                "table_name": row["table_name"].strip(),
                "medallion_layer": layer,
                "sources": by_table.get((row["table_name"], layer), []),
            }
        )
    return result


def metadata_for(table: str, target: str) -> dict | None:
    return query_one(
        f"""
        SELECT table_name, medallion_layer, load_method, join_logic, filter_logic,
               base_table_logic, table_description, procedure_name, workflow,
               last_modified, last_modified_by
        FROM {METADATA}
        WHERE table_name = ? AND medallion_layer = ?
        """,
        table,
        target,
    )


def columns_for(table: str, target: str) -> list[dict]:
    rows = query(
        f"""
        SELECT table_name, column_name, medallion_layer, data_type, not_null,
               transformation, field_category, column_ordinal, business_description,
               source_table_name, source_column_name, mapping_status,
               change_requiring_update, dev_status, last_modified, last_modified_by
        FROM {COLUMNS}
        WHERE table_name = ? AND medallion_layer = ?
        ORDER BY CASE WHEN column_ordinal IS NULL THEN 1 ELSE 0 END,
                 column_ordinal, column_name
        """,
        table,
        target,
    )
    for row in rows:
        for field in _BOOL_COLUMN_FIELDS:
            row[field] = None if row[field] is None else bool(row[field])
    return rows


class UnsupportedLayer(ValueError):
    """No live warehouse is configured for this medallion layer (e.g. PostgreSQL)."""


# Environments compared by "Validate against DDL". An environment with no
# workspace_id configured yet reports access="unavailable" rather than being
# silently dropped, so a bare install still shows all four with a clear reason.
VALIDATION_ENVIRONMENTS = ("dev", "qa", "uat", "prd")


def _split_table(table: str) -> tuple[str, str]:
    """`Schema.Table` -> `("Schema", "Table")`; an unqualified name defaults to dbo."""
    schema, sep, name = table.partition(".")
    return (schema, name) if sep else ("dbo", schema)


def _live_columns(table: str, database: str, server: str) -> list[dict]:
    """This table's actual columns in one environment's warehouse, from INFORMATION_SCHEMA.

    Empty means the table does not exist there yet -- not the same as it existing
    with zero columns, which SQL Server tables cannot do.
    """
    schema, name = _split_table(table)
    return query(
        """
        SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
               CHARACTER_MAXIMUM_LENGTH AS char_len, NUMERIC_PRECISION AS num_precision,
               NUMERIC_SCALE AS num_scale, DATETIME_PRECISION AS dt_precision,
               IS_NULLABLE AS is_nullable
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
        """,
        schema,
        name,
        server=server,
        database=database,
    )


# Types whose SQL Server precision/length/scale actually matters for a mapping
# comparison. Everything else (int, bit, date, ...) is fully described by name.
_SIZED_TYPES = {"varchar", "nvarchar", "char", "nchar", "varbinary", "binary"}
_SCALED_TYPES = {"decimal", "numeric"}
_TIMED_TYPES = {"datetime2", "time", "datetimeoffset"}


def _ddl_type(row: dict) -> str:
    """A human-readable type string from an INFORMATION_SCHEMA.COLUMNS row.

    Matches the shorthand people actually type into Table_Columns.data_type, e.g.
    `varchar(50)`, `decimal(18,2)`, so it can be compared against that field.
    """
    base = row["data_type"]
    if base in _SIZED_TYPES:
        length = row["char_len"]
        return f"{base}(max)" if length == -1 else f"{base}({length})"
    if base in _SCALED_TYPES:
        return f"{base}({row['num_precision']},{row['num_scale']})"
    if base in _TIMED_TYPES and row["dt_precision"] is not None:
        return f"{base}({row['dt_precision']})"
    return base


def _normalize_type(value: str) -> str:
    return "".join(value.lower().split())


# Substrings SQL Server's driver puts in the error text for an authorization
# failure, whether it happens at login (no CONNECT/firewall access) or at the
# statement (CONNECT works but SELECT on INFORMATION_SCHEMA is denied). Matched
# case-insensitively, this is deliberately broad -- a false positive here is a
# person greyed out with a misleading label, but a false negative is a raw ODBC
# stack trace, which is worse.
_ACCESS_DENIED_MARKERS = (
    "permission",
    "denied",
    "login failed",
    "not allowed",
    "not authorized",
    "18456",
)


def _is_access_denied(exc: pyodbc.Error) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in _ACCESS_DENIED_MARKERS)


def _probe_env(table: str, database: str, env) -> dict:
    """This table's live columns in one environment, or why it couldn't be read.

    Three outcomes, kept distinct because they call for different UI treatment:
    "ok" (compared normally), "unavailable" (env has no workspace_id / endpoint
    yet -- a setup gap, not a permissions problem), and "no_access" (reached the
    server but this identity can't read it). Anything else pyodbc raises (a
    genuinely broken connection, a transient network error) is left to
    propagate -- folding it into "no read access" would misreport a real outage
    as a permissions issue.
    """
    try:
        server = endpoints.sql_endpoint_for(env)
    except EndpointUnavailable:
        return {"access": "unavailable", "columns": {}, "table_found": False}

    try:
        rows = _live_columns(table, database, server)
    except pyodbc.Error as exc:
        if _is_access_denied(exc):
            return {"access": "no_access", "columns": {}, "table_found": False}
        raise
    return {
        "access": "ok",
        "columns": {r["column_name"].lower(): r for r in rows},
        "table_found": bool(rows),
    }


def _column_matches(mapped: dict | None, live: dict | None) -> bool:
    """Whether a live column fully satisfies what the mapping asserts.

    A mapping field left blank makes no assertion and cannot fail the match --
    only fields that are actually filled in are checked. A column missing from
    either side (mapped-but-not-live, or live-but-not-mapped) never matches.
    """
    if mapped is None or live is None:
        return False
    if mapped["data_type"] and _normalize_type(mapped["data_type"]) != _normalize_type(_ddl_type(live)):
        return False
    if mapped["not_null"] is not None:
        if bool(mapped["not_null"]) != (live["is_nullable"] == "NO"):
            return False
    return True


def validate_against_ddl(table: str, layer: str) -> dict:
    """Diff this table's mapping against its live shape in each environment's warehouse.

    Raises UnsupportedLayer for layers with no configured warehouse (PostgreSQL).
    """
    database = CONFIG.warehouse_for_layer(layer)
    if database is None:
        raise UnsupportedLayer(
            f"dg_tool has no live warehouse configured for the {layer!r} layer, "
            "so it cannot validate against DDL for this table."
        )

    mapped_rows = columns_for(table, layer)
    mapped = {c["column_name"].lower(): c for c in mapped_rows}

    probes: dict[str, dict] = {}
    for env_key in VALIDATION_ENVIRONMENTS:
        probes[env_key] = _probe_env(table, database, CONFIG.environment(env_key))

    # Mapped columns first, in their mapping order, then anything live-only.
    order = [c["column_name"] for c in mapped_rows]
    seen = {name.lower() for name in order}
    extra = sorted(
        {
            row["column_name"]
            for probe in probes.values()
            for key, row in probe["columns"].items()
            if key not in seen
        },
        key=str.lower,
    )
    order += extra

    columns = []
    all_match = all(p["access"] == "ok" and p["table_found"] for p in probes.values())
    for name in order:
        key = name.lower()
        mcol = mapped.get(key)
        env_results = {}
        for env_key in VALIDATION_ENVIRONMENTS:
            probe = probes[env_key]
            if probe["access"] != "ok":
                env_results[env_key] = {
                    "access": probe["access"],
                    "present": False,
                    "data_type": None,
                    "not_null": None,
                    "matches": False,
                }
                continue
            live = probe["columns"].get(key)
            match = _column_matches(mcol, live)
            all_match = all_match and match
            env_results[env_key] = {
                "access": "ok",
                "present": live is not None,
                "data_type": _ddl_type(live) if live else None,
                "not_null": (live["is_nullable"] == "NO") if live else None,
                "matches": match,
            }
        columns.append(
            {
                "column_name": name,
                "mapped_data_type": mcol["data_type"] if mcol else None,
                "mapped_not_null": mcol["not_null"] if mcol else None,
                "environments": env_results,
            }
        )

    return {
        "environments": list(VALIDATION_ENVIRONMENTS),
        "access": {k: probes[k]["access"] for k in VALIDATION_ENVIRONMENTS},
        "table_found": {k: probes[k]["table_found"] for k in VALIDATION_ENVIRONMENTS},
        "columns": columns,
        "matches": all_match,
    }


def _count_metadata(table: str, target: str) -> int:
    return query_one(
        f"SELECT COUNT(*) AS n FROM {METADATA} WHERE table_name = ? AND medallion_layer = ?",
        table,
        target,
    )["n"]


def _count_column(table: str, target: str, column: str) -> int:
    return query_one(
        f"""
        SELECT COUNT(*) AS n FROM {COLUMNS}
        WHERE table_name = ? AND medallion_layer = ? AND column_name = ?
        """,
        table,
        target,
        column,
    )["n"]


def duplicates(table: str, target: str) -> dict:
    """Ambiguity in this mapping, so the UI can warn before anyone tries to edit."""
    meta = _count_metadata(table, target)
    dup_columns = query(
        f"""
        SELECT column_name, COUNT(*) AS n
        FROM {COLUMNS}
        WHERE table_name = ? AND medallion_layer = ?
        GROUP BY column_name
        HAVING COUNT(*) > 1
        """,
        table,
        target,
    )
    return {
        "metadataRows": meta,
        "duplicateColumns": [
            {"columnName": r["column_name"], "count": r["n"]} for r in dup_columns
        ],
    }


# --------------------------------------------------------------------------
# Writes -- each guards on the key matching exactly one row
# --------------------------------------------------------------------------


def _require_single_metadata(table: str, target: str) -> dict:
    """Assert the key is unambiguous, and return the row it resolves to."""
    found = _count_metadata(table, target)
    if found == 0:
        raise NotFound(f"No mapping for {table} in {target}.")
    if found > 1:
        raise AmbiguousKey(
            f"{table} / {target} matches {found} rows in Table_Metadata. "
            "dg_tool will not guess which to change — remove the duplicate first."
        )
    return metadata_for(table, target) or {}


def _require_single_column(table: str, target: str, column: str) -> dict:
    found = _count_column(table, target, column)
    if found == 0:
        raise NotFound(f"No column {column} on {table} in {target}.")
    if found > 1:
        raise AmbiguousKey(
            f"{table}.{column} / {target} matches {found} rows in Table_Columns. "
            "dg_tool will not guess which to change — remove the duplicate first."
        )
    return (
        query_one(
            f"""
            SELECT last_modified, last_modified_by FROM {COLUMNS}
            WHERE table_name = ? AND medallion_layer = ? AND column_name = ?
            """,
            table,
            target,
            column,
        )
        or {}
    )


def create_metadata(table: str, target: str, values: dict, author: str) -> None:
    if _count_metadata(table, target):
        raise DuplicateKey(f"{table} is already mapped in {target}.")

    execute(
        f"""
        INSERT INTO {METADATA} (
            table_name, medallion_layer, load_method, join_logic, filter_logic,
            base_table_logic, table_description, procedure_name, workflow,
            last_modified, last_modified_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """,
        table,
        target,
        _norm(values.get("load_method")),
        _norm(values.get("join_logic")),
        _norm(values.get("filter_logic")),
        _norm(values.get("base_table_logic")),
        _norm(values.get("table_description")),
        _norm(values.get("procedure_name")),
        _norm(values.get("workflow")),
        _now(),
        author,
    )


def update_metadata(
    table: str, target: str, values: dict, author: str, expected: str | None = None
) -> None:
    current = _require_single_metadata(table, target)
    _check_fresh(current, expected, f"{table} / {target}")
    execute(
        f"""
        UPDATE {METADATA} SET
            load_method = ?, join_logic = ?, filter_logic = ?, base_table_logic = ?,
            table_description = ?, procedure_name = ?, workflow = ?,
            last_modified = ?, last_modified_by = ?
        WHERE table_name = ? AND medallion_layer = ?
        """,
        _norm(values.get("load_method")),
        _norm(values.get("join_logic")),
        _norm(values.get("filter_logic")),
        _norm(values.get("base_table_logic")),
        _norm(values.get("table_description")),
        _norm(values.get("procedure_name")),
        _norm(values.get("workflow")),
        _now(),
        author,
        table,
        target,
    )


def delete_mapping(table: str, target: str, expected: str | None = None) -> dict:
    """Delete a mapping and every column under it.

    Metadata first would orphan the columns if the second statement failed, so the
    columns go first: a partial failure then leaves a metadata row with no columns,
    which the UI already shows and which is recoverable, rather than invisible
    orphan columns.
    """
    current = _require_single_metadata(table, target)
    _check_fresh(current, expected, f"{table} / {target}")
    removed_columns = execute(
        f"DELETE FROM {COLUMNS} WHERE table_name = ? AND medallion_layer = ?",
        table,
        target,
    )
    removed_metadata = execute(
        f"DELETE FROM {METADATA} WHERE table_name = ? AND medallion_layer = ?",
        table,
        target,
    )
    return {"columns": removed_columns, "metadata": removed_metadata}


def create_column(table: str, target: str, column: str, values: dict, author: str) -> None:
    if _count_column(table, target, column):
        raise DuplicateKey(f"{column} already exists on {table} in {target}.")

    execute(
        f"""
        INSERT INTO {COLUMNS} (
            table_name, column_name, medallion_layer, data_type, not_null,
            transformation, field_category, column_ordinal, business_description,
            source_table_name, source_column_name, mapping_status,
            change_requiring_update, dev_status, last_modified, last_modified_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        table,
        column,
        target,
        _norm(values.get("data_type")),
        values.get("not_null"),
        _norm(values.get("transformation")),
        _norm(values.get("field_category")),
        values.get("column_ordinal"),
        _norm(values.get("business_description")),
        _norm(values.get("source_table_name")),
        _norm(values.get("source_column_name")),
        _norm(values.get("mapping_status")),
        values.get("change_requiring_update"),
        _norm(values.get("dev_status")),
        _now(),
        author,
    )


def update_column(
    table: str,
    target: str,
    column: str,
    values: dict,
    author: str,
    rename_to: str | None = None,
    expected: str | None = None,
) -> str:
    """Update one column, optionally renaming it. Returns its final name."""
    current = _require_single_column(table, target, column)
    _check_fresh(current, expected, f"{table}.{column}")

    new_name = _norm(rename_to) or column
    if new_name != column and _count_column(table, target, new_name):
        raise DuplicateKey(
            f"{new_name} already exists on {table} in {target}.")

    execute(
        f"""
        UPDATE {COLUMNS} SET
            column_name = ?, data_type = ?, not_null = ?, transformation = ?,
            field_category = ?, column_ordinal = ?, business_description = ?,
            source_table_name = ?, source_column_name = ?, mapping_status = ?,
            change_requiring_update = ?, dev_status = ?,
            last_modified = ?, last_modified_by = ?
        WHERE table_name = ? AND medallion_layer = ? AND column_name = ?
        """,
        new_name,
        _norm(values.get("data_type")),
        values.get("not_null"),
        _norm(values.get("transformation")),
        _norm(values.get("field_category")),
        values.get("column_ordinal"),
        _norm(values.get("business_description")),
        _norm(values.get("source_table_name")),
        _norm(values.get("source_column_name")),
        _norm(values.get("mapping_status")),
        values.get("change_requiring_update"),
        _norm(values.get("dev_status")),
        _now(),
        author,
        table,
        target,
        column,
    )
    return new_name


def delete_column(
    table: str, target: str, column: str, expected: str | None = None
) -> int:
    current = _require_single_column(table, target, column)
    _check_fresh(current, expected, f"{table}.{column}")
    return execute(
        f"DELETE FROM {COLUMNS} WHERE table_name = ? AND medallion_layer = ? AND column_name = ?",
        table,
        target,
        column,
    )


# --------------------------------------------------------------------------
# Suggestions for the form's datalists
# --------------------------------------------------------------------------

# Canonical values offered as suggestions. Deliberately *suggestions* rather than a
# closed dropdown: the existing data holds case and wording variants
# ("Truncate and Reload" / "truncate and reload", "Primary Key" / "Primary key",
# "Done" / "Complete"), and silently rewriting someone else's row while editing an
# unrelated field would be worse than tolerating the variants.
CANONICAL = {
    "medallion_layer": ["Silver", "Gold", "PostgreSQL"],
    "load_method": ["Incremental", "Truncate and Reload", "Full", "View", "One-time load"],
    "field_category": [
        "Primary Key",
        "Foreign Key",
        "Qualitative",
        "Quantitative",
        "Dimension",
        "Flag",
        "Audit/Other",
    ],
    "mapping_status": ["Not Started", "In Progress", "Done"],
    "dev_status": ["Not Started", "In Progress", "Done"],
}


def suggestions() -> dict[str, list[str]]:
    """Canonical values, plus whatever else the data already uses.

    Existing variants are listed after the canonical ones so they remain reachable
    without being presented as the preferred spelling.
    """
    result: dict[str, list[str]] = {}

    for field, canonical in CANONICAL.items():
        table = METADATA if field in ("load_method",) else COLUMNS
        if field == "medallion_layer":
            table = METADATA
        seen = [
            r["v"]
            for r in query(
                f"""
                SELECT DISTINCT {field} AS v FROM {table}
                WHERE {field} IS NOT NULL AND LTRIM(RTRIM({field})) <> ''
                """
            )
        ]
        extra = sorted(v for v in seen if v not in canonical)
        result[field] = canonical + extra

    result["data_type"] = [
        r["v"]
        for r in query(
            f"""
            SELECT TOP 40 data_type AS v, COUNT(*) AS n FROM {COLUMNS}
            WHERE data_type IS NOT NULL AND LTRIM(RTRIM(data_type)) <> ''
            GROUP BY data_type ORDER BY COUNT(*) DESC
            """
        )
    ]
    result["workflow"] = [
        r["v"]
        for r in query(
            f"""
            SELECT DISTINCT workflow AS v FROM {METADATA}
            WHERE workflow IS NOT NULL AND LTRIM(RTRIM(workflow)) <> ''
            """
        )
    ]
    for key in result:
        result[key] = sorted(set(result[key]), key=lambda v: (
            v not in CANONICAL.get(key, []), v))
    return result
