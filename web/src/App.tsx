import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import ConfirmDialog from './components/ConfirmDialog'
import CrossEnvConfirm from './components/CrossEnvConfirm'
import type { CrossEnvChange } from './components/CrossEnvConfirm'
import DeploymentsView from './components/DeploymentsView'
import EnvBar from './components/EnvBar'
import ERDView from './components/ERDView'
import GraphDiffModal from './components/GraphDiffModal'
import HomeView from './components/HomeView'
import LineageView from './components/LineageView'
import MonitoringView from './components/MonitoringView'
import { MCP_CHAT_ENABLED, useOracleMcpChat } from './components/ChatSurface'
import OracleMCPChatDock from './components/OracleMCPChatDock'
import RowForm from './components/RowForm'
import type { SavePlan } from './components/RowForm'
import RowTable from './components/RowTable'
import S2TView from './components/S2TView'
import SignInGate from './components/SignInGate'
import StatusDashboard from './components/StatusDashboard'
import { ApiError, api } from './api'
import { severityOf } from './health'
import { procMappings } from './lineage'
import type { ProcMapping } from './lineage'
import type {
  AuthStatus,
  EnvironmentInfo,
  GraphRow,
  Identity,
  Issue,
  LiveJobStatus,
  ProcessStatus,
  Row,
  RowInput,
  StatusReport,
} from './types'

type Tab =
  | 'home'
  | 's2t'
  | 'table'
  | 'deployments'
  | 'lineage'
  | 'erd'
  | 'status'
  | 'monitoring'

/** How often the Health tab re-reads execution status while it is open. */
const STATUS_POLL_MS = 60_000

/** How often a currently-Running row is checked against Fabric's own live job
 *  status, so the Health tab can catch a finish well before the status
 *  table's own ~20-minute write reflects it. Deliberately much faster than
 *  STATUS_POLL_MS, and deliberately scoped to only Running rows -- see the
 *  liveStatus effect below. */
const LIVE_POLL_MS = 15_000

/** Fabric job statuses that will never change again, so a Running row that
 *  reaches one of these stops being polled. */
const LIVE_TERMINAL = new Set(['Completed', 'Succeeded', 'Failed', 'Cancelled', 'Deduped'])

/** Tab labels and the page heading each one shows. Declared together so the nav
 *  button and the title cannot drift apart. */
const TABS: { key: Tab; label: string; heading: string }[] = [
  { key: 'home', label: 'Home', heading: 'HDX Management' },
  { key: 's2t', label: 'S2T', heading: 'Source to Target' },
  { key: 'table', label: 'Dependency Graph', heading: 'Dependency Graph' },
  { key: 'deployments', label: 'Deployments', heading: 'Deployment Tracker' },
  { key: 'lineage', label: 'Lineage', heading: 'Process Lineage' },
  { key: 'erd', label: 'ERD', heading: 'Silver Layer Schema' },
  { key: 'status', label: 'Fabric Monitoring', heading: 'Fabric Monitoring' },
  { key: 'monitoring', label: 'PostgreSQL Monitoring', heading: 'PostgreSQL Monitoring' },
  // No MCP chat tab: the chat is the docked window in the bottom-right corner
  // instead. OracleMCPChatView is the full-page view of the same conversation and
  // is kept for that reason -- re-register a tab here to bring it back.
]

/**
 * The five access levels the deployed app will hold. Real membership arrives in
 * EasyAuth's `roles` claim; until then these are previewable from the masthead
 * toggle. Every role can see every tab -- what differs is which environments and
 * write controls each one gets, encoded in the permission tables below.
 */
type PreviewRole = 'Admin' | 'DevHdxUser' | 'QaHdxUser' | 'RunTeamUser' | 'NonHdxUser'

const PREVIEW_ROLES: { key: PreviewRole; label: string; hint: string }[] = [
  { key: 'Admin', label: 'Admin', hint: 'Universal access — every tab and environment, including reconcile.' },
  {
    key: 'DevHdxUser',
    label: 'DEV HDX User',
    hint: 'Writes DEV only: dependency-graph edits and retry reset. Also writes the S2T spec and Deployments. Read-only everywhere else.',
  },
  {
    key: 'QaHdxUser',
    label: 'QA HDX User',
    hint: 'Writes DEV and QA: dependency-graph edits and retry reset. Also writes Deployments. Read-only everywhere else.',
  },
  {
    key: 'RunTeamUser',
    label: 'Run Team User',
    hint: 'Writes Deployments and resets retry counts in every environment. Read-only everywhere else.',
  },
  {
    key: 'NonHdxUser',
    label: 'Non HDX User',
    hint: 'Read-only, UAT and PRD only. No S2T DDL validation, no environment compare.',
  },
]

/** Environments (by key) each role may write the dependency graph in. 'all'
 *  matches every configured environment. */
const GRAPH_WRITE_ENVS: Record<PreviewRole, 'all' | string[]> = {
  Admin: 'all',
  DevHdxUser: ['dev'],
  QaHdxUser: ['dev', 'qa'],
  RunTeamUser: [],
  NonHdxUser: [],
}

/** Environments (by key) each role may reset a retry count in. Wider than
 *  GRAPH_WRITE_ENVS for Run Team User, whose only two capabilities are
 *  Deployments and this. */
const RETRY_RESET_ENVS: Record<PreviewRole, 'all' | string[]> = {
  Admin: 'all',
  DevHdxUser: ['dev'],
  QaHdxUser: ['dev', 'qa'],
  RunTeamUser: 'all',
  NonHdxUser: [],
}

