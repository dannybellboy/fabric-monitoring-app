import { useEffect, useState } from 'react'

import { api } from '../api'
import { healthSummary } from '../health'
import type { EnvironmentInfo, Issue, StatusReport } from '../types'
import HealthPanel from './HealthPanel'

interface Props {
  issues: Issue[]
  envs: EnvironmentInfo[]
  onGoToHealth: (env: string) => void
}

interface Snapshot {
  report: StatusReport | null
  loading: boolean
  error: string | null
}

type Tone = 'critical' | 'warning' | 'good' | 'info'

/** One KPI tile's own tone, independent of every other tile on the card --
 *  a card can show a red "Failing" tile next to a green "Healthy" tile. */
function tile(label: string, value: number, tone: Tone) {
  return (
    <div className={`kpi kpi--${tone}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  )
}

/**
 * Landing page. Carries what used to sit permanently under the masthead on
 * every tab (graph problems) plus a glance at process health for every
 * environment, so those are seen once on arrival instead of crowding every
 * other screen.
 */
export default function HomeView({ issues, envs, onGoToHealth }: Props) {
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})

  /**
   * One read per configured environment, independent of whichever environment
   * the Health/Lineage tabs currently have selected -- this is a snapshot of
   * everywhere at once, fetched fresh each time Home is opened.
   */
  useEffect(() => {
    for (const env of envs) {
      if (!env.configured) continue
      setSnapshots((current) => ({
        ...current,
        [env.key]: { report: current[env.key]?.report ?? null, loading: true, error: null },
      }))
      api
        .status(env.key)
        .then((report) =>
          setSnapshots((current) => ({ ...current, [env.key]: { report, loading: false, error: null } })),
        )
        .catch((e) =>
          setSnapshots((current) => ({
            ...current,
            [env.key]: {
              report: null,
              loading: false,
              error: e instanceof Error ? e.message : String(e),
            },
          })),
        )
    }
  }, [envs])

  return (
    <>
      <HealthPanel issues={issues} />

      {/* PRD first, then working back down toward DEV -- the environments that
          matter most if something's wrong sit at the top. */}
      <div className="env-snapshots">
        {[...envs].reverse().map((env) => {
          const snapshot = snapshots[env.key]
          const summary =
            snapshot?.report ? healthSummary(snapshot.report.rows, snapshot.report.untracked) : null
          const untracked = summary ? summary.orphaned + summary.untracked : 0

          return (
            <section className="panel env-snapshot" key={env.key}>
              <div className="panel-head">
                <h3>{env.label}</h3>
                <div className="panel-actions">
                  <button
                    onClick={() => onGoToHealth(env.key)}
                    disabled={!env.configured}
                    title={
                      env.configured
                        ? `Open the full ${env.label} health dashboard`
                        : `${env.label} is not configured yet`
                    }
                  >
                    View full health dashboard
                  </button>
                </div>
              </div>

              {!env.configured ? (
                <div className="panel-body">
                  <p className="muted" style={{ margin: 0 }}>
                    Not configured yet — add its workspace id in server/config.json.
                  </p>
                </div>
              ) : summary ? (
                <div className="kpi-row env-snapshot-kpis">
                  {tile(
                    'Needs attention',
                    summary.needsAttention,
                    summary.bySeverity.critical > 0
                      ? 'critical'
                      : summary.bySeverity.warning > 0
                        ? 'warning'
                        : 'good',
                  )}
                  {tile('Failing', summary.bySeverity.critical, summary.bySeverity.critical > 0 ? 'critical' : 'good')}
                  {tile('Stale', summary.bySeverity.warning, summary.bySeverity.warning > 0 ? 'warning' : 'good')}
                  {tile('Healthy', summary.bySeverity.good, summary.bySeverity.good > 0 ? 'good' : 'info')}
                  {tile('Untracked', untracked, untracked > 0 ? 'info' : 'good')}
                  <span className="muted env-snapshot-note">{summary.total} tracked</span>
                </div>
              ) : (
                <div className="panel-body">
                  <p className="muted" style={{ margin: 0 }}>
                    {snapshot?.error
                      ? `Could not read execution status: ${snapshot.error}`
                      : 'Loading process health…'}
                  </p>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}
