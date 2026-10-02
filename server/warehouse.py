"""Thin pyodbc layer over the Fabric warehouse.

Every statement goes through query()/execute() with `?` parameter markers -- no
SQL is ever assembled from user input by string concatenation.

Connections are thread-local because pyodbc connections are not thread-safe and
FastAPI dispatches sync endpoints onto a worker threadpool. A dropped or expired
connection is transparently reopened once, which matters here because Fabric
closes idle sessions and access tokens expire roughly hourly.
"""
from __future__ import annotations

import logging
import struct
import threading

import pyodbc

from config import CONFIG
from fabric_auth import SQL_SCOPE, get_token

log = logging.getLogger("dg_tool.warehouse")

# ODBC connection attribute for handing an AAD access token to the driver.
SQL_COPT_SS_ACCESS_TOKEN = 1256

_local = threading.local()


class MissingOdbcDriver(RuntimeError):
    """No usable SQL Server ODBC driver is installed on this machine."""


# Drivers that support AAD access-token auth via SQL_COPT_SS_ACCESS_TOKEN, best
# first. 18 is preferred, but 17 works for everything dg_tool does, so a machine
# with only 17 should just work rather than failing with IM002.
_PREFERRED_DRIVERS = (
    "ODBC Driver 18 for SQL Server",
    "ODBC Driver 17 for SQL Server",
    "ODBC Driver 13.1 for SQL Server",
)

_driver: str | None = None


def resolve_driver() -> str:
    """The ODBC driver to connect through, chosen from what is installed.

    Resolved once per process. An explicit `odbc_driver` in config.json wins if it
    is actually present; otherwise the newest supported driver is used.
    """
    global _driver
    if _driver is not None:
        return _driver

    available = list(pyodbc.drivers())

    if CONFIG.odbc_driver:
        if CONFIG.odbc_driver in available:
            _driver = CONFIG.odbc_driver
            return _driver
        log.warning(
            "Configured odbc_driver %r is not installed; falling back to auto-detect.",
            CONFIG.odbc_driver,
        )

    for candidate in _PREFERRED_DRIVERS:
        if candidate in available:
            if candidate != _PREFERRED_DRIVERS[0]:
                log.warning(
                    "%s not found; using %s instead.", _PREFERRED_DRIVERS[0], candidate
                )
            _driver = candidate
            return _driver

    # Naming what *was* found is what distinguishes "nothing installed" from
    # "only the 32-bit driver is installed", which produce the same IM002 error.
    found = ", ".join(available) if available else "none at all"
    raise MissingOdbcDriver(
        "No supported SQL Server ODBC driver is installed, so dg_tool cannot reach "
        f"the warehouse.\n\nODBC drivers this machine reports: {found}.\n\n"
        "Install the Microsoft ODBC Driver 18 for SQL Server (x64) from "
        "https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server "
        "and restart dg_tool.\n\n"
        "If you believe it is already installed, it is probably the 32-bit build: "
        "dg_tool runs 64-bit Python and can only use the x64 driver. Check "
        '"ODBC Data Sources (64-bit)" in Windows for a "SQL Server" driver entry.'
    )


def resolve_driver_error() -> MissingOdbcDriver:
    """The MissingOdbcDriver explanation, for when a connection fails with IM002.

    The driver resolved at start-up but the driver manager cannot load it now —
    almost always an architecture mismatch (a 32-bit driver against 64-bit Python),
    which reports the same IM002 as having no driver at all.
    """
    available = ", ".join(pyodbc.drivers()) or "none at all"
    return MissingOdbcDriver(
        "Windows could not load a SQL Server ODBC driver, so dg_tool cannot reach the "
        f"warehouse.\n\nODBC drivers this machine reports: {available}.\n\n"
        "Install the Microsoft ODBC Driver 18 for SQL Server — the **x64** build — from "
        "https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server "
        "and restart dg_tool.\n\n"
        "If a driver is listed above, it is very likely the 32-bit build: dg_tool runs "
        "64-bit Python and can only use the x64 driver."
    )


def _connect(server: str, database: str) -> pyodbc.Connection:
    driver = resolve_driver()
    token = get_token(SQL_SCOPE).encode("UTF-16-LE")
    token_struct = struct.pack(f"<I{len(token)}s", len(token), token)

    conn_str = (
        f"Driver={{{driver}}};"
        f"Server={server};"
        f"Database={database};"
        "Encrypt=yes;"
        "TrustServerCertificate=no;"
        "Connection Timeout=60;"
    )
    conn = pyodbc.connect(
        conn_str, attrs_before={SQL_COPT_SS_ACCESS_TOKEN: token_struct}
    )
    conn.autocommit = True
    return conn


def _target(server: str | None, database: str | None) -> tuple[str, str]:
    """Default to the editable DEV warehouse when no target is given."""
    return server or CONFIG.sql_server, database or CONFIG.warehouse


