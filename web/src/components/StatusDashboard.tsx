import { useEffect, useMemo, useState } from 'react'

import ConfirmDialog from './ConfirmDialog'
import EnvBar from './EnvBar'
import FailureModal from './FailureModal'
import LineageFocus from './LineageFocus'
import { api } from '../api'
import { buildGraph, lineageOf } from '../lineage'
import type { ProcMapping } from '../lineage'
import {
  AGE_BUCKETS,
  SEVERITY_DESCRIPTION,
  SEVERITY_ICON,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  STALE_DAYS,
  bucketOf,
  healthSummary,
  relativeAge,
  severityOf,
} from '../health'
import type { Severity } from '../health'
import type { EnvironmentInfo, GraphRow, LiveJobStatus, ProcessStatus, StatusReport } from '../types'

interface Props {
  report: StatusReport | null
  /** This environment's own dependency-graph edges, for downstream blast radius. */
  rows: GraphRow[]
  loading: boolean
  /** A background poll is in flight; the current report is still valid. */
  refreshing: boolean
  /** Wall-clock ms of the last successful read, for the "updated Xs ago" line. */
  fetchedAt: number | null
  pollSeconds: number
  autoRefresh: boolean
  onAutoRefreshChange: (on: boolean) => void
  /** Why the last background poll failed, if it did. */
  backgroundError: string | null
  /** Live Fabric status for rows the table shows as Running, from App.tsx's
   *  fast poll. Purely a display overlay -- severity keeps coming from the
   *  table's own Status/LastSuccess (health.ts), which this cannot supply. */
  liveStatus: Map<string, LiveJobStatus>
  envs: EnvironmentInfo[]
  env: string
  onEnvChange: (key: string) => void
  /** Whether this role may reset a retry count in the environment currently on
   *  screen (`env`), resolved by App.tsx from its RETRY_RESET_ENVS. */
  canResetRetry: boolean
  onRefresh: () => void
  /** Procedure -> table it builds. Only used by the lineage popup this shares
   *  with the Lineage tab, so a node is named the same thing on both. */
  procs: Map<string, ProcMapping>
}

/** "just now" / "34s ago" / "4m ago" — the age of the data on screen. */
function ago(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

type Filter = 'attention' | Severity | 'all'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'all', label: 'All processes' },
  { key: 'critical', label: 'Failing' },
  { key: 'warning', label: 'Stale' },
  { key: 'good', label: 'Healthy' },
  { key: 'unknown', label: 'Unknown' },
  { key: 'inactive', label: 'Deactivated' },
  { key: 'orphaned', label: 'Orphaned' },
]

/** Status pill: coloured dot + icon + text. Never colour alone. */
function Pill({ severity }: { severity: Severity }) {
  return (
    <span className={`pill pill--${severity}`} title={SEVERITY_DESCRIPTION[severity]}>
      <span className="pill-icon" aria-hidden="true">
        {SEVERITY_ICON[severity]}
      </span>
      {SEVERITY_LABEL[severity]}
    </span>
  )
}

