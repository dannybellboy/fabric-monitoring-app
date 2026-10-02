# Productionalizing dg_tool: shared server, SSO + app roles, Azure App Service

## Context

dg_tool currently runs as a single-user Windows desktop tool: one developer
signs in interactively (browser/device-code against Azure CLI's public
client), the resulting token lives in a DPAPI-encrypted OS cache, and every
module (`warehouse.py`, `fabric_jobs.py`, `publish.py`) calls a global
`fabric_auth.get_token()`/`get_identity()` with no concept of "which request."
It's distributed today as a zip with an embeddable Python interpreter
(`package.ps1`) that a teammate runs on their own machine.

The goal is to deploy this as a real shared service: one running instance on
Azure App Service (or Container Apps), reachable by multiple people at once.

### The access decision (supersedes the earlier per-user delegated design)

An earlier revision of this plan assumed **per-user delegated access** — each
person's own Fabric/SQL permissions gating what they could read and write, via
an on-behalf-of (OBO) token exchange. That is no longer the model.

Stakeholders identified a population of users who need this tool but have **no
Fabric access at all** — people who should see monitoring and process health
without ever being granted a Fabric workspace role. Per-user delegated access
cannot serve them: there is no user token to delegate.

The model is therefore a **trusted subsystem**. Two independent auth planes:

| Plane | Mechanism | Establishes |
| --- | --- | --- |
| User → app | Entra SSO via App Service EasyAuth | **Who** you are, and which app role you hold |
| App → Fabric | Service principal, client credentials | **What the app can do** — a fixed ceiling, no per-user variation |

Authorization moves out of Fabric and into dg_tool. This is the central
consequence and everything in "Security consequences" below follows from it.

## Access model

### Three roles

Role membership comes from Entra security groups, surfaced as app roles in the
EasyAuth `roles` claim.

| Role | Tabs | Capability | Service principal |
| --- | --- | --- | --- |
| **HDX User** | All | Full CRUD — the current "Contributor" view | `dg-tool-contributor` |
| **HDT User** | All | Read-only across every tab — the current "Read-only" view | `dg-tool-reader` |
| **Org User** | Home, Lineage, Health, Monitoring only | Read-only monitoring. S2T, Dependency Graph and Deployments are **hidden entirely** | `dg-tool-reader` |

Tabs today are declared in `web/src/App.tsx:57-68` (`TABS`): Home, S2T,
Dependency Graph, Deployments, Lineage, Health, Monitoring. Org User sees the
list minus the three write-oriented ones.

A user with no recognised role gets no access — EasyAuth authenticated but
app-unauthorized, a 403 and an explanatory page, not a silent downgrade to Org
User. Fail closed; being in the tenant is not a grant.

### Two service principals

| Principal | DEV | QA | PROD |
| --- | --- | --- | --- |
| `dg-tool-contributor` | **Contributor** (read + write) | Read | Read |
| `dg-tool-reader` | Read | Read | Read |

The contributor principal is write-capable **only in DEV**, which matches how
the code is already structured: `warehouse.py`'s `execute()` deliberately takes
no server/database parameters precisely so writes cannot target anything but
the DEV warehouse (`server/warehouse.py:207-214`). QA and PROD are read paths
for the Health and Lineage tabs. That existing constraint becomes an
infrastructure-enforced one rather than a convention.

Which principal serves a request is chosen from the caller's role:

- **HDX User** → `dg-tool-contributor`
- **HDT User**, **Org User** → `dg-tool-reader`

This is defense in depth, not the primary gate. The role check must reject a
disallowed write with a 403 *before* any SQL is attempted — a read-only
principal hitting a write would otherwise surface as an opaque SQL permission
error. The value of the split is that a missed check in application code cannot
become a write, because the credential in hand physically cannot perform one.

### Credentials

Prefer **federated identity credentials** (workload identity) or the App
Service **system-assigned managed identity** over client secrets wherever
Fabric accepts them — no secret to store, no rotation schedule. Where a client
secret is unavoidable, it lives in Key Vault and reaches the app only as an App
Service Application Setting holding a `@Microsoft.KeyVault(...)` reference —
the same env-var-only convention `datadog_embed.py` already established for
`DD_EMBED_CREDENTIAL`. Never in `config.json`.