def _connections() -> dict[tuple[str, str], pyodbc.Connection]:
    """Thread-local connections, one per (server, database).

    Keyed rather than singular because the Health tab reads a different workspace
    per environment, and each needs its own session. Reusing one connection and
    switching database is not an option: the token and the endpoint differ too.
    """
    pool = getattr(_local, "pool", None)
    if pool is None:
        pool = _local.pool = {}
    return pool


def _get_conn(server: str, database: str) -> pyodbc.Connection:
    pool = _connections()
    key = (server, database)
    conn = pool.get(key)
    if conn is None:
        conn = pool[key] = _connect(server, database)
    return conn


def _drop_conn(server: str, database: str) -> None:
    conn = _connections().pop((server, database), None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass


def _input_sizes(params: tuple) -> list | None:
    """Declare every string parameter as nvarchar(max).

    Left to itself, pyodbc binds a str inline as nvarchar(N) up to 4000 bytes and
    switches to SQL_WLONGVARCHAR -- i.e. `ntext` -- above that. Every varchar
    column in this warehouse carries a UTF-8 collation
    (Latin1_General_100_BIN2_UTF8), and SQL Server refuses to collate a legacy LOB
    type under one:

        Cannot convert to text/ntext or collate to 'Latin1_General_100_BIN2_UTF8'
        because these legacy LOB types do not support UTF-8 or UTF-16 encodings.

    So any write carrying a long value failed outright -- the S2T join_logic and
    filter_logic columns are varchar(max) and routinely run past the limit.
    SQL_WVARCHAR with size 0 means nvarchar(max), which is the type the server
    asks for and collates correctly.

    Applied to every string rather than only the long ones deliberately. The
    cutoff is 2000 characters today only because pyodbc encodes UTF-16LE at two
    bytes a character, so any threshold here would encode a guess about pyodbc's
    internals that rots silently if its encoding ever changes -- which is exactly
    how the first attempt at this got it wrong. Declaring the type outright cannot
    drift. Equality, LIKE and multi-column key lookups were all checked to still
    match under it, and at this warehouse's size the extra streaming costs nothing.

    `None` entries leave pyodbc's own choice alone, so datetimes, bools, ints and
    NULLs bind exactly as they did before.
    """
    sizes = [
        (pyodbc.SQL_WVARCHAR, 0, 0) if isinstance(param, str) else None
        for param in params
    ]
    return sizes if any(size is not None for size in sizes) else None


def _run(sql: str, params: tuple, want_rows: bool, server=None, database=None):
    """Execute `sql`, retrying once on a connection-level failure."""
    server, database = _target(server, database)
    for attempt in (1, 2):
        try:
            cursor = _get_conn(server, database).cursor()
            sizes = _input_sizes(params)
            if sizes:
                cursor.setinputsizes(sizes)
            cursor.execute(sql, params) if params else cursor.execute(sql)
            if want_rows:
                if cursor.description is None:
                    return []
                columns = [c[0] for c in cursor.description]
                return [dict(zip(columns, row)) for row in cursor.fetchall()]
            return cursor.rowcount
        except (pyodbc.OperationalError, pyodbc.InterfaceError) as exc:
            _drop_conn(server, database)

            # IM002 means the driver named in the connection string is not
            # installed. Retrying cannot fix that, and the raw message ("Data
            # source name not found and no default driver specified") tells a
            # teammate nothing, so fail fast with the actionable version.
            if "IM002" in str(exc):
                raise resolve_driver_error() from exc

            if attempt == 2:
                raise
            # Stale session or expired token: the second attempt builds a fresh
            # connection with a fresh token.
            log.warning("Reconnecting to %s/%s after: %s",
                        server, database, exc)


def query(sql: str, *params, server=None, database=None) -> list[dict]:
    """Run a SELECT and return rows as dicts."""
    return _run(sql, params, want_rows=True, server=server, database=database)


def query_one(sql: str, *params, server=None, database=None) -> dict | None:
    rows = query(sql, *params, server=server, database=database)
    return rows[0] if rows else None


def execute(sql: str, *params, server=None, database=None) -> int:
    """Run a DML/DDL statement, against the editable DEV warehouse by default.

    This used to take no target at all, so that "dg_tool only writes to DEV" was
    structural rather than a rule every caller had to remember. Editing the
    dependency graph in QA/UAT needs a target, so the guarantee moved up a level
    instead of disappearing: queries.py resolves the target from an Environment
    and refuses one that is not `Environment.writable` (a lakehouse SQL endpoint
    is read-only regardless), and main.py requires an admin for anything but DEV.
    Omitting both arguments still means DEV, so every existing caller is unchanged.
    """
    return _run(sql, params, want_rows=False, server=server, database=database)


def ping(server=None, database=None) -> dict:
    """Confirm connectivity and report the identity the warehouse sees."""
    return (
        query_one(
            "SELECT DB_NAME() AS warehouse, SUSER_SNAME() AS login_name",
            server=server,
            database=database,
        )
        or {}
    )
