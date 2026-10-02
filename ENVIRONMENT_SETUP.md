# Environment setup

This repo was scrubbed of all org-specific Fabric workspace IDs, lakehouse/object
IDs, SQL endpoint hostnames, the Entra tenant ID, and data-agent IDs before being
pushed here. Everything below now defaults to empty and the app will run, but
report each environment as "not configured" until you supply your own values.

Nothing removed was a credential — these are all Fabric/Entra object
identifiers. Authentication still happens interactively via device-code/az-login
(`server/fabric_auth.py`); no token or secret was ever in source.

## 1. `server/config.json` (gitignored, per machine)

Copy `server/config.example.json` to `server/config.json` and fill in the
placeholders. Values can also be set via `DG_<FIELD>` environment variables
(env wins over the file, which wins over the code defaults — see
`server/config.py:load_config`).

| Key | File/field | What it is | Where to find it |
| --- | --- | --- | --- |
| `sql_server` | `config.py` `Config.sql_server` (also `DG_SQL_SERVER`) | DEV warehouse's SQL analytics endpoint host | Fabric portal → DEV workspace → warehouse → Settings → SQL connection string |
| `workspace_id` | `config.py` `Config.workspace_id` (also `DG_WORKSPACE_ID`) | DEV Fabric workspace GUID | Fabric portal → DEV workspace → Workspace settings → "Workspace ID" (or the URL) |
| `lakehouse_id` | `config.py` `Config.lakehouse_id` (also `DG_LAKEHOUSE_ID`) | DEV lakehouse GUID used for health/job lookups | Fabric portal → DEV workspace → lakehouse item → Settings |
| `environments[].workspace_id` (dev/qa) | `config.py` `_DEFAULT_ENVIRONMENTS` | QA workspace GUID (DEV's is driven by the top-level `workspace_id` above) | Same as above, in the QA workspace |
| `environments[].sql_endpoint` (dev/qa) | same | QA warehouse SQL endpoint host | Same as above, in the QA workspace |
| `environments[].workspace_id` (uat/prd) | same | UAT/PRD workspace GUIDs | Same as above, in each workspace |
| `datadog_dashboard_url` | `config.py` `Config.datadog_dashboard_url` | Base secure-embed URL for the Monitoring tab's dashboard | Datadog → dashboard → Share → Secure embed |

## 2. Environment variables (no file — set directly)

| Variable | Used in | What it is | Where to find it |
| --- | --- | --- | --- |
| `DG_TENANT_ID` | `server/fabric_auth.py` | Your Entra tenant GUID | Entra admin center → Overview → Tenant ID |
| `FABRIC_DATA_AGENT_WORKSPACE` | `server/main.py` | Workspace GUID holding the Fabric Data Agents the chat tab talks to | Fabric portal → workspace containing the data agents |
| `FABRIC_DATA_AGENT_ID` | `server/main.py` | GUID of the data agent the chat opens on by default | Fabric portal → that workspace → data agent item → Settings |
| `FABRIC_DATA_AGENT_IDS` | `server/main.py` | Comma-separated allow-list of data agent GUIDs the chat endpoint will accept (defaults to none until set) | Same as above, one per agent you want to expose |
| `DD_EMBED_CREDENTIAL` | `server/datadog_embed.py` | Datadog embed signing credential (a secret — never put this in a file) | Datadog → dashboard → Share → Secure embed → signing key |

## 3. Not changed (safe to keep)

- `AZURE_CLI_CLIENT_ID` in `server/fabric_auth.py` — Microsoft's well-known
  public Azure CLI client ID, not org-specific.
- `warehouse` / `gold_warehouse` / table names (`WH_HDX_DE_Silver`,
  `orch.dependencygraph`, etc.) — object *names*, not IDs; rename to match
  your own warehouse if different.

## 4. Not included in this push

The original repo's `dist/` folder (a packaged build with an embedded Python
runtime and a baked `config.json`) was intentionally left out — it's a build
artifact, not source, and it also contained real UAT/PRD workspace IDs and a
live Datadog embed URL. Rebuild it locally with `package.ps1` once
`server/config.json` is filled in.