Two principals means two credentials, both handled this way.

## Security consequences of the trusted-subsystem model

Under per-user delegated access, Fabric rejected an unauthorized write whether
or not application code was correct. That backstop is gone. Every authenticated
user now carries their tier's principal permissions until dg_tool's own code
says otherwise, so a missing authorization check is not a bug that surfaces as
an error — it is silent privilege escalation. Three requirements follow.

**1. Default-deny, enforced structurally.** Not a check written into each
handler. A FastAPI dependency declaring a minimum role, applied at the router,
so an endpoint added a year from now is locked until someone deliberately opens
it. Forgetting is the failure mode being designed against; per-endpoint
discipline is not a control.

**2. Hiding tabs is cosmetic.** Org User must be blocked at the API — `/api/rows*`,
`/api/s2t/*`, `/api/deployments*` all return 403 — not merely denied a button.
The frontend role gate is UX; the backend dependency is the security boundary.

**3. The app's audit columns become the audit trail.** `SUSER_SNAME()` will
report a service principal for every statement, forever. `last_modified_by`
(`server/s2t.py`) and the `_author` columns written by
`import_tracker.py:351` are the *only* record of who did what. They must be
non-nullable and populated server-side from the verified EasyAuth claim, never
from a request payload.

### Two open items in the current code

**The data-agent chat** (`server/main.py:843`) proxies free-text questions to a
Fabric data agent using the app's own token. Under a shared principal, any user
who can reach it can ask that agent anything the agent can reach. The allowlist
at `server/main.py:731-741` constrains *which* agent, not what a given person
may ask. Recommended default: the chat requires **HDX User or HDT User**; Org
User does not get it. If Org User should have a chat surface, restrict it to
`HDX_Health_Agent` and exclude `Dev_Oracle_Agent`. **Needs an explicit decision
before launch** — this is the single widest path from a Fabric-less user to
warehouse data.

**`FABRIC_SSL_VERIFY` defaults to `false`** (`server/main.py:771`), disabling
certificate validation on outbound Fabric calls. Worth fixing regardless; it
matters considerably more once a shared server is carrying service-principal
credentials over those connections. Flip the default to verify-on and make
disabling it opt-in.

## Phase 0 — Azure/Entra/Fabric prerequisites (not code; blocks everything else)

Requires tenant-admin and Fabric-admin access. Listed first because Phase 1's
code assumes all of it exists.

**Entra:**

1. **App registration for dg_tool itself** (single-tenant, your Entra tenant
   id — set via `DG_TENANT_ID`, see `ENVIRONMENT_SETUP.md`). Today dg_tool borrows Azure CLI's
   well-known public client (`AZURE_CLI_CLIENT_ID`); a shared redirect-based
   login needs its own registration. No `api://` scope and no delegated
   `user_impersonation` consent are required — that was an OBO need, and OBO is
   no longer in the design.
2. **Three app roles** on that registration — `HDXUser`, `HDTUser`, `OrgUser` —
   each assigned to an Entra security group rather than to individuals, so
   access requests and offboarding flow through existing IAM processes.
3. **Two service principals**, `dg-tool-contributor` and `dg-tool-reader`, each
   with a federated credential or managed identity where possible (see
   "Credentials" above).
4. **App Service Authentication (EasyAuth)** enabled, AAD provider pointed at
   the registration from step 1, token store on, "Require authentication" set
   to redirect/401 unauthenticated requests at the platform edge, redirect URI
   `/.auth/login/aad/callback`. Confirm the `roles` claim is emitted in the
   token EasyAuth forwards — the whole authorization model depends on it.
5. Confirm `accessTokenAcceptedVersion: 2` on the registration manifest.

**Fabric:**

6. Tenant setting **"Service principals can use Fabric APIs"** enabled for a
   security group; add both principals to it.
7. **Workspace roles** for both principals in *every* workspace the app
   touches — DEV, QA, PROD, and the data-agent workspace (whatever
   `FABRIC_DATA_AGENT_WORKSPACE` is set to, `server/main.py:713`). Health reads
   each environment separately, so a principal missing from one workspace
   produces a partly-broken Health tab rather than a clean failure.
