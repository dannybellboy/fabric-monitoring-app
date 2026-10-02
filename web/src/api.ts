import type {
  AuthStatus,
  Deployment,
  DeploymentInput,
  ERDData,
  EnvironmentInfo,
  FailureDetail,
  GateKey,
  GraphApplyResult,
  GraphDiff,
  GraphRow,
  Identity,
  Issue,
  LiveJobStatus,
  PreflightReport,
  ReleaseSummary,
  Row,
  RowInput,
  S2TColumnIn,
  S2TMapping,
  S2TMetadataIn,
  S2TProcedureTable,
  S2TSuggestions,
  S2TTableRef,
  S2TTarget,
  S2TValidation,
  StatusReport,
} from './types'

/**
 * Server errors are surfaced verbatim wherever possible. The backend's
 * validation messages ("Dependency cycle: A -> B -> A") are the whole point of
 * the validation layer, so replacing them with a generic "request failed" would
 * throw away the only useful part.
 */
export class ApiError extends Error {
  readonly status: number
  readonly issues: Issue[]

  constructor(status: number, message: string, issues: Issue[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.issues = issues
  }
}

interface ValidationDetail {
  message?: string
  issues?: Issue[]
}

function extractError(status: number, body: unknown): ApiError {
  if (typeof body === 'object' && body !== null && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail

    if (typeof detail === 'string') return new ApiError(status, detail)

    // FastAPI's own 422 shape: [{loc, msg, type}, ...] from pydantic.
    if (Array.isArray(detail)) {
      const messages = detail
        .map((d) => (typeof d === 'object' && d && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d)))
        .filter(Boolean)
      return new ApiError(status, messages.join('; ') || 'Validation failed.')
    }

    if (typeof detail === 'object' && detail !== null) {
      const { message, issues } = detail as ValidationDetail
      const list = issues ?? []
      const summary =
        message ??
        list
          .filter((i) => i.level === 'error')
          .map((i) => i.message)
          .join(' ') ??
        'Validation failed.'
      return new ApiError(status, summary || 'Validation failed.', list)
    }
  }
  return new ApiError(status, `Request failed (${status}).`)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
  } catch {
    throw new ApiError(0, 'Cannot reach the HDX Management Tool backend. Is uvicorn running on port 8000?')
  }

  if (!response.ok) {
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      /* non-JSON error body: fall through to the generic message */
    }
    throw extractError(response.status, body)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/** `?env=…` / `&env=…`, or nothing at all when the caller wants the default (DEV). */
const envParam = (env: string | undefined, separator: '?' | '&' = '?') =>
  env ? `${separator}env=${encodeURIComponent(env)}` : ''

