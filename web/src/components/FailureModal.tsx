import { useEffect, useState } from 'react'

import { ApiError, api } from '../api'
import type { ActivityRun, FailureDetail } from '../types'

interface Props {
  process: string
  /** Environment whose workspace owns the run being described. */
  env: string
  onClose: () => void
}

/** Activity status -> the severity styling already defined for pills. */
function statusClass(status: string | null): string {
  if (status === 'Failed') return 'critical'
  if (status === 'Succeeded') return 'good'
  if (status === 'Inactive' || status === 'Skipped') return 'inactive'
  return 'unknown'
}

function duration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null
  // Both are naive UTC from the server, so parsing both the same way makes the
  // difference correct even though each individually reads as local time.
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function ActivityRow({ activity }: { activity: ActivityRun }) {
  const severity = statusClass(activity.status)
  return (
    <li>
      <span className={`pill pill--${severity}`}>
        <span className="pill-icon" aria-hidden="true">
          {activity.status === 'Failed' ? '✕' : activity.status === 'Succeeded' ? '✓' : '–'}
        </span>
        {activity.status ?? 'Unknown'}
      </span>
      <span className="act-name">
        {activity.name}
        {activity.type && <span className="muted"> · {activity.type}</span>}
      </span>
      <span className="muted act-dur">{duration(activity.start, activity.end) ?? ''}</span>
    </li>
  )
}

export default function FailureModal({ process, env, onClose }: Props) {
  const [detail, setDetail] = useState<FailureDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    setDetail(null)
    setError(null)
    api
      .failure(process, env)
      .then((result) => live && setDetail(result))
      .catch((exception) =>
        live &&
        setError(exception instanceof ApiError ? exception.message : String(exception)),
      )
    return () => {
      live = false
    }
  }, [process, env])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = () => {
    if (!detail) return
    const cause = detail.rootCause
    const text = [
      `Process:  ${detail.process}`,
      `Pipeline: ${detail.pipelineName ?? '—'}`,
      `Run:      ${detail.runId}`,
      `Ran:      ${detail.startTimeUtc ?? '—'} → ${detail.endTimeUtc ?? '—'} UTC`,
      '',
      cause
        ? `Root cause: ${cause.name} (${cause.type ?? '—'})\n` +
          `Error ${cause.errorCode ?? '—'}${cause.failureType ? ` / ${cause.failureType}` : ''}\n\n` +
          `${cause.message ?? ''}`
        : detail.message ?? detail.loggedMessage ?? 'No failure detail available.',
    ].join('\n')

    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  const cause = detail?.rootCause

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-label={`Failure detail for ${process}`}
      >
        <header>
          <div className="focus-head">
            <div>
              <h2>{process}</h2>
              <p>
                {detail
                  ? `${detail.pipelineName ?? 'unknown pipeline'} · run ${detail.runId.slice(0, 8)}…`
                  : 'Reading the Fabric API…'}
                {detail?.startTimeUtc && (
                  <>
                    {' · '}
                    {detail.startTimeUtc.replace('T', ' ').slice(0, 19)} UTC
                    {duration(detail.startTimeUtc, detail.endTimeUtc) &&
                      ` · ran ${duration(detail.startTimeUtc, detail.endTimeUtc)}`}
                  </>
                )}
              </p>
            </div>
            <div className="focus-actions">
              {detail && (
                <button onClick={copy}>{copied ? 'Copied' : 'Copy detail'}</button>
              )}
              <button onClick={onClose}>Close</button>
            </div>
          </div>
        </header>

        <div className="body">
          {error && (
            <div className="notice error">
              <span>
                <strong>Could not read the failure detail</strong>
                {error}
              </span>
            </div>
          )}

          {!detail && !error && <p className="muted">Querying the Fabric job instance…</p>}

          {detail && (
            <>
              {detail.warnings.map((warning) => (
                <div className="notice warning" key={warning}>
                  <span>{warning}</span>
                </div>
              ))}

              {/* The root cause is the point of this dialog, so it leads. */}
              {cause && (
                <section className="cause">
                  <h3>Root cause</h3>
                  <p className="cause-head">
                    <strong>{cause.name}</strong>
                    {cause.type && <span className="muted"> · {cause.type}</span>}
                    {cause.errorCode && <span className="badge off">ERROR {cause.errorCode}</span>}
                    {cause.failureType && <span className="badge">{cause.failureType}</span>}
                  </p>
                  <pre className="errtext">{cause.message ?? '(no message)'}</pre>
                </section>
              )}

              {/* Logged fallback, clearly attributed — never blended with live text. */}
              {detail.loggedMessage && (
                <section className="cause">
                  <h3>From the orchestrator log</h3>
                  <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
                    Fabric no longer retains this run, so this is the message
                    <code> orchestrator_run_logs </code> captured
                    {detail.loggedAt
                      ? ` on ${detail.loggedAt.replace('T', ' ').slice(0, 19)} UTC`
                      : ''}
                    {detail.loggedRunId && detail.loggedRunId !== detail.runId
                      ? ` for run ${detail.loggedRunId.slice(0, 8)}…`
                      : ''}
                    .
                  </p>
                  <pre className="errtext">{detail.loggedMessage}</pre>
                </section>
              )}

              {/* Job-level message is secondary: it is usually a vaguer restatement. */}
              {detail.message && (
                <details className="panel" style={{ marginTop: 14 }}>
                  <summary>
                    Job-level message{detail.errorCode ? ` (error ${detail.errorCode})` : ''}
                  </summary>
                  <div className="panel-body">
                    <pre className="errtext">{detail.message}</pre>
                  </div>
                </details>
              )}

              {detail.activities.length > 0 && (
                <section style={{ marginTop: 14 }}>
                  <h3 className="section-head">
                    Activities ({detail.activities.length}, in run order)
                  </h3>
                  <ul className="act-list">
                    {detail.activities.map((activity, index) => (
                      <ActivityRow key={`${activity.name}-${index}`} activity={activity} />
                    ))}
                  </ul>
                </section>
              )}

              {!cause && !detail.message && !detail.loggedMessage && (
                <p className="muted">
                  Fabric returned no failure detail for this run, and the orchestrator log
                  has no message for it either.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