8. **SQL principals** in each warehouse: `CREATE USER [<principal>] FROM
   EXTERNAL PROVIDER` plus explicit, least-privilege role grants. Not
   `db_owner`. The contributor principal's write grants should reach only the
   three tables dg_tool owns — the dependency graph, S2T metadata, and the
   deployment tracker.
9. **Verify data agents accept service-principal callers.** This has
   historically lagged the rest of Fabric; validate it early, because the chat
   surface depends on it and there is no application-side workaround.

## Phase 1 — Backend auth rearchitecture

Goal: replace one global signed-in identity with a per-request role plus a
tier-selected service principal, touching as few call sites as possible.
`get_token(scope)` and `get_identity()` keep their exact current signatures —
only their internals change — so `warehouse.py:112`, `fabric_jobs.py:85`,
`publish.py:63` and `import_tracker.py:351` need **no edits**.

**`server/fabric_auth.py`:**

- Add a `Role` enum (`HDX_USER`, `HDT_USER`, `ORG_USER`) and a `RequestUser`
  dataclass (`oid`, `name`, `username`, `role`). `oid` (AAD object id), not
  email, is the stable identifier — emails change.
- Add a module-level `_current_user: ContextVar[RequestUser | None]`, default
  `None`.
- Add `user_from_headers(headers) -> RequestUser | None`: reads
  `x-ms-client-principal-id` (oid) and `x-ms-client-principal-name`, and
  base64-decodes `x-ms-client-principal` for the `name` and `roles` claims.
  Map the first recognised role value to a `Role`; **return `None` if no
  recognised role is present** rather than defaulting to the lowest tier.
- Add `_EASYAUTH_REQUIRED = os.environ.get("DG_REQUIRE_EASYAUTH", "").lower() in ("1", "true", "yes")`,
  evaluated once at import. This — not "are the headers present on this
  request" — decides whether the local device-code/browser path is reachable.
  Header-presence-as-the-switch would let a misconfigured proxy or a direct hit
  on the container silently fall back to opening a browser server-side; a
  deployment-time setting cannot be triggered by a malformed request.
- Add two client-credential credentials, built lazily and held for process
  lifetime:
  ```python
  _CREDENTIALS: dict[str, TokenCredential] = {}   # "contributor" | "reader"
  ```
  Built from `ManagedIdentityCredential` / `ClientAssertionCredential` /
  `ClientSecretCredential` depending on what Phase 0 provisioned.
- Add `principal_tier() -> str`: `"contributor"` if the current user's role is
  `HDX_USER`, else `"reader"`. In local-dev mode (`_EASYAUTH_REQUIRED` false),
  returns `"local"`.
- Re-key `_tokens`/`_scope_locks` from `scope` to `(tier, scope)`. There are
  only two tiers, so this is a two-entry-per-scope cache shared by all users —
  materially simpler than the per-user cache the OBO design would have needed,
  with no cross-user leakage risk because the token genuinely is the same for
  everyone in a tier.
- `get_token(scope)`: resolve the tier, return a cached token if live,
  otherwise mint from that tier's credential. If `_EASYAUTH_REQUIRED` and no
  `RequestUser` is set, raise `SignInRequired`. If not required and none is
  set, fall through to today's `_acquire_silently()` body verbatim — local dev
  is unchanged.
- `get_identity()`: if a `RequestUser` is set, return `{"name", "username"}`
  straight from it. EasyAuth already decoded the claims; no token round-trip.
  Falls through to today's `_decode_claims(get_token(...))` body only in
  local-dev mode. **This must keep returning the human, not the service
  principal** — it is what stamps the audit columns.
- Keep `sign_in`/`sign_out`/`DeviceCodeCredential`/`InteractiveBrowserCredential`/
  `AzureCliCredential` as-is, now understood as "the local-dev path," gated by
  `_EASYAUTH_REQUIRED`.

**`server/main.py` — auth context middleware:**

Raw ASGI middleware class (not `@app.middleware("http")`/`BaseHTTPMiddleware` —
a plain ASGI class avoids depending on that wrapper's contextvar-propagation
behavior across Starlette versions):