const CAN_WRITE_DEPLOYMENTS: Record<PreviewRole, boolean> = {
  Admin: true,
  DevHdxUser: true,
  QaHdxUser: true,
  RunTeamUser: true,
  NonHdxUser: false,
}

const CAN_WRITE_S2T: Record<PreviewRole, boolean> = {
  Admin: true,
  DevHdxUser: true,
  QaHdxUser: false,
  RunTeamUser: false,
  NonHdxUser: false,
}

const CAN_VALIDATE_S2T: Record<PreviewRole, boolean> = {
  Admin: true,
  DevHdxUser: true,
  QaHdxUser: true,
  RunTeamUser: true,
  NonHdxUser: false,
}

const CAN_COMPARE_ENVS: Record<PreviewRole, boolean> = {
  Admin: true,
  DevHdxUser: true,
  QaHdxUser: true,
  RunTeamUser: true,
  NonHdxUser: false,
}

const CAN_RECONCILE: Record<PreviewRole, boolean> = {
  Admin: true,
  DevHdxUser: false,
  QaHdxUser: false,
  RunTeamUser: false,
  NonHdxUser: false,
}

/** Environments (by key) each role's env-aware tabs (Dependency Graph, Health,
 *  Lineage, ERD) may select at all -- narrower than the write tables above,
 *  since a role can be allowed to *read* an environment it cannot write. */
const VISIBLE_ENVS: Record<PreviewRole, 'all' | string[]> = {
  Admin: 'all',
  DevHdxUser: 'all',
  QaHdxUser: 'all',
  RunTeamUser: 'all',
  NonHdxUser: ['uat', 'prd'],
}

/** This role's default environment on tabs that remember one, for roles scoped
 *  away from DEV. Absent entries keep the app's existing DEV default. */
const DEFAULT_ENV: Partial<Record<PreviewRole, string>> = {
  NonHdxUser: 'prd',
}

function envAllowed(scope: 'all' | string[], env: string): boolean {
  return scope === 'all' || scope.includes(env)
}

/** null = closed, 'new' = create form, Row[] = edit every row on file for one process. */
type Editing = null | 'new' | Row[]

const THEME_KEY = 'hdx-theme'
const PINK_KEY = 'hdx-pink'

/**
 * The environment the Dependency Graph tab starts on, and the only one anyone
 * can edit without being an admin. Matches the server's default -- an /api/rows
 * call with no env reads this one.
 */
const EDIT_ENV = 'dev'

/** Every field a save can change, for spelling out a cross-environment write. */
const DIFFABLE_FIELDS: (keyof RowInput)[] = [
  'Process',
  'Dependency',
  'readyForUAT',
  'readyForProd',
  'isStoredPro',
  'RunTimes',
  'RequiresHashing',
  'isGold',
  'WarehouseName',
  'WorkspacePrefix',
  'NeedsTimestamp',
  'lookbackRequired',
  'isActive',
]

function showValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(none)'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return String(value)
}

function edgeLabel(row: Pick<RowInput, 'Process' | 'Dependency'>): string {
  return `${row.Process} → ${row.Dependency ?? '(no dependency)'}`
}

/** 'isGold: off → on' for every field that actually differs. */
function fieldDiff(before: RowInput, after: RowInput): string[] {
  return DIFFABLE_FIELDS.filter((field) => before[field] !== after[field]).map(
    (field) => `${field}: ${showValue(before[field])} → ${showValue(after[field])}`,
  )
}

