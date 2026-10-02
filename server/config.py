"""Configuration for dg_tool.

Defaults point at the DEV environment. Override any of them with a config.json
next to this file (see config.example.json) or with DG_* environment variables --
environment wins over the file, which wins over these defaults.

Nothing here is a secret: these are Fabric object identifiers, the same ones
already present in the repo's .mcp.json. All credentials come from the
interactive device-code flow in fabric_auth.py and live only in the OS-encrypted
token cache.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, fields, replace
from pathlib import Path

_CONFIG_PATH = Path(__file__).with_name("config.json")


@dataclass(frozen=True)
class Environment:
    """One deployed environment: its own workspace, lakehouse and status table.

    The Health tab reads a different `processexecutionstatus` per environment,
    because each is a separate Fabric workspace. Editing stays in DEV, where the
    staging table lives -- nothing here provides a write path to QA/UAT/PRD.
    """

    key: str
    label: str
    # Empty means "not configured yet": the environment is listed in the UI as
    # unavailable rather than silently missing.
    workspace_id: str = ""
    sql_endpoint: str = ""
    # A warehouse in the same workspace. When `lakehouse` is set, the status/graph/
    # logs tables are read from it by three-part name; when empty they are read
    # schema-qualified straight from `warehouse`.
    #
    # The blank default is the current orchestration approach: each environment
    # keeps its own orch-schema tables in its own warehouse, the same place DEV's
    # editable orch.dependencygraph lives. All four environments are on this
    # layout now; `lakehouse` stays available for an environment not yet migrated.
    warehouse: str = "WH_HDX_DE_Silver"
    lakehouse: str = ""
    schema: str = "orch"
    status_table: str = "processexecutionstatus"
    graph_table: str = "dependencygraph"
    logs_table: str = "orchestrator_run_logs"

    # Which lakehouse to read a SQL endpoint host off when `sql_endpoint` is empty.
    # Deliberately separate from `lakehouse`: every item in a workspace shares one
    # host, so endpoint discovery has nothing to do with where the tables actually
    # live -- and conflating the two meant an environment on the orch-schema layout
    # (blank `lakehouse`) had no item left to resolve its endpoint from.
    endpoint_lakehouse: str = "LH_Orchestrator_Tables"

    # The column NB_Orchestrator filters on in this environment. None means it
    # applies no promotion filter, which is true for both DEV and QA -- only UAT
    # and PRD are gated.
    promotion_column: str | None = None

    @property
    def configured(self) -> bool:
        """A workspace id is enough.

        `sql_endpoint` is optional: when it is empty, endpoints.sql_endpoint_for()
        resolves it from the workspace's lakehouse on first use, so adding an
        environment means supplying one GUID rather than hunting a 40-character
        hostname out of the portal.
        """
        return bool(self.workspace_id)

    def fqn(self, table: str) -> str:
        """Name for a status/graph/logs table, as seen from the warehouse.

        Three-part when `lakehouse` names a separate item; schema-qualified when
        it doesn't, meaning the table lives in `warehouse` itself.
        """
        if self.lakehouse:
            return f"[{self.lakehouse}].[{self.schema}].[{table}]"
        return f"{self.schema}.{table}"

    @property
    def writable(self) -> bool:
        """Whether DML can reach this environment's orch tables at all.

        A lakehouse SQL analytics endpoint is read-only however the request is
        phrased, so an environment still reading lakehouse copies cannot be
        edited. Every environment is on the warehouse layout now, so this is
        always true for a configured one -- it stays a property, not a constant,
        so an environment added later on the older lakehouse layout is still
        correctly refused without a second list of env keys to keep in step.
        """
        return self.configured and not self.lakehouse

    @property
    def status_fqn(self) -> str:
        return self.fqn(self.status_table)

    @property
    def graph_fqn(self) -> str:
        return self.fqn(self.graph_table)

    @property
    def logs_fqn(self) -> str:
        return self.fqn(self.logs_table)


# DEV and QA carry their workspace ids here; UAT's and PRD's come from config.json,
# and each resolves its SQL endpoint from `endpoint_lakehouse` on first use.
#
# All four environments read orch-schema tables from their own warehouse, which
# is the field defaults, so none of them restates it.
_DEFAULT_ENVIRONMENTS: tuple[Environment, ...] = (
    Environment(
        key="dev",
        label="DEV",
        workspace_id="",
        sql_endpoint="",
        promotion_column=None,
    ),
    Environment(
        key="qa",
        label="QA",
        workspace_id="",
        sql_endpoint="",
        promotion_column=None,
    ),
    Environment(key="uat", label="UAT", promotion_column="readyForUAT"),
    Environment(key="prd", label="PRD", promotion_column="readyForProd"),
)


@dataclass(frozen=True)
class Config:
    # --- Warehouse holding the editable dependency graph (DML works here) ----
    # DEV's Fabric SQL analytics endpoint host. Set via config.json or
    # DG_SQL_SERVER -- see ENVIRONMENT_SETUP.md.
    sql_server: str = ""
    warehouse: str = "WH_HDX_DE_Silver"
    # The table NB_Orchestrator_WH actually reads, and the one the Dependency
    # Graph tab edits directly -- plain T-SQL DML, no staging/publish step.
    edit_table: str = "orch.dependencygraph"

    # --- S2T "validate against DDL": which warehouse holds each medallion
    # layer's live table, on the same sql_server host. PostgreSQL-layer tables
    # have no entry -- that layer isn't reachable over this SQL Server driver.
    gold_warehouse: str = "WH_Application_Enablement_Gold"

    # --- Fabric REST identifiers, used for pipeline/job lookups (health tab) -
    # Set via config.json or DG_WORKSPACE_ID / DG_LAKEHOUSE_ID -- see
    # ENVIRONMENT_SETUP.md.
    workspace_id: str = ""
    lakehouse_id: str = ""

    # Empty means auto-detect: warehouse.resolve_driver() picks the best driver
    # actually installed. Set it in config.json only to force a specific one.
    #
    # It used to default to "ODBC Driver 18 for SQL Server", which meant a machine
    # with only Driver 17 got IM002 ("Data source name not found") even though 17
    # works fine for these queries.
    odbc_driver: str = ""

    # --- Monitoring tab: an embedded Datadog dashboard -----------------------
    # The base secure-embed URL Datadog issues for the dashboard (not a secret --
    # it is useless without a valid signature, which datadog_embed.py computes
    # from the credential). Empty means "not configured": the tab says so
    # instead of showing a broken iframe.
    #
    # The signing credential itself deliberately has no field here: it is read
    # straight from the DD_EMBED_CREDENTIAL environment variable in
    # datadog_embed.py, so it can never end up written to config.json.
    datadog_dashboard_url: str = ""

    # --- Who may edit a dependency graph outside DEV ---------------------------
    # The environment whose Fabric *Admin* role grants it. Holding Admin on this
    # workspace is what lets someone edit QA and UAT; everyone else gets DEV only,
    # which is how the tool has always behaved. There is no list of names to
    # maintain here -- membership lives in Entra, where Fabric access already
    # does. See server/roles.py.
    admin_env: str = "prd"

    # Every environment the Health tab can read, and that an admin can edit the
    # dependency graph in -- all four are warehouse-resident now. See
    # Environment.writable.
    environments: tuple[Environment, ...] = _DEFAULT_ENVIRONMENTS

    def environment(self, key: str | None) -> Environment:
        """Look up an environment by key, defaulting to the editable one (DEV)."""
        if not key:
            return self.environments[0]
        for env in self.environments:
            if env.key == key.lower():
                return env
        raise KeyError(key)

    def warehouse_for_layer(self, layer: str) -> str | None:
        """The warehouse holding `layer`'s live tables, or None if unsupported.

        Every layer lives on the same sql_server host; only the warehouse name
        differs, so this is a name lookup rather than a connection choice.
        """
        return {"silver": self.warehouse, "gold": self.gold_warehouse}.get(
            layer.strip().lower()
        )

    @property
    def datadog_configured(self) -> bool:
        return bool(self.datadog_dashboard_url)


def _merge_environments(overrides: object) -> tuple[Environment, ...]:
    """Merge per-environment overrides into the defaults, matched by key.

    Merging rather than replacing means config.json only has to carry what is
    actually missing -- typically just UAT's and PRD's workspace_id and
    sql_endpoint -- instead of restating every field of every environment.
    """
    if not isinstance(overrides, list):
        raise SystemExit("config.json: 'environments' must be a list of objects")

    known = {env.key: env for env in _DEFAULT_ENVIRONMENTS}
    order = [env.key for env in _DEFAULT_ENVIRONMENTS]
    allowed = {f.name for f in fields(Environment)}

    for entry in overrides:
        if not isinstance(entry, dict) or "key" not in entry:
            raise SystemExit("config.json: each environment needs a 'key'")
        key = str(entry["key"]).lower()
        patch = {k: v for k, v in entry.items() if k in allowed and k != "key"}

        if key in known:
            known[key] = replace(known[key], **patch)
        else:
            # A wholly new environment needs a label; default it to the key.
            patch.setdefault("label", key.upper())
            known[key] = Environment(key=key, **patch)
            order.append(key)

    return tuple(known[k] for k in order)


def load_config() -> Config:
    values: dict[str, object] = {}

    if _CONFIG_PATH.exists():
        try:
            values.update(json.loads(_CONFIG_PATH.read_text(encoding="utf-8")))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"{_CONFIG_PATH.name} is not valid JSON: {exc}") from exc

    if "environments" in values:
        values["environments"] = _merge_environments(values["environments"])

    for field in fields(Config):
        # environments is structured; it comes from config.json only.
        if field.name == "environments":
            continue
        env = os.environ.get(f"DG_{field.name.upper()}")
        if env:
            values[field.name] = env

    known = {f.name for f in fields(Config)}
    unknown = set(values) - known
    for key in unknown:
        values.pop(key)  # ignore stray keys (e.g. comments) rather than crashing

    config = Config(**values)  # type: ignore[arg-type]

    # Keep the DEV environment in step with the top-level settings, which are what
    # the editing path (edit_table) uses. Otherwise overriding sql_server or
    # workspace_id would move editing without moving DEV's health read, and the
    # two would silently describe different workspaces. DEV's own lakehouse/schema
    # (empty lakehouse, orch schema) are left alone -- they describe where DEV's
    # health/lineage tables live, not which workspace/warehouse to reach them in.
    aligned = tuple(
        replace(
            env,
            workspace_id=config.workspace_id,
            sql_endpoint=config.sql_server,
            warehouse=config.warehouse,
        )
        if env.key == "dev"
        else env
        for env in config.environments
    )
    return replace(config, environments=aligned)


CONFIG = load_config()