```python
class AuthContextMiddleware:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode(): v.decode() for k, v in scope["headers"]}
        token = fabric_auth._current_user.set(fabric_auth.user_from_headers(headers))
        try:
            await self.app(scope, receive, send)
        finally:
            fabric_auth._current_user.reset(token)
```

Register with `app.add_middleware(AuthContextMiddleware)` **after** the
existing `CORSMiddleware` registration — Starlette wraps middleware in reverse
registration order, so first-registered ends up outermost; keeping CORS first
means it stays outermost (handling preflight and decorating error responses)
with auth-context parsing just inside it.

This reaches every route today because all of them are plain `def`, so FastAPI
dispatches them via `anyio.to_thread.run_sync`, which explicitly copies the
calling coroutine's contextvars onto the worker thread — that is the mechanism
making `_current_user` visible several frames down in `queries.py`/
`warehouse.py` with no signature changes.

**`server/main.py` — role enforcement:**

```python
def require(minimum: Role):
    def dependency():
        user = fabric_auth._current_user.get()
        if user is None:
            raise HTTPException(403, "Not authorized to use this application.")
        if not user.role.satisfies(minimum):
            raise HTTPException(403, "Your access level does not permit this action.")
    return Depends(dependency)
```

Applied via routers, not individual decorators, so the default for anything
unclassified is deny:

- Router for `/api/rows*`, `/api/s2t/*`, `/api/deployments*` — reads require
  `HDT_USER` (which HDX also satisfies), writes require `HDX_USER`. Org User is
  excluded from these paths entirely, matching the hidden tabs.
- Router for `/api/status*`, `/api/environments`, `/api/lineage*`,
  `/api/datadog/*` — requires any recognised role.
- `/api/auth`, `/api/preflight`, `/healthz` — unauthenticated or
  any-role, since the gate itself has to be reachable.
- `/api/oracle-mcp/*` — pending the decision in "Two open items" above;
  provisionally `HDT_USER`.

Wrap the `/api/auth/signin` and `/api/auth/signout` route *registrations* in
`if not fabric_auth.easyauth_required():`. In production these mean "open a
browser on this machine," which is meaningless inside a container and should
not be reachable at all, not merely made to fail gracefully.

`auth_status()`'s dict gains `"mode": "easyauth" | "local"` and `"role"`, so
the frontend does not have to infer either.

**`server/warehouse.py` — connection cache must key on the tier:**

Connections are cached per-thread keyed only by `(server, database)`
(`_local = threading.local()`, `_get_conn`/`_connections`). A connection opened
with `SQL_COPT_SS_ACCESS_TOKEN` is bound to whichever identity's token opened
it, for its whole lifetime. With two principals, worker thread #N can hand an
HDT User a connection opened under the contributor principal — quietly
returning write capability to a read-only tier.

Smaller than the equivalent per-user problem (two possible identities, not N)
but the same class of bug, and it must be fixed before launch:

```python
def _get_conn(server: str, database: str) -> pyodbc.Connection:
    tier = fabric_auth.principal_tier()
    key = (tier, server, database)
    pool = _connections()
    conn = pool.get(key)
    if conn is None:
        conn = pool[key] = _connect(server, database)
    return conn
```

Also add a real per-query timeout while touching this file: the connection
string sets `Connection Timeout=60` (connect-time only); add
`cursor.timeout = <N seconds>` after opening a cursor so a hung query cannot
block a request indefinitely.

**`server/fabric_jobs.py` — prefetch pool context loss:**
`_prefetch_pool.submit(_warm)` in `prefetch_failures()` uses a raw
`concurrent.futures.ThreadPoolExecutor`, which does **not** copy the caller's
contextvars (unlike `anyio`/`asyncio.Task`). In production the background
warm-up would run with no `_current_user` set and silently never populate the
cache — the existing `except Exception: log.info(...)` swallows the
`SignInRequired` it would raise. Snapshot the context at the call site:

```python
def prefetch_failures(workspace_id, rows):
    ctx = contextvars.copy_context()
    for process, run_id, is_stored_proc, is_gold in rows:
        ...
        _prefetch_pool.submit(ctx.run, _warm)
```