export default function App() {
  /** Undocumented: clicking the masthead logo flips this and pins it via
   *  data-theme (styles.css), overriding the OS prefers-color-scheme default.
   *  Persisted so the choice survives a reload. */
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = window.localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark') return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })

  /** A second, independent undocumented toggle -- hidden over the signed-in
   *  user's name -- that overrides light/dark with an all-pink palette. Kept
   *  separate from `theme` rather than folded into a three-way enum, so
   *  turning it off always lands back on whichever of light/dark the logo
   *  toggle last picked, instead of having to remember a prior state. */
  const [pink, setPink] = useState<boolean>(() => window.localStorage.getItem(PINK_KEY) === '1')

  // Layout effect, not a plain effect, so the attribute lands before paint --
  // otherwise a stored choice that differs from the OS default would flash
  // the wrong theme for one frame on load.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', pink ? 'pink' : theme)
    window.localStorage.setItem(THEME_KEY, theme)
    window.localStorage.setItem(PINK_KEY, pink ? '1' : '0')
  }, [theme, pink])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  const togglePink = () => setPink((p) => !p)

  const [rows, setRows] = useState<Row[]>([])
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const [report, setReport] = useState<StatusReport | null>(null)
  /** This environment's own dependency-graph edges, for the Health tab's blast
   *  radius -- read from its own published table, not DEV's rows. */
  const [healthGraph, setHealthGraph] = useState<GraphRow[]>([])
  /**
   * The S2T spec's procedure -> table mapping, which labels every stored-proc node
   * with the table it builds. Held here rather than in one view because the Health
   * and Lineage tabs open the *same* lineage popup, and a node must not be called
   * one thing on one tab and another on the other. Unlike the graph itself it is
   * not per-environment: it comes from DEV's HDX tables, which are the spec.
   */
  const [procs, setProcs] = useState<Map<string, ProcMapping>>(() => new Map())
  /** Null until the first /api/auth reply; gates the whole app. */
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [envs, setEnvs] = useState<EnvironmentInfo[]>([])
  /** Which environment the Health, Lineage and ERD tabs are showing. Editing
   *  is always DEV, on the separate graphEnv below. Defaults to PRD: read-only
   *  tabs are for seeing what's actually deployed, and that's the environment
   *  most worth checking on. */
  const [healthEnv, setHealthEnv] = useState('prd')
  const [statusLoading, setStatusLoading] = useState(true)
  /** A background poll is in flight — the previous report stays on screen. */
  const [statusRefreshing, setStatusRefreshing] = useState(false)
  const [statusFetchedAt, setStatusFetchedAt] = useState<number | null>(null)
  /** Why the last background poll failed, if it did. */
  const [statusError, setStatusError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  /** Live Fabric status for rows the table currently shows as Running, keyed
   *  by Process. A display overlay only -- severity keeps coming from the
   *  table's own Status/LastSuccess (health.ts), which this cannot supply.
   *  Entries are dropped once the table's own next write moves a row out of
   *  'Running', handing display back to the table. */
  const [liveStatus, setLiveStatus] = useState<Map<string, LiveJobStatus>>(new Map())

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)

  const [editing, setEditing] = useState<Editing>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Process whose rows are being activated/deactivated, so its buttons disable. */
  const [busyProcess, setBusyProcess] = useState<string | null>(null)
  /** Row group pending the "deactivate" confirmation, or null if none is open. */
  const [confirmingDeactivate, setConfirmingDeactivate] = useState<Row[] | null>(null)

  /**
   * Stand-in for the Entra role check that arrives with EasyAuth. Until that
   * lands this is a manual switch, so all five access levels can be exercised
   * — and demoed — without five separately-permissioned accounts.
   */
  const [previewRole, setPreviewRole] = useState<PreviewRole>('Admin')

  const [tab, setTab] = useState<Tab>('home')
  const activeTab = tab
  const [search, setSearch] = useState('')

  /**
   * Which environment's dependency-graph table the tab is reading and editing.
   *
   * This used to be a promotion-flag filter over DEV's rows -- 'DEV/QA', 'UAT',
   * 'PRD' meaning "the subset the orchestrator would run there". It now names a
   * real environment and re-reads that environment's own table, the way Health
   * and Lineage always have, so UAT shows what was actually deployed to UAT
   * rather than DEV's current flags. The promotion filter is still applied, but
   * server-side and by that environment's own rules.
   *
   * Kept separate from healthEnv: someone editing DEV should not have the table
   * they are editing change under them because they glanced at PRD's health.
   */
  const [graphEnv, setGraphEnv] = useState(EDIT_ENV)

  /** Whether the environment comparison is open. It fetches its own data, since
   *  the pair being compared is chosen inside it. */
  const [diffOpen, setDiffOpen] = useState(false)

  /** A write aimed outside DEV, held until it is confirmed. */
  const [pendingWrite, setPendingWrite] = useState<{
    changes: CrossEnvChange[]
    apply: () => Promise<void>
  } | null>(null)

  /**
   * Chat transcript lives here for the same reason, and one level more: it is
   * shared by two surfaces -- the MCP chat tab and the docked window at the
   * bottom-right of every tab -- so both show the same conversation rather than
   * two independent threads. An agent answer can take a minute, so holding this in
   * App also means a question asked before wandering off to Health is still
   * running, and still there, on the way back.
   */
  const oracleChat = useOracleMcpChat()

  /**
   * Reload one environment's rows and its validation together, so the table and
   * the warnings above it always describe the same read.
   *
   * `key` is explicit rather than closed over, for the same reason refreshStatus
   * takes one: a reload triggered by a save must land on the environment the save
   * went to, even if the selector has moved since.
   */
  const refresh = useCallback(async (key: string) => {
    setLoadError(null)
    try {
      const [nextRows, nextIssues] = await Promise.all([
        api.rows(key),
        api.validate(key),
      ])
      setRows(nextRows)
      setIssues(nextIssues)
    } catch (error) {
      setRows([])
      setIssues([])
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  /** Switch the Dependency Graph tab to another environment's table. */
  const selectGraphEnv = useCallback(
    (key: string) => {
      setGraphEnv(key)
      setLoading(true)
      void refresh(key)
    },
    [refresh],
  )

  /**
   * Execution status is fetched separately from the CRUD data: it reads a second
   * Lakehouse table and is slower, so a slow status read must not hold up the
   * table, and a failure there must not blank the rest of the app.
   */
  /**
   * `key` is always explicit, so this never closes over a stale environment.
   *
   * `background` marks an automatic poll rather than a user action. A background
   * failure keeps the last good report on screen and records the reason, instead of
   * blanking a dashboard someone is reading because one poll timed out. A
   * user-initiated failure does clear it, because showing DEV's numbers under a PRD
   * heading would be worse than showing nothing.
   */
  const refreshStatus = useCallback(async (key: string, background = false) => {
    if (background) setStatusRefreshing(true)
    else setStatusLoading(true)
    try {
      const [next, nextGraph] = await Promise.all([api.status(key), api.graph(key)])
      setReport(next)
      setHealthGraph(nextGraph)
      setStatusFetchedAt(Date.now())
      setStatusError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (background) {
        setStatusError(message)
      } else {
        setReport(null)
        setHealthGraph([])
        setNotice({
          kind: 'error',
          text: `Could not read execution status for ${key.toUpperCase()}: ${message}`,
        })
      }
    } finally {
      setStatusLoading(false)
      setStatusRefreshing(false)
    }
  }, [])

  /**
   * Reload the procedure -> table mapping. Kept out of `refreshStatus` so an
   * unreachable HDX table cannot fail a status poll: without this every node just
   * falls back to its process name, which is what the graph itself says.
   */
  const loadProcs = useCallback(async () => {
    try {
      setProcs(procMappings(await api.s2tProcedures()))
    } catch {
      /* labels fall back to process names */
    }
  }, [])

  useEffect(() => {
    void loadProcs()
  }, [loadProcs])

  /** Both tabs' Refresh buttons: the environment's graph, and the spec labelling it. */
  const refreshLineage = useCallback(() => {
    void refreshStatus(healthEnv)
    void loadProcs()
  }, [refreshStatus, healthEnv, loadProcs])

  const selectEnv = useCallback(
    (key: string) => {
      setHealthEnv(key)
      void refreshStatus(key)
    },
    [refreshStatus],
  )

  /** Everything the app needs once there is a usable token. */
  const loadAll = useCallback(() => {
    api.me().then(setIdentity).catch(() => {
      /* refresh() reports connectivity problems; no need to say it twice */
    })
    api.environments().then(setEnvs).catch(() => {
      /* the dashboard falls back to a single unlabelled environment */
    })
    void refresh(EDIT_ENV)
    void refreshStatus('prd')
  }, [refresh, refreshStatus])

  useEffect(() => {
    api
      .auth()
      .then((state) => {
        setAuth(state)
        if (state.signedIn) loadAll()
        else setLoading(false)
      })
      .catch(() =>
        setAuth({
          signedIn: false,
          name: null,
          username: null,
          reason: 'Cannot reach the HDX Management Tool backend.',
          signIn: { state: 'idle', method: null, deviceCode: null, error: null },
        }),
      )
  }, [loadAll])

  /**
   * Poll while an interactive sign-in is in flight. It completes in the browser, so
   * there is nothing to await here -- the server records the outcome and this picks
   * it up. Stops as soon as it resolves either way.
   */
  useEffect(() => {
    if (!auth || auth.signedIn || auth.signIn.state !== 'pending') return
    const timer = window.setInterval(() => {
      api
        .auth()
        .then((state) => {
          setAuth(state)
          if (state.signedIn) loadAll()
        })
        .catch(() => {
          /* keep polling; a transient failure is not an answer */
        })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [auth, loadAll])

  /**
   * Poll execution status while the Health or Lineage tab is open -- they share
   * one environment and one read, so either tab being visible is reason enough.
   *
   * Deliberately narrow: only on those tabs, only when the document is visible,
   * and never while a request is already in flight. The orchestrator writes
   * constantly — statuses moved repeatedly within a single session — so a
   * dashboard left open goes misleading fast; but polling a hidden tab or a tab
   * nobody is looking at just burns warehouse queries.
   */
  useEffect(() => {
    if ((tab !== 'status' && tab !== 'lineage') || !autoRefresh) return

    const tick = () => {
      if (document.hidden) return
      void refreshStatus(healthEnv, true)
    }
    const timer = window.setInterval(tick, STATUS_POLL_MS)
    // Catch up immediately when the tab is brought back into view.
    const onVisible = () => !document.hidden && tick()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [tab, autoRefresh, healthEnv, refreshStatus])

  // Read inside the live-poll interval below instead of as effect deps, so a
  // report/liveStatus update never tears down and restarts that interval
  // mid-cycle.
  const reportRef = useRef(report)
  useEffect(() => {
    reportRef.current = report
  }, [report])
  const liveStatusRef = useRef(liveStatus)
  useEffect(() => {
    liveStatusRef.current = liveStatus
  }, [liveStatus])

  /**
   * Poll Fabric's live job-instance status for whatever the table currently
   * shows as Running -- much faster than the table itself is written, and
   * narrow on purpose: fanning this out to every row would multiply Fabric API
   * calls for no benefit (severityOf/health.ts still needs LastSuccess
   * history, which a single job instance can't supply) and cost real
   * rate-limit budget.
   *
   * Stops polling a process once Fabric confirms a terminal status for it
   * (that detail is then immutable), but keeps the last result on screen
   * until the table itself moves the row out of 'Running' -- at which point
   * the overlay is dropped and the table's own Status takes back over.
   */
  useEffect(() => {
    if ((tab !== 'status' && tab !== 'lineage') || !autoRefresh) return

    let cancelled = false
    const tick = () => {
      if (cancelled || document.hidden) return
      const running = (reportRef.current?.rows ?? []).filter((r) => r.Status === 'Running')
      const runningNames = new Set(running.map((r) => r.Process))

      // Drop overlays for rows the table no longer shows as Running -- the
      // table's own write has caught up, so it owns the display again.
      setLiveStatus((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const key of next.keys()) {
          if (!runningNames.has(key)) {
            next.delete(key)
            changed = true
          }
        }
        return changed ? next : prev
      })

      const pending = running
        .map((r) => r.Process)
        .filter((name) => {
          const known = liveStatusRef.current.get(name)
          return !known || !known.status || !LIVE_TERMINAL.has(known.status)
        })
      if (pending.length === 0) return

      void Promise.all(
        pending.map((name) =>
          api
            .liveStatus(name, healthEnv)
            .then((live) => ({ name, live }))
            .catch(() => null),
        ),
      ).then((results) => {
        if (cancelled) return
        const fresh = results.filter(
          (r): r is { name: string; live: LiveJobStatus } => r !== null,
        )
        if (fresh.length === 0) return
        setLiveStatus((prev) => {
          const next = new Map(prev)
          for (const { name, live } of fresh) next.set(name, live)
          return next
        })
      })
    }

    tick() // catch up immediately on entering the tab, not just on the next tick
    const timer = window.setInterval(tick, LIVE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [tab, autoRefresh, healthEnv])

  /** Status by process name, for the Lineage health overlay. */
  const statusByProcess = useMemo(() => {
    const map = new Map<string, ProcessStatus>()
    for (const row of report?.rows ?? []) map.set(row.Process, row)
    return map
  }, [report])

  /** Badge on the Health tab, so a failure is visible from the other tabs. */
  const attentionCount = useMemo(
    () =>
      (report?.rows ?? []).filter((row) => {
        const severity = severityOf(row)
        return severity === 'critical' || severity === 'warning'
      }).length,
    [report],
  )

  const processNames = useMemo(
    () => [...new Set(rows.map((r) => r.Process))].sort((a, b) => a.localeCompare(b)),
    [rows],
  )

  const warehouseNames = useMemo(
    () =>
      [...new Set(rows.map((r) => r.WarehouseName).filter((n): n is string => !!n))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [rows],
  )

  const errorsByRow = useMemo(() => {
    const map = new Map<string, Issue[]>()
    for (const issue of issues) {
      if (issue.level !== 'error' || !issue.rowId) continue
      const list = map.get(issue.rowId)
      if (list) list.push(issue)
      else map.set(issue.rowId, [issue])
    }
    return map
  }, [issues])

  /** Non-blocking graph warnings -- shown only on the Dependency Graph tab,
   *  next to the rows they describe, rather than permanently on Home. */
  const warnings = useMemo(() => issues.filter((i) => i.level === 'warning'), [issues])

  // Search only: `rows` is already scoped to one environment by the read itself,
  // so there is nothing left to filter client-side.
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((row) =>
      `${row.Process} ${row.Dependency ?? ''} ${row.WarehouseName ?? ''}`
        .toLowerCase()
        .includes(needle),
    )
  }, [rows, search])

  const graphEnvInfo = useMemo(
    () => envs.find((option) => option.key === graphEnv),
    [envs, graphEnv],
  )
  const graphEnvLabel = graphEnvInfo?.label ?? graphEnv.toUpperCase()

  /** Environments every env-aware tab (Home, Dependency Graph, Health, Lineage,
   *  ERD) offers, narrowed to this role's VISIBLE_ENVS. Non HDX User only ever
   *  sees UAT and PRD here, regardless of what /api/environments returns. */
  const visibleEnvs = useMemo(() => {
    const scope = VISIBLE_ENVS[previewRole]
    return scope === 'all' ? envs : envs.filter((option) => scope.includes(option.key))
  }, [envs, previewRole])

  /**
   * Whether this user can edit the environment currently on screen.
   *
   * Two things have to hold: the environment's table can take DML (false for
   * one still reading a lakehouse copy), and this role's write scope
   * (GRAPH_WRITE_ENVS) has to include it. The server re-checks all of it on
   * every write; this only decides whether to offer the controls.
   *
   * Falls back to DEV-only when /api/environments could not be read, which is
   * how the tab behaved before any of this existed.
   */
  const envAcceptsEdits = graphEnvInfo ? graphEnvInfo.editable : graphEnv === EDIT_ENV
  const isAdmin = (identity?.isAdmin ?? false) || previewRole === 'Admin'
  const canEditGraph = envAcceptsEdits && envAllowed(GRAPH_WRITE_ENVS[previewRole], graphEnv)

  /** Why editing is unavailable here, or null when it is available. */
  const editBlockedReason = useMemo(() => {
    if (canEditGraph) return null
    if (!envAcceptsEdits) {
      return `${graphEnvLabel} is read-only: its dependency graph is a lakehouse copy, whose SQL endpoint cannot accept changes. It becomes editable once that environment moves to the warehouse orch schema.`
    }
    const writable = GRAPH_WRITE_ENVS[previewRole]
    if (writable !== 'all' && writable.length === 0) {
      return `${PREVIEW_ROLES.find((r) => r.key === previewRole)?.label ?? previewRole} does not edit the dependency graph.`
    }
    const authority = identity?.adminEnv ?? 'PRD'
    return `Editing ${graphEnvLabel} needs the Fabric Admin role on the ${authority} workspace. You can read it here, and edit DEV as usual.`
  }, [canEditGraph, envAcceptsEdits, graphEnvLabel, previewRole, identity?.adminEnv])

  // Losing the ability to edit the environment on screen -- by switching role or
  // by switching environment -- should not leave an edit dialog open behind it.
  useEffect(() => {
    if (canEditGraph) return
    setEditing(null)
    setConfirmingDeactivate(null)
  }, [canEditGraph])

  // Non HDX User only reads UAT and PRD. Dropping onto that role (or already
  // sitting on it) while some other tab's environment selector is on DEV/QA
  // moves both selectors to this role's default rather than leaving them on an
  // environment its own env-aware tabs no longer offer.
  useEffect(() => {
    const scope = VISIBLE_ENVS[previewRole]
    if (scope === 'all') return
    const fallback = DEFAULT_ENV[previewRole] ?? scope[0]
    if (fallback === undefined) return
    if (!scope.includes(graphEnv)) selectGraphEnv(fallback)
    if (!scope.includes(healthEnv)) selectEnv(fallback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRole])

  /**
   * Run a write, confirming it first when it is aimed outside DEV.
   *
   * DEV is a staging table people edit all day and is deliberately not
   * confirmed. Everywhere else the change is spelled out and acknowledged before
   * it lands, because it is a write into a deployed environment whose
   * orchestrator reads that table on its next run. An empty change list skips
   * the dialog: there is nothing to confirm.
   */
  const withCrossEnvConfirm = (changes: CrossEnvChange[], apply: () => Promise<void>) => {
    if (graphEnv === EDIT_ENV || changes.length === 0) {
      void apply()
      return
    }
    setPendingWrite({ changes, apply })
  }

  /**
   * `plan.creates` is one row per new dependency and `plan.updates` is one PUT
   * per existing row whose Dependency, Active state, or shared fields changed
   * -- run one at a time, not in parallel, so each create's cycle/validation
   * check sees whatever this same save already committed just before it.
   */
  const save = async (plan: SavePlan, target: string) => {
    setSaving(true)
    setSaveError(null)
    try {
      for (const input of plan.creates) {
        await api.create(input, target)
      }
      for (const { rowId, input } of plan.updates) {
        await api.update(rowId, input, target)
      }
      for (const rowId of plan.deletes) {
        await api.deleteRow(rowId, target)
      }
      const total = plan.creates.length + plan.updates.length
      const deleted = plan.deletes.length
      const deletedSuffix = deleted ? `, deleted ${deleted}` : ''
      setNotice({
        kind: 'success',
        text:
          editing === 'new'
            ? total > 1
              ? `Created ${plan.process} with ${total} dependencies.`
              : `Created ${plan.process}.`
            : `Saved ${plan.process} (${total} row${total === 1 ? '' : 's'}${deletedSuffix}).`,
      })
      setEditing(null)
      await refresh(target)
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : String(error))
      // Part of the plan may have already landed before the step that failed
      // -- refresh so the table reflects that, even though the form stays
      // open (with the error) for the rest.
      await refresh(target)
    } finally {
      setSaving(false)
    }
  }

  /** The save the form hands over, described for confirmation and then applied. */
  const onSave = (plan: SavePlan) => {
    const target = graphEnv
    const changes: CrossEnvChange[] = [
      ...plan.creates.map((input) => ({ action: 'Add', edge: edgeLabel(input) })),
      ...plan.updates.flatMap(({ rowId, input }) => {
        const before = rows.find((row) => row.RowId === rowId)
        const details = before ? fieldDiff(before, input) : []
        // A no-op update writes nothing server-side, so listing it as a change
        // would promise something that will not happen.
        if (before && details.length === 0) return []
        return [{ action: 'Update', edge: edgeLabel(before ?? input), details }]
      }),
      ...plan.deletes.map((rowId) => {
        const before = rows.find((row) => row.RowId === rowId)
        return { action: 'Remove', edge: before ? edgeLabel(before) : rowId }
      }),
    ]
    withCrossEnvConfirm(changes, () => save(plan, target))
  }

  /** Applies the confirmed active/restore toggle to every row in the group. */
  const applyActive = async (group: Row[], active: boolean, target: string) => {
    const process = group[0]?.Process ?? ''
    setBusyProcess(process)
    try {
      for (const row of group) {
        if (row.isActive !== active) await api.setActive(row.RowId, active, target)
      }
      setNotice({ kind: 'success', text: `${active ? 'Restored' : 'Deactivated'} ${process}.` })
      await refresh(target)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyProcess(null)
    }
  }

  /** Every row on file for a process, ignoring the table's current filters --
   *  used by both Edit and Deactivate/Restore so neither silently acts on
   *  less than the whole process just because a filter hid part of it. */
  const rowsForProcess = (process: string) =>
    rows.filter((r) => r.Process.toLowerCase() === process.toLowerCase())

  /** Restoring is non-destructive and applies immediately; deactivating a
   *  whole process is not, so it goes through the confirmation dialog first. */
  const onSetActive = (process: string, active: boolean) => {
    const group = rowsForProcess(process)
    const target = graphEnv

    if (target !== EDIT_ENV) {
      // One dialog rather than two: the cross-environment confirmation already
      // names every row it will touch, which is strictly more than the
      // deactivate confirmation says.
      withCrossEnvConfirm(
        group
          .filter((row) => row.isActive !== active)
          .map((row) => ({
            action: active ? 'Restore' : 'Deactivate',
            edge: edgeLabel(row),
            details: [`isActive: ${showValue(row.isActive)} → ${showValue(active)}`],
          })),
        () => applyActive(group, active, target),
      )
      return
    }

    if (!active) {
      setConfirmingDeactivate(group)
      return
    }
    void applyActive(group, true, target)
  }

  /**
   * readyForUAT/readyForProd are stored per row, but the table shows and ticks
   * them once per process, so a tick applies to every row on file for it --
   * otherwise a dependency row added after the flag was set would silently
   * read as not-ready. Mirrors applyActive: a dedicated single-field endpoint
   * per row rather than a full-row PUT.
   */
  const applyReady = async (
    group: Row[],
    field: 'readyForUAT' | 'readyForProd',
    value: boolean,
    target: string,
  ) => {
    const process = group[0]?.Process ?? ''
    setBusyProcess(process)
    try {
      for (const row of group) {
        if (row[field] !== value) await api.setReady(row.RowId, field, value, target)
      }
      setNotice({
        kind: 'success',
        text: `${process}: ${value ? 'marked' : 'unmarked'} ready for ${field === 'readyForUAT' ? 'UAT' : 'Prod'}.`,
      })
      await refresh(target)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof ApiError ? error.message : String(error) })
    } finally {
      setBusyProcess(null)
    }
  }

  const onToggleReady = (
    process: string,
    field: 'readyForUAT' | 'readyForProd',
    value: boolean,
  ) => {
    const group = rowsForProcess(process)
    const target = graphEnv
    withCrossEnvConfirm(
      group
        .filter((row) => row[field] !== value)
        .map((row) => ({
          action: `Set ${field}`,
          edge: edgeLabel(row),
          details: [`${field}: ${showValue(row[field])} → ${showValue(value)}`],
        })),
      () => applyReady(group, field, value, target),
    )
  }

  if (!auth) {
    return (
      <>
        <div className="brand-stripe" aria-hidden="true" />
        <div className="gate">
          <div className="gate-card panel">
            <img className="gate-logo" src="/logo.png" alt="" aria-hidden="true" />
            <h1>HDX Management Tool</h1>
            <p className="gate-sub">Connecting...</p>
          </div>
        </div>
      </>
    )
  }

  if (!auth.signedIn) {
    return (
      <>
        <div className="brand-stripe" aria-hidden="true" />
        <SignInGate
          status={auth}
          onAuthChange={setAuth}
          onSignedIn={() => {
            void api.auth().then(setAuth)
            loadAll()
            // Always land on Home after signing in, even for a mid-session
            // re-auth that happened while some other tab was open.
            setTab('home')
          }}
        />
      </>
    )
  }

  return (
    <>
    <div
      className={`brand-stripe${isAdmin ? ' brand-stripe--admin' : ''}`}
      aria-hidden="true"
    />
    {isAdmin && (
      <div
        className="admin-watermark"
        title={`You hold the Fabric Admin role on the ${identity?.adminEnv ?? 'PRD'} workspace, so you can edit the dependency graph in QA and UAT as well as DEV.`}
      >
        Admin
      </div>
    )}
    <div className="app">
      <div className="masthead">
        <h1>
          <img
            className="brand-mark"
            src="/logo.png"
            alt=""
            aria-hidden="true"
            onClick={toggleTheme}
          />
          {TABS.find((t) => t.key === activeTab)?.heading ?? 'HDX Management Tool'}
        </h1>

        <span
          className="picker"
          title="Testing only — stands in for the Entra role check that arrives with EasyAuth"
        >
          <span>View (testing)</span>
          <span className="segmented">
            {PREVIEW_ROLES.map((role) => (
              <button
                key={role.key}
                className={previewRole === role.key ? 'is-active' : undefined}
                title={role.hint}
                onClick={() => setPreviewRole(role.key)}
              >
                {role.label}
              </button>
            ))}
          </span>
        </span>

        <span className="who">
          <span className="who-name">
            {identity ? `${identity.name} · ${identity.username}` : 'signing in…'}
            <button
              className="pink-toggle"
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onClick={togglePink}
            />
          </span>
          {identity && (
            <button
              className="signout"
              title="Forget this account and sign in as someone else"
              onClick={() => setConfirmingSignOut(true)}
            >
              Sign out
            </button>
          )}
        </span>
      </div>

      <nav className="tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={activeTab === entry.key}
            className={activeTab === entry.key ? 'tab is-active' : 'tab'}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
            {entry.key === 'status' && report && attentionCount > 0 && (
              <span className="tab-badge" title={`${attentionCount} processes need attention`}>
                {attentionCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      {loadError && (
        <div className="notice error">
          <span>
            <strong>Could not load the dependency graph</strong>
            {loadError}
          </span>
          <button className="dismiss" onClick={() => void refresh(graphEnv)} title="Retry">
            ⟳
          </button>
        </div>
      )}

      {notice && (
        <div className={`notice ${notice.kind}`}>
          <span>{notice.text}</span>
          <button className="dismiss" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {activeTab === 'home' ? (
        <HomeView
          issues={issues}
          envs={visibleEnvs}
          onGoToHealth={(key) => {
            selectEnv(key)
            setTab('status')
          }}
        />
      ) : activeTab === 's2t' ? (
        <S2TView
          notify={(kind, text) => setNotice({ kind, text })}
          readOnly={!CAN_WRITE_S2T[previewRole]}
          canValidate={CAN_VALIDATE_S2T[previewRole]}
        />
      ) : activeTab === 'deployments' ? (
        <DeploymentsView
          notify={(kind, text) => setNotice({ kind, text })}
          readOnly={!CAN_WRITE_DEPLOYMENTS[previewRole]}
        />
      ) : activeTab === 'status' ? (
        <StatusDashboard
          report={report}
          rows={healthGraph}
          loading={statusLoading}
          refreshing={statusRefreshing}
          fetchedAt={statusFetchedAt}
          pollSeconds={STATUS_POLL_MS / 1000}
          autoRefresh={autoRefresh}
          onAutoRefreshChange={setAutoRefresh}
          backgroundError={statusError}
          liveStatus={liveStatus}
          envs={visibleEnvs}
          env={healthEnv}
          onEnvChange={selectEnv}
          canResetRetry={envAllowed(RETRY_RESET_ENVS[previewRole], healthEnv)}
          onRefresh={refreshLineage}
          procs={procs}
        />
      ) : activeTab === 'monitoring' ? (
        <MonitoringView />
      ) : activeTab === 'erd' ? (
        <ERDView
          notify={(kind, text) => setNotice({ kind, text })}
          envs={visibleEnvs}
          env={healthEnv}
          onEnvChange={selectEnv}
        />
      ) : activeTab === 'lineage' ? (
        <LineageView
          envs={visibleEnvs}
          env={healthEnv}
          onEnvChange={selectEnv}
          rows={healthGraph}
          statusByProcess={statusByProcess}
          loading={statusLoading}
          onRefresh={refreshLineage}
          procs={procs}
        />
      ) : (
      <>
      {warnings.length > 0 && (
        <details className="panel">
          <summary>
            {warnings.length} warning{warnings.length === 1 ? '' : 's'} — not blocking
          </summary>
          <div className="panel-body">
            <ul className="issues">
              {warnings.map((issue, index) => (
                <li key={index}>
                  <span className="level warning">warn</span>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      <EnvBar
        envs={visibleEnvs}
        env={graphEnv}
        onEnvChange={selectGraphEnv}
        loading={loading}
      />

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Search process, dependency or warehouse…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        {CAN_COMPARE_ENVS[previewRole] && (
          <button
            onClick={() => setDiffOpen(true)}
            title="Compare two environments' dependency-graph tables, row by row"
            style={{ marginLeft: 'auto' }}
          >
            Compare environments
          </button>
        )}

        <button
          onClick={() => void refresh(graphEnv)}
          disabled={loading}
          style={CAN_COMPARE_ENVS[previewRole] ? undefined : { marginLeft: 'auto' }}
        >
          Refresh
        </button>
        {canEditGraph && (
          <button className="primary" onClick={() => setEditing('new')}>
            New process
          </button>
        )}

        <span className="count" style={{ marginLeft: 0 }}>
          {loading ? 'loading…' : `${visible.length} of ${rows.length} rows`}
        </span>
      </div>

      <p className="env-hint">
        Reading {graphEnvLabel}'s own dependency-graph table
        {graphEnv === EDIT_ENV
          ? ' — the one the orchestrator reads, and the one edits are written to.'
          : `, as deployed to ${graphEnvLabel} rather than DEV's rows re-filtered by promotion flags.`}
        {editBlockedReason && <span className="muted"> {editBlockedReason}</span>}
      </p>

      {loading && !rows.length ? (
        <div className="table-scroll">
          <div className="empty">Loading {graphEnvLabel}…</div>
        </div>
      ) : (
        <RowTable
          rows={visible}
          errorsByRow={errorsByRow}
          busyProcess={busyProcess}
          onEdit={(process) => setEditing(rowsForProcess(process))}
          onSetActive={onSetActive}
          onToggleReady={onToggleReady}
          readOnly={!canEditGraph}
        />
      )}
      </>
      )}

      {editing && (
        <RowForm
          group={editing === 'new' ? null : editing}
          processNames={processNames}
          warehouseNames={warehouseNames}
          saving={saving}
          error={saveError}
          onSave={onSave}
          onCancel={() => {
            setEditing(null)
            setSaveError(null)
          }}
        />
      )}

      {confirmingDeactivate && (
        <ConfirmDialog
          title="Deactivate process"
          message={
            confirmingDeactivate.length > 1
              ? `Deactivate ${confirmingDeactivate[0]?.Process} and all ${confirmingDeactivate.length} ` +
                'of its dependencies?\n\nThe rows are kept and stay auditable; the orchestrator will ' +
                'skip them. You can restore them at any time.'
              : `Deactivate ${confirmingDeactivate[0]?.Process}` +
                (confirmingDeactivate[0]?.Dependency ? ` -> ${confirmingDeactivate[0].Dependency}` : '') +
                '?\n\nThe row is kept and stays auditable; the orchestrator will skip it. You can ' +
                'restore it at any time.'
          }
          confirmLabel="Deactivate"
          danger
          onConfirm={() => {
            const group = confirmingDeactivate
            setConfirmingDeactivate(null)
            // Only reachable for DEV: onSetActive routes every other environment
            // through the cross-environment confirmation instead.
            if (group) void applyActive(group, false, EDIT_ENV)
          }}
          onCancel={() => setConfirmingDeactivate(null)}
        />
      )}

      {diffOpen && (
        <GraphDiffModal
          envs={visibleEnvs}
          initialRight={graphEnv}
          // Stricter than editing DEV: copying rows between environments is
          // Admin-only wherever it points.
          canReconcile={CAN_RECONCILE[previewRole]}
          onClose={() => {
            setDiffOpen(false)
            // A copy from the modal may have changed the table underneath it.
            void refresh(graphEnv)
          }}
        />
      )}

      {pendingWrite && (
        <CrossEnvConfirm
          envLabel={graphEnvLabel}
          changes={pendingWrite.changes}
          onConfirm={() => {
            const write = pendingWrite
            setPendingWrite(null)
            void write.apply()
          }}
          onCancel={() => setPendingWrite(null)}
        />
      )}

      {confirmingSignOut && (
        <ConfirmDialog
          title="Sign out"
          message="Sign out of HDX Management Tool on this machine?"
          confirmLabel="Sign out"
          danger
          onConfirm={() => {
            setConfirmingSignOut(false)
            void api.signOut().then(() => api.auth().then(setAuth))
          }}
          onCancel={() => setConfirmingSignOut(false)}
        />
      )}

      {/* The only way into the chat: pinned bottom-right on every tab, so the
          agent is reachable without leaving the table, diagram or dashboard you
          are working in. Every role can at least read S2T and the Dependency
          Graph now, so none of them is withheld from asking about them.

          Off for v1 -- see MCP_CHAT_ENABLED in ChatSurface.tsx. */}
      {MCP_CHAT_ENABLED && <OracleMCPChatDock chat={oracleChat} />}
    </div>
    </>
  )
}