export const api = {
  me: () => request<Identity>('/api/me'),

  // --- auth gate ------------------------------------------------------------
  auth: () => request<AuthStatus>('/api/auth'),
  preflight: () => request<PreflightReport>('/api/preflight'),
  signIn: (method: 'browser' | 'device') =>
    request<unknown>(`/api/auth/signin?method=${method}`, { method: 'POST' }),
  signOut: () => request<unknown>('/api/auth/signout', { method: 'POST' }),
  /** The editable dependency graph as one environment's own table holds it --
   *  unfiltered, with RowId and audit columns. Unlike `graph`, no promotion
   *  filter is applied: this is what is really in the table. Defaults to DEV. */
  rows: (env?: string) => request<Row[]>(`/api/rows${envParam(env)}`),
  validate: (env?: string) => request<Issue[]>(`/api/validate${envParam(env)}`),
  environments: () => request<EnvironmentInfo[]>('/api/environments'),

  /** A freshly signed, short-lived URL for the Monitoring tab's Datadog embed. */
  datadogEmbedUrl: () => request<{ url: string }>('/api/datadog/embed-url'),
  /** The data agents in the configured workspace, for the chat's agent picker. */
  oracleMcpAgents: () =>
    request<{ agents: { id: string; name: string; description: string }[]; default: string | null }>(
      '/api/oracle-mcp/agents',
    ),

  oracleMcpChat: (messages: { role: string; content: string }[], agent?: string) =>
    request<{ reply: string }>('/api/oracle-mcp/chat', {
      method: 'POST',
      body: JSON.stringify(agent ? { messages, agent } : { messages }),
    }),

  // --- source-to-target spec (real CRUD: HDX.* lives in the warehouse) -------
  s2tTargets: () => request<S2TTarget[]>('/api/s2t/targets'),
  s2tSuggestions: () => request<S2TSuggestions>('/api/s2t/suggestions'),

  s2tTables: (target: string) =>
    request<S2TTableRef[]>(`/api/s2t/tables?target=${encodeURIComponent(target)}`),

  /** Procedure -> table it builds, with sources. Labels the Lineage diagram. */
  s2tProcedures: () => request<S2TProcedureTable[]>('/api/s2t/procedures'),

  s2tOrphans: (target: string) =>
    request<S2TTableRef[]>(`/api/s2t/orphans?target=${encodeURIComponent(target)}`),

  s2tMapping: (target: string, table: string) =>
    request<S2TMapping>(
      `/api/s2t/mapping?target=${encodeURIComponent(target)}&table=${encodeURIComponent(table)}`,
    ),

  s2tValidate: (target: string, table: string) =>
    request<S2TValidation>(
      `/api/s2t/validate?target=${encodeURIComponent(target)}&table=${encodeURIComponent(table)}`,
    ),
  s2tValidateAll: (targets?: string[] | 'all', environments?: string[]) =>
    request<any>('/api/s2t/validate-all', {
      method: 'POST',
      body: JSON.stringify({ targets: targets ?? 'all', environments: environments ?? undefined }),
    }),

  s2tCreateMapping: (table_name: string, medallion_layer: string, values: S2TMetadataIn) =>
    request<S2TMapping>('/api/s2t/mapping', {
      method: 'POST',
      body: JSON.stringify({ table_name, medallion_layer, values }),
    }),

  s2tUpdateMapping: (
    table_name: string,
    medallion_layer: string,
    values: S2TMetadataIn,
    expected_last_modified: string | null,
  ) =>
    request<S2TMapping>('/api/s2t/mapping', {
      method: 'PUT',
      body: JSON.stringify({ table_name, medallion_layer, values, expected_last_modified }),
    }),

  s2tDeleteMapping: (target: string, table: string, expected: string | null) =>
    request<{ message: string }>(
      `/api/s2t/mapping?target=${encodeURIComponent(target)}&table=${encodeURIComponent(table)}` +
        (expected ? `&expected_last_modified=${encodeURIComponent(expected)}` : ''),
      { method: 'DELETE' },
    ),

  s2tCreateColumn: (
    table_name: string,
    medallion_layer: string,
    column_name: string,
    values: S2TColumnIn,
  ) =>
    request<S2TMapping>('/api/s2t/columns', {
      method: 'POST',
      body: JSON.stringify({ table_name, medallion_layer, column_name, values }),
    }),

  s2tUpdateColumn: (
    table_name: string,
    medallion_layer: string,
    column_name: string,
    values: S2TColumnIn,
    rename_to?: string | null,
    expected_last_modified?: string | null,
  ) =>
    request<S2TMapping>('/api/s2t/columns', {
      method: 'PUT',
      body: JSON.stringify({
        table_name,
        medallion_layer,
        column_name,
        rename_to: rename_to ?? null,
        values,
        expected_last_modified: expected_last_modified ?? null,
      }),
    }),

  s2tDeleteColumn: (
    target: string,
    table: string,
    column: string,
    expected: string | null,
  ) =>
    request<S2TMapping>(
      `/api/s2t/columns?target=${encodeURIComponent(target)}&table=${encodeURIComponent(
        table,
      )}&column=${encodeURIComponent(column)}` +
        (expected ? `&expected_last_modified=${encodeURIComponent(expected)}` : ''),
      { method: 'DELETE' },
    ),

  // --- deployment tracker (real CRUD: dg_tool owns deploy.DeploymentTracker) -
  deployments: (release?: string) =>
    request<Deployment[]>(
      `/api/deployments${release ? `?release=${encodeURIComponent(release)}` : ''}`,
    ),

  deploymentReleases: () => request<ReleaseSummary[]>('/api/deployments/releases'),

  deploymentSuggestions: () =>
    request<Record<string, string[]>>('/api/deployments/suggestions'),

  createDeployment: (values: DeploymentInput) =>
    request<Deployment>('/api/deployments', {
      method: 'POST',
      body: JSON.stringify(values),
    }),

  updateDeployment: (
    deploymentId: string,
    values: DeploymentInput,
    expected_last_modified: string | null,
  ) =>
    request<Deployment>(`/api/deployments/${encodeURIComponent(deploymentId)}`, {
      method: 'PUT',
      body: JSON.stringify({ values, expected_last_modified }),
    }),

  /**
   * Set one gate. `passedOn` of null with `passed` true records "passed, day
   * unknown" — how every imported row arrives.
   */
  setDeploymentGate: (
    deploymentId: string,
    gate: GateKey,
    passed: boolean,
    passedOn: string | null,
    expected_last_modified: string | null,
  ) =>
    request<Deployment>(`/api/deployments/${encodeURIComponent(deploymentId)}/gate`, {
      method: 'POST',
      body: JSON.stringify({ gate, passed, passedOn, expected_last_modified }),
    }),

  deleteDeployment: (deploymentId: string, expected: string | null) =>
    request<{ message: string }>(
      `/api/deployments/${encodeURIComponent(deploymentId)}` +
        (expected ? `?expected_last_modified=${encodeURIComponent(expected)}` : ''),
      { method: 'DELETE' },
    ),

  status: (env?: string) =>
    request<StatusReport>(`/api/status${env ? `?env=${encodeURIComponent(env)}` : ''}`),

  /** Dependency-graph edges as read from that environment's own published table. */
  graph: (env?: string) =>
    request<GraphRow[]>(`/api/graph${env ? `?env=${encodeURIComponent(env)}` : ''}`),

  /** Why a process's last run failed. Slow: it calls out to the Fabric API. */
  failure: (process: string, env?: string) =>
    request<FailureDetail>(
      `/api/failure?process=${encodeURIComponent(process)}` +
        (env ? `&env=${encodeURIComponent(env)}` : ''),
    ),

  /** Live job-instance status for one Running row, straight from the Fabric
   *  API. Meant to be polled fast and often; unlike `failure`, no caching. */
  liveStatus: (process: string, env?: string) =>
    request<LiveJobStatus>(
      `/api/status/live?process=${encodeURIComponent(process)}` +
        (env ? `&env=${encodeURIComponent(env)}` : ''),
    ),

  /** Zeroes one process's RetryCount. Needs a table that can take the write
   *  (EnvironmentInfo.statusWritable — 409 if not) and, outside DEV, an admin
   *  (Identity.isAdmin — 403). */
  resetRetryCount: (process: string, env?: string) =>
    request<{ process: string; previousRetryCount: number; retryCount: number }>(
      `/api/status/retry-reset?process=${encodeURIComponent(process)}` +
        (env ? `&env=${encodeURIComponent(env)}` : ''),
      { method: 'POST' },
    ),

  /**
   * Compare two environments' dependency-graph table contents.
   *
   * A data diff, not the S2T tab's DDL one: which edges only one side has, and
   * which flags disagree on the edges both hold. Only differences come back;
   * matching edges are reported as a count.
   */
  graphDiff: (left: string, right: string) =>
    request<GraphDiff>(
      `/api/graph/diff?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`,
    ),

  /**
   * Copy one edge from the environment that has it right to the one that does
   * not — the diff view's "use this side" action. Whole-row, and only ever adds
   * or updates: nothing here deletes an edge from the target. Same permissions
   * as a hand edit, so anywhere but DEV needs an admin (403) and a table that
   * can take DML (409).
   */
  graphApply: (source: string, target: string, process: string, dependency: string | null) =>
    request<GraphApplyResult>('/api/graph/apply', {
      method: 'POST',
      body: JSON.stringify({ source, target, process, dependency }),
    }),

  // --- writes ---------------------------------------------------------------
  // `env` defaults to DEV, which anyone who can reach the app may edit. Anywhere
  // else the server requires an admin (Identity.isAdmin) and refuses an
  // environment whose table cannot take DML, so these can be called optimistically
  // and the error reported.

  create: (row: RowInput, env?: string) =>
    request<Row>(`/api/rows${envParam(env)}`, {
      method: 'POST',
      body: JSON.stringify(row),
    }),

  update: (rowId: string, row: RowInput, env?: string) =>
    request<Row>(`/api/rows/${encodeURIComponent(rowId)}${envParam(env)}`, {
      method: 'PUT',
      body: JSON.stringify(row),
    }),

  /** Hard-deletes one dependency edge -- no audit trail, no undo. */
  deleteRow: (rowId: string, env?: string) =>
    request<void>(`/api/rows/${encodeURIComponent(rowId)}${envParam(env)}`, {
      method: 'DELETE',
    }),

  setActive: (rowId: string, active: boolean, env?: string) =>
    request<Row>(
      `/api/rows/${encodeURIComponent(rowId)}/active?active=${active}` +
        envParam(env, '&'),
      { method: 'POST' },
    ),

  setReady: (
    rowId: string,
    field: 'readyForUAT' | 'readyForProd',
    value: boolean,
    env?: string,
  ) =>
    request<Row>(
      `/api/rows/${encodeURIComponent(rowId)}/ready?field=${field}&value=${value}` +
        envParam(env, '&'),
      { method: 'POST' },
    ),

  /** `env` of 'all' keeps every mapped table, rather than only the ones built. */
  erd: (env: string) => request<ERDData>(`/api/erd?env=${encodeURIComponent(env)}`),
}