Safe because the failure-detail cache is keyed only by `run_id` and is
read-only data shared across all users.

**Diagnostic script:** extend `server/check_browser_signin.py` (or add a
sibling) into a pre-deployment check that acquires a token as each service
principal and runs `SELECT DB_NAME(), SUSER_SNAME()` against DEV, QA and PROD,
plus a Fabric REST call — proving all of Phase 0's grants are wired correctly
without needing a live App Service. Assert the contributor principal *can*
write in DEV and *cannot* in QA/PROD; a passing read test proves nothing about
the write boundary.

## Phase 2 — Frontend auth and role UI

- `web/src/types.ts`: add `mode: 'easyauth' | 'local'` and
  `role: 'HDXUser' | 'HDTUser' | 'OrgUser'` to `AuthStatus`.
- `web/src/App.tsx:150` — the `readOnly` state and the "View (testing)"
  segmented control at `App.tsx:626-641` are a manual stand-in for exactly this
  check, and their own comment says so. Replace: `readOnly` becomes
  `role !== 'HDXUser'`, derived from `/api/auth`. Keep the manual toggle in
  local-dev mode only (`mode === 'local'`) so the read-only rendering stays
  exercisable without a second account; it must not ship reachable in
  production, since a client-side toggle that changed a real permission would
  be theatre.
- `App.tsx:57-68` — filter `TABS` by role. Org User gets Home, Lineage, Health,
  Monitoring; the other two get all seven. Filter the array rather than hiding
  buttons, so `tab` state cannot land on a hidden tab; also guard the initial
  `tab` value and any deep link against a role-invalid target.
- The docked chat surface (`ChatSurface.tsx`, rendered on every tab) is gated
  by the same decision as `/api/oracle-mcp/*`.
- `SignInGate.tsx`: branch on `auth.mode`. In `"easyauth"` mode an
  unauthenticated response means redirect —
  `window.location.href = '/.auth/login/aad?post_login_redirect_uri=' + encodeURIComponent(location.pathname)`
  — rather than driving the device-code/browser UI, which stays as-is and
  renders only in `"local"` mode. Add a distinct authenticated-but-unauthorized
  state: signed in, no recognised role, explaining which group to request.
- `App.tsx`'s sign-out becomes, in `"easyauth"` mode, a link to
  `/.auth/logout?post_logout_redirect_uri=/`.
- `api.ts`'s `signIn`/`signOut` can stay (harmless dead calls in an EasyAuth
  build); the pending-sign-in poll effect never fires since `signIn.state`
  never becomes `"pending"` in that mode.

## Phase 3 — Containerization

- New `Dockerfile` at repo root, multi-stage:
  - Stage 1 (`node:20-slim`): `npm ci && npm run build` in `web/`, producing
    `web/dist` (already used by `package.ps1`; `main.py` serves it via
    `StaticFiles`/`FileResponse` when present — no server change needed).
  - Stage 2 (`python:3.12-slim`): install `unixodbc-dev` + Microsoft's
    `msodbcsql18` from Microsoft's apt repo (the Linux equivalent of the driver
    `resolve_driver()` already prefers — `"ODBC Driver 18 for SQL Server"` is
    already first in `_PREFERRED_DRIVERS`, so no code change once the driver is
    actually in the image), `pip install -r server/requirements.txt`, copy
    `server/` and the built `web/dist`, run
    `uvicorn main:app --host 0.0.0.0 --port 8000`.
- Pin `server/requirements.txt` to exact versions (drop the bare `>=`) so
  container builds are reproducible.
- Add `GET /healthz` doing no auth/Fabric/SQL work, for platform health probes.
  Exclude it from EasyAuth's "require authentication" path.

## Phase 4 — Config, secrets, CORS

- `server/config.py`: add the `server/config.example.json` its docstring
  already references, documenting every overridable field (workspace ids, sql
  endpoint, warehouse/lakehouse names — all correctly non-secret) without real
  values.