export default function StatusDashboard({
  report,
  rows,
  loading,
  refreshing,
  fetchedAt,
  pollSeconds,
  autoRefresh,
  onAutoRefreshChange,
  backgroundError,
  liveStatus,
  envs,
  env,
  onEnvChange,
  canResetRetry,
  onRefresh,
  procs,
}: Props) {
  /** Ticks once a second purely so the "updated Xs ago" label stays honest. */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const [filter, setFilter] = useState<Filter>('attention')
  const [search, setSearch] = useState('')
  const [focus, setFocus] = useState<string | null>(null)
  const [trail, setTrail] = useState<string[]>([])
  const [showCoverage, setShowCoverage] = useState(false)
  /** Process whose failure detail is open. */
  const [why, setWhy] = useState<string | null>(null)
  /** Process whose retry-count reset is awaiting confirmation. */
  const [resetTarget, setResetTarget] = useState<string | null>(null)
  /** Process whose reset is in flight — its button shows as busy meanwhile. */
  const [resetting, setResetting] = useState<string | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)

  const graph = useMemo(() => buildGraph(rows, procs), [rows, procs])

  /** Transitive downstream count — the blast radius of a failure. */
  const downstreamCount = useMemo(() => {
    const counts = new Map<string, number>()
    for (const name of graph.nodes.keys()) {
      counts.set(name, lineageOf(graph, name).descendants.size)
    }
    return counts
  }, [graph])

  const statusRows = report?.rows ?? []

  /** Keyed for the lineage popup's health overlay -- the same shape App.tsx
   *  builds for the Lineage tab's own diagram, just scoped to this report. */
  const statusByProcess = useMemo(() => {
    const map = new Map<string, ProcessStatus>()
    for (const row of statusRows) map.set(row.Process, row)
    return map
  }, [statusRows])

  const summary = useMemo(
    () => healthSummary(statusRows, report?.untracked ?? []),
    [statusRows, report],
  )

  const ranked = useMemo(() => {
    const weight: Record<Severity, number> = {
      critical: 0,
      warning: 1,
      unknown: 2,
      good: 3,
      inactive: 4,
      // Least actionable of all: not just off, but not even real any more.
      orphaned: 5,
    }
    return [...statusRows].sort((a, b) => {
      const bySeverity = weight[severityOf(a)] - weight[severityOf(b)]
      if (bySeverity !== 0) return bySeverity
      // Never-succeeded is worse than any number of days.
      if ((a.LastSuccess === null) !== (b.LastSuccess === null)) {
        return a.LastSuccess === null ? -1 : 1
      }
      const byAge = (b.daysSinceSuccess ?? 0) - (a.daysSinceSuccess ?? 0)
      if (byAge !== 0) return byAge
      // Then by how much depends on it, so the widest blast radius floats up.
      const byBlast = (downstreamCount.get(b.Process) ?? 0) - (downstreamCount.get(a.Process) ?? 0)
      return byBlast || a.Process.localeCompare(b.Process)
    })
  }, [statusRows, downstreamCount])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return ranked.filter((row) => {
      if (needle && !row.Process.toLowerCase().includes(needle)) return false
      const severity = severityOf(row)
      if (filter === 'all') return true
      if (filter === 'attention') return severity === 'critical' || severity === 'warning'
      return severity === filter
    })
  }, [ranked, filter, search])

  const buckets = useMemo(() => {
    // Buckets cover failing processes only — bucketing healthy ones by age would
    // put "Within 7 days" next to "Never succeeded" and flatten the point.
    const failing = statusRows.filter((row) => severityOf(row) === 'critical')
    return AGE_BUCKETS.map((bucket) => ({
      ...bucket,
      count: failing.filter((row) => bucketOf(row).key === bucket.key).length,
    }))
  }, [statusRows])

  const bucketMax = Math.max(1, ...buckets.map((b) => b.count))

  const current = envs.find((e) => e.key === env)

  /**
   * Resetting a retry count writes to ProcessExecutionStatus, which belongs to
   * the orchestrator, so it takes two separate things.
   *
   * `statusWritable` is the table's own capability -- false where the status
   * table is a read-only lakehouse copy. Following the server's flag rather
   * than testing for DEV by name keeps that decision in one place.
   *
   * Permission is the second, and App.tsx has already resolved it for the
   * environment currently on screen (`canResetRetry`) from this role's
   * RETRY_RESET_ENVS. The server enforces both again.
   */
  const canReset = (current?.statusWritable ?? false) && canResetRetry

  async function resetRetries(process: string) {
    setResetTarget(null)
    setResetting(process)
    setResetError(null)
    try {
      await api.resetRetryCount(process, env)
      // The table is the source of truth for what the orchestrator will do next,
      // so re-read it rather than patching the count in local state.
      onRefresh()
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err))
    } finally {
      setResetting(null)
    }
  }

  /**
   * Rendered in every branch, including the error and loading states -- if PRD
   * cannot be read you must still be able to switch back to something that can.
   */
  const envBar = (
    <EnvBar envs={envs} env={env} onEnvChange={onEnvChange} loading={loading}>
      <label className="check check--inline" style={{ marginLeft: 'auto' }}>
        <input
          type="checkbox"
          checked={autoRefresh}
          onChange={(e) => onAutoRefreshChange(e.target.checked)}
        />
        <span>Auto-refresh</span>
      </label>

      <span className="freshness" aria-live="polite">
        {refreshing ? (
          <span className="muted">refreshing…</span>
        ) : fetchedAt ? (
          <>
            updated {ago(now - fetchedAt)}
            {autoRefresh && <span className="muted"> · every {pollSeconds}s</span>}
          </>
        ) : (
          <span className="muted">not loaded</span>
        )}
      </span>
    </EnvBar>
  )

  if (!report) {
    return (
      <>
        {envBar}
        <div className="table-scroll">
          <div className="empty">
            {loading
              ? `Loading ${current?.label ?? ''} execution status…`
              : `Execution status for ${current?.label ?? 'this environment'} is unavailable.`}
          </div>
        </div>
      </>
    )
  }

  const total = summary.total || 1
  const segments = SEVERITY_ORDER.map((severity) => ({
    severity,
    count: summary.bySeverity[severity],
    percent: (summary.bySeverity[severity] / total) * 100,
  })).filter((segment) => segment.count > 0)

  return (
    <>
      {envBar}

      {backgroundError && (
        <div className="notice warning">
          <span>
            <strong>Auto-refresh failed — showing the last good read</strong>
            {backgroundError}
          </span>
          <button className="dismiss" onClick={onRefresh} title="Try again now">
            ⟳
          </button>
        </div>
      )}

      {resetError && (
        <div className="notice warning">
          <span>
            <strong>Could not reset the retry count</strong>
            {resetError}
          </span>
          <button
            className="dismiss"
            onClick={() => setResetError(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Held at reduced opacity during a poll rather than replaced by a skeleton:
          no layout jump, and the numbers stay readable while they update. */}
      <div className={refreshing ? 'is-refreshing' : undefined}>

      {/* ---------- hero + KPI row ---------- */}
      <section className="dash-hero panel">
        <div className="hero-figure">
          <span className="hero-value">{summary.needsAttention}</span>
          <span className="hero-label">
            {summary.needsAttention === 1 ? 'process needs' : 'processes need'} attention
          </span>
          <span className="hero-sub">
            of {summary.total} tracked · {summary.bySeverity.good} healthy
            {summary.running > 0 && ` · ${summary.running} running now`}
          </span>
        </div>

        <div className="kpi-row">
          <div className="kpi">
            <span className="kpi-label">Failing</span>
            <span className="kpi-value">{summary.bySeverity.critical}</span>
            <span className="kpi-note">
              {summary.neverSucceeded > 0
                ? `${summary.neverSucceeded} never succeeded`
                : 'last run failed'}
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Stale</span>
            <span className="kpi-value">{summary.bySeverity.warning}</span>
            <span className="kpi-note">no success in {STALE_DAYS}+ days</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Healthy</span>
            <span className="kpi-value">{summary.bySeverity.good}</span>
            <span className="kpi-note">succeeded recently</span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Untracked rows</span>
            <span className="kpi-value">{summary.orphaned + summary.untracked}</span>
            <span className="kpi-note">
              {summary.orphaned} orphaned · {summary.untracked} never run
            </span>
          </div>
        </div>
      </section>

      {summary.worst && (
        <div className="notice error">
          <span>
            <strong>
              Longest outage
              <button
                className="link"
                style={{ marginLeft: 8, fontWeight: 400 }}
                onClick={() => setWhy(summary.worst!.Process)}
              >
                why did it fail?
              </button>
            </strong>
            <code>{summary.worst.Process}</code> last succeeded{' '}
            {relativeAge(summary.worst.daysSinceSuccess, summary.worst.hoursSinceRun)}
            {summary.worst.RetryCount ? ` after ${summary.worst.RetryCount} retries` : ''}
            {(downstreamCount.get(summary.worst.Process) ?? 0) > 0 &&
              ` — ${downstreamCount.get(summary.worst.Process)} downstream process(es) depend on it`}
            .
          </span>
        </div>
      )}

      {/* ---------- charts ---------- */}
      <div className="dash-charts">
        <section className="panel chart-card">
          <header className="chart-head">
            <h3>Health distribution</h3>
            <p>Every tracked process, by severity. Tiers are exclusive.</p>
          </header>

          <div className="stack-bar" role="img" aria-label="Health distribution">
            {segments.map((segment) => (
              <div
                key={segment.severity}
                className={`stack-seg stack-seg--${segment.severity}`}
                style={{ width: `${segment.percent}%` }}
                title={`${SEVERITY_LABEL[segment.severity]}: ${segment.count} of ${summary.total} (${segment.percent.toFixed(1)}%)`}
              >
                {/* Only label in-segment when the text genuinely fits, never clipped. */}
                {segment.percent >= 12 && (
                  <span className="stack-seg-label">{segment.count}</span>
                )}
              </div>
            ))}
          </div>

          <ul className="chart-legend">
            {segments.map((segment) => (
              <li key={segment.severity}>
                <i className={`swatch swatch--${segment.severity}`} aria-hidden="true" />
                <span className="legend-label">{SEVERITY_LABEL[segment.severity]}</span>
                <span className="legend-value">{segment.count}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel chart-card">
          <header className="chart-head">
            <h3>How long has it been failing?</h3>
            <p>Failing processes by time since their last success.</p>
          </header>

          {summary.bySeverity.critical === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              Nothing is failing.
            </p>
          ) : (
            <ul className="age-bars">
              {buckets.map((bucket, index) => (
                <li key={bucket.key}>
                  <span className="age-label">{bucket.label}</span>
                  <span className="age-track">
                    <span
                      className="age-fill"
                      data-step={index}
                      style={{ width: `${(bucket.count / bucketMax) * 100}%` }}
                      title={`${bucket.label}: ${bucket.count} process(es)`}
                    />
                  </span>
                  <span className="age-value">{bucket.count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ---------- triage table ---------- */}
      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Search a process…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="segmented">
          {FILTERS.map((option) => (
            <button
              key={option.key}
              className={filter === option.key ? 'is-active' : undefined}
              onClick={() => setFilter(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
        <span className="count">
          {current?.label ?? report.env.toUpperCase()} · {visible.length} of{' '}
          {summary.total} · read at {report.generatedAt.slice(11, 16)} UTC
        </span>
      </div>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 96 }}>Health</th>
              <th>Process</th>
              <th>Last success</th>
              <th>Last run</th>
              <th style={{ width: 64 }}>Retries</th>
              <th style={{ width: 96 }}>Downstream</th>
              <th style={{ width: 120 }}>Promoted</th>
              <th style={{ width: 74 }} />
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const severity = severityOf(row)
              const blast = downstreamCount.get(row.Process) ?? 0
              return (
                <tr key={row.Process}>
                  <td>
                    <Pill severity={severity} />
                  </td>

                  <td className="name">
                    <button className="link" onClick={() => setFocus(row.Process)}>
                      {row.Process}
                    </button>
                    <div className="row-meta">
                      {row.Status === 'Running' &&
                        (() => {
                          const live = liveStatus.get(row.Process)
                          if (!live?.status || live.status === 'NotStarted' || live.status === 'InProgress') {
                            return <span className="badge on">RUNNING NOW</span>
                          }
                          // Naive UTC from the server (see relativeAge in health.ts) -- the
                          // trailing Z forces Date to read it as UTC instead of local time,
                          // which matters here because it is compared against a real epoch
                          // (`now`), not just differenced against another naive timestamp.
                          const endedAt = live.endTimeUtc ? new Date(`${live.endTimeUtc}Z`).getTime() : null
                          return (
                            <span
                              className={live.status === 'Failed' ? 'badge off' : 'badge'}
                              title={
                                `Fabric reports this run ${live.status} -- the status table ` +
                                "hasn't caught up yet; it writes on its own ~20-minute schedule."
                              }
                            >
                              {live.status.toUpperCase()}
                              {endedAt !== null && ` ${ago(now - endedAt)}`}
                            </span>
                          )
                        })()}
                      {!row.inGraph && (
                        <span
                          className="badge off"
                          title={
                            blast > 0
                              ? 'No row of its own in the dependency graph, so the orchestrator has nothing to run for it — even though other processes list it as a dependency.'
                              : "No row in the orchestrator's dependency graph — usually left behind by a rename or a removal."
                          }
                        >
                          {blast > 0 ? 'NO GRAPH ROW' : 'NOT IN GRAPH'}
                        </span>
                      )}
                      {row.Status && row.Status !== 'Running' && (
                        <span className="muted">{row.Status}</span>
                      )}
                    </div>
                  </td>

                  <td
                    className={row.LastSuccess === null ? 'age-never' : 'muted'}
                    title={row.LastSuccess ?? 'never succeeded'}
                  >
                    {row.LastSuccess === null
                      ? 'never'
                      : relativeAge(row.daysSinceSuccess, null)}
                  </td>

                  <td className="muted" title={row.LastRunTime ?? ''}>
                    {relativeAge(
                      row.hoursSinceRun !== null && row.hoursSinceRun >= 24
                        ? Math.floor(row.hoursSinceRun / 24)
                        : null,
                      row.hoursSinceRun,
                    )}
                  </td>

                  <td className="muted num">
                    <span className="retry-cell">
                      {row.RetryCount ?? '—'}
                      {/* Nothing to reset when the count is already 0 or unset. */}
                      {canReset && (row.RetryCount ?? 0) > 0 && (
                        <button
                          className="retry-reset"
                          onClick={() => setResetTarget(row.Process)}
                          disabled={resetting !== null}
                          title="Set this process's RetryCount back to 0 so the orchestrator will attempt it again"
                        >
                          {resetting === row.Process ? '…' : '↺'}
                        </button>
                      )}
                    </span>
                  </td>

                  <td className="num" title={`${blast} process(es) transitively depend on this`}>
                    {blast > 0 ? blast : <span className="muted">—</span>}
                  </td>

                  <td>
                    <div className="flags">
                      {row.readyForUAT && <span className="badge on">UAT</span>}
                      {row.readyForProd && <span className="badge on">PRD</span>}
                      {row.inGraph && !row.readyForUAT && !row.readyForProd && (
                        <span className="badge">DEV</span>
                      )}
                    </div>
                  </td>

                  <td className="actions">
                    {/* Only offered where there is a failure to explain. */}
                    {severity === 'critical' && (
                      <button
                        onClick={() => setWhy(row.Process)}
                        title="Read the failure detail from the Fabric API"
                      >
                        Why?
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="empty">No processes match this filter.</div>
        )}
      </div>

      {/* ---------- coverage ---------- */}
      {(summary.orphaned > 0 || summary.untracked > 0) && (
        <details
          className="panel"
          open={showCoverage}
          onToggle={(e) => setShowCoverage((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>
            Coverage gaps — {summary.orphaned} orphaned status row
            {summary.orphaned === 1 ? '' : 's'}, {summary.untracked} process
            {summary.untracked === 1 ? '' : 'es'} never tracked
          </summary>
          <div className="panel-body">
            <p className="muted" style={{ marginTop: 0 }}>
              Nothing prunes ProcessExecutionStatus when a process is renamed or removed,
              so orphaned rows accumulate. They are counted above but are not part of the
              dependency graph.
            </p>
            <div className="focus-lists">
              <div>
                <h3>Status rows not in the graph ({summary.orphaned})</h3>
                <div className="chips">
                  {statusRows
                    .filter((row) => !row.inGraph)
                    .map((row) => (
                      <span key={row.Process} className="chip">
                        {row.Process}
                      </span>
                    ))}
                </div>
              </div>
              <div>
                <h3>In the graph, never run ({summary.untracked})</h3>
                <div className="chips">
                  {report.untracked.map((name) => (
                    <button key={name} className="chip" onClick={() => setFocus(name)}>
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </details>
      )}

      {focus && graph.nodes.has(focus) && (
        <LineageFocus
          graph={graph}
          focus={focus}
          trail={trail}
          statusByProcess={statusByProcess}
          onFocus={(name) => {
            setTrail((current) => [...current, focus])
            setFocus(name)
          }}
          onBack={() =>
            setTrail((current) => {
              if (!current.length) return current
              setFocus(current[current.length - 1])
              return current.slice(0, -1)
            })
          }
          onClose={() => {
            setFocus(null)
            setTrail([])
          }}
        />
      )}

      </div>

      {why && (
        <FailureModal process={why} env={env} onClose={() => setWhy(null)} />
      )}

      {resetTarget && (
        <ConfirmDialog
          title="Reset retry count?"
          message={
            `Sets RetryCount back to 0 for ${resetTarget} in ${current?.label ?? env.toUpperCase()}, ` +
            'so the orchestrator will attempt it again on its next run.\n\n' +
            'This writes to ProcessExecutionStatus, which the orchestrator owns. ' +
            'Nothing else on the row changes — its status and timestamps stay as they are.'
          }
          confirmLabel="Reset"
          onConfirm={() => void resetRetries(resetTarget)}
          onCancel={() => setResetTarget(null)}
        />
      )}

      {focus && !graph.nodes.has(focus) && (
        <div className="backdrop" onMouseDown={() => setFocus(null)}>
          <div className="dialog" role="dialog" aria-modal="true">
            <header>
              <h2>{focus}</h2>
              <p>Not in the dependency graph</p>
            </header>
            <div className="body">
              <p>
                This process has an execution-status row but no row in the orchestrator's
                dependency graph, so it has no lineage to show. It was most likely renamed
                or removed, leaving its status behind.
              </p>
            </div>
            <footer>
              <button onClick={() => setFocus(null)}>Close</button>
            </footer>
          </div>
        </div>
      )}
    </>
  )
}