- New production env vars, all read the way `DD_EMBED_CREDENTIAL` already is
  (env-only, never `config.json`):
  - `DG_REQUIRE_EASYAUTH`
  - `DG_AAD_CLIENT_ID` — the app registration EasyAuth authenticates against
  - `DG_SP_CONTRIBUTOR_CLIENT_ID`, `DG_SP_READER_CLIENT_ID`
  - `DG_SP_CONTRIBUTOR_SECRET`, `DG_SP_READER_SECRET` — Key Vault references;
    omitted entirely if managed identity or federated credentials are used
  - `DG_ROLE_GROUP_MAP` — optional, only if roles are mapped from group object
    ids rather than Entra app roles
- `FABRIC_SSL_VERIFY`: change the default to verify-on (`server/main.py:771`).
- `main.py`'s `CORSMiddleware` allow-list is `localhost:5173`/`127.0.0.1:5173`/
  `localhost:4173` only. Once frontend and backend share an origin most
  cross-origin traffic disappears; move the allow-list to a `DG_*` env var so a
  staging slot needs no code change.

## Phase 5 — Production hardening

- Structured logging routed to whatever the platform ingests (App Service
  captures stdout/stderr to Log Stream / Application Insights).
- **Authorization audit log**: every 403 from the role dependency, and every
  write, logged with `oid`, role, endpoint and outcome. With Fabric no longer
  enforcing per-user permissions, this is the only place an access-control
  failure becomes visible. Not optional under this model.
- Query timeout: covered by Phase 1's `warehouse.py` change.
- Scaling: the token cache is now two entries per scope, process-wide, so
  multi-instance scale-out costs at most a redundant token fetch per instance —
  the shared-cache (Redis) concern from the per-user design does not apply. The
  per-thread SQL connection cache is still process-local, which is fine.

## Phase 6 — CI/CD (Azure Pipelines, matching the existing Azure DevOps repo)

New `azure-pipelines.yml`: build stage (`npm ci`, `npm run build` — which
already runs `tsc --noEmit`; `pip install -r server/requirements.txt` as an
import/syntax sanity check; no existing test suite, so no test stage rather
than inventing one) → build and push the Dockerfile to ACR → deploy to App
Service (slot-swap if a staging slot exists, otherwise direct).

## Explicitly out of scope

- Rate limiting / request-size limits — small known user base; revisit if the
  Org User population makes that untrue.
- A real automated test suite — none exists today; not introduced here.
- Self-service role management UI — roles are Entra group memberships,
  administered through existing IAM processes.

## Verification

1. **Local dev unchanged**: `uvicorn main:app --reload` + `npm run dev` with
   `DG_REQUIRE_EASYAUTH` unset — browser/device-code sign-in still works
   exactly as today. This is the regression test that matters most, since
   Phase 1 rewrites the file everything else depends on.
2. **Service principal grants, before any App Service exists**: the extended
   `check_browser_signin.py` proves each principal can acquire SQL and Fabric
   tokens and that the contributor principal can write in DEV but **not** in QA
   or PROD.
3. **Container build**: `docker build .` succeeds; `docker run` with
   `DG_REQUIRE_EASYAUTH` unset returns 200 from `/healthz` and falls back to
   local-dev auth.
4. **Role matrix, deployed**: sign in as one real user per role from separate
   browser profiles and confirm, for each —
   - HDX User: all seven tabs, writes succeed, audit columns record *their*
     UPN and not the service principal.
   - HDT User: all seven tabs, every write control absent, and every write
     endpoint returns 403 **when called directly with curl**, not merely hidden
     in the UI.
   - Org User: four tabs; `/api/rows`, `/api/s2t/mapping` and
     `/api/deployments` return 403 called directly.
   - No role: authenticated, but the unauthorized page rather than any tab.
5. **Principal isolation under thread reuse**: with an HDX User and an HDT User
   issuing overlapping requests, enough concurrency to force FastAPI worker
   thread reuse, confirm no HDT User request ever runs on a contributor
   connection. Easiest assertion: `SELECT SUSER_SNAME()` through the normal
   query path and check it against the caller's expected tier. This is the
   scenario the connection-cache bug would otherwise hide.
6. **Audit trail**: after the role-matrix run, confirm every written row's
   `last_modified_by` / `_author` names a human, and that a
   `SELECT DISTINCT SUSER_SNAME()`-style check confirms the DB itself only ever
   saw the service principals.
