import { useMemo, useState } from 'react'

import type { Issue, Row } from '../types'

type SortKey = 'Process' | 'Dependency' | 'LastModifiedDate'

interface ProcessGroup {
  process: string
  rows: Row[]
}

interface Props {
  rows: Row[]
  /** Blocking errors keyed by RowId, so a broken row is visible in the list. */
  errorsByRow: Map<string, Issue[]>
  /** Process currently being deactivated/restored, so its buttons disable. */
  busyProcess: string | null
  /**
   * Edit, or deactivate/restore, this process. Both take just the name -- the
   * parent looks up every row on file for it, not just the ones passed in
   * here, so a filter never hides part of the edit or the toggle.
   */
  onEdit: (process: string) => void
  onSetActive: (process: string, active: boolean) => void
  /** Ticks readyForUAT/readyForProd for every row on file for the process. */
  onToggleReady: (process: string, field: 'readyForUAT' | 'readyForProd', value: boolean) => void
  /** Hides Edit/Deactivate/Restore — a stand-in for a real Fabric permission check. */
  readOnly?: boolean
}

/** Compact flag badges. Only the ones that are on get emphasis.
 *  readyForUAT/readyForProd get their own checkbox columns instead — see below. */
const FLAGS: { key: keyof Row; label: string }[] = [
  { key: 'isStoredPro', label: 'PROC' },
  { key: 'isGold', label: 'GOLD' },
  { key: 'RequiresHashing', label: 'HASH' },
  { key: 'NeedsTimestamp', label: 'TS' },
  { key: 'lookbackRequired', label: 'LOOK' },
]

const READY_FIELDS: { key: 'readyForUAT' | 'readyForProd'; label: string }[] = [
  { key: 'readyForUAT', label: 'UAT' },
  { key: 'readyForProd', label: 'Prod' },
]

function groupByProcess(rows: Row[]): ProcessGroup[] {
  const map = new Map<string, Row[]>()
  for (const row of rows) {
    const list = map.get(row.Process)
    if (list) list.push(row)
    else map.set(row.Process, [row])
  }
  return [...map.entries()].map(([process, groupRows]) => ({ process, rows: groupRows }))
}

/** Nulls last regardless of direction: a blank Dependency is "no upstream". */
function compareText(left: string, right: string): number {
  if (!left && right) return 1
  if (left && !right) return -1
  return left.localeCompare(right)
}

function firstDependency(group: ProcessGroup): string {
  const named = group.rows.map((r) => r.Dependency ?? '').filter(Boolean)
  return named.length ? [...named].sort()[0] : ''
}

function latestModified(group: ProcessGroup): string {
  return group.rows.reduce((latest, r) => {
    const value = r.LastModifiedDate ?? ''
    return value > latest ? value : latest
  }, '')
}

function compareGroups(a: ProcessGroup, b: ProcessGroup, key: SortKey): number {
  if (key === 'Dependency') return compareText(firstDependency(a), firstDependency(b))
  if (key === 'LastModifiedDate') return compareText(latestModified(a), latestModified(b))
  return compareText(a.process, b.process)
}

const WEEKDAY_NAMES: Record<string, string> = {
  '0': 'Sun',
  '1': 'Mon',
  '2': 'Tue',
  '3': 'Wed',
  '4': 'Thu',
  '5': 'Fri',
  '6': 'Sat',
}

function formatRunTimes(runTimes: string | null): string {
  const value = (runTimes ?? '').trim()
  if (!value) return '—'

  const fields = value.split(/\s+/)
  if (fields.length !== 5) return value

  const [minuteText, hourText, dayText, monthText, weekdayText] = fields
  const minute = Number.parseInt(minuteText, 10)
  const hours = hourText
    .split(',')
    .map((piece) => Number.parseInt(piece.trim(), 10))
    .filter((hour) => Number.isFinite(hour))

  if (!hours.length || !Number.isFinite(minute)) return value

  const formatHour = (hour: number) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  const times = hours.map(formatHour)

  if (minuteText === '0' && hourText.startsWith('*/') && dayText === '*' && monthText === '*' && weekdayText === '*') {
    const interval = Number.parseInt(hourText.slice(2), 10) || 1
    return `Every ${interval} hours UTC`
  }

  if (dayText === '*' && monthText === '*' && weekdayText !== '*') {
    const days = weekdayText
      .split(',')
      .map((token) => WEEKDAY_NAMES[token] ?? token)
      .join(', ')
    return `Weekly ${days} ${times.join(', ')} UTC`
  }

  if (dayText !== '*' && monthText === '*' && weekdayText === '*') {
    return `Monthly on day ${dayText} ${times.join(', ')} UTC`
  }

  if (dayText === '*' && monthText === '*' && weekdayText === '*') {
    if (times.length === 1) return `Daily ${times[0]} UTC`
    return `Daily ${times.join(', ')} UTC`
  }

  return value
}

export default function RowTable({
  rows,
  errorsByRow,
  busyProcess,
  onEdit,
  onSetActive,
  onToggleReady,
  readOnly,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('Process')
  const [ascending, setAscending] = useState(true)

  const groups = useMemo(() => groupByProcess(rows), [rows])

  const sorted = useMemo(() => {
    const copy = [...groups]
    copy.sort((a, b) => {
      const primary = compareGroups(a, b, sortKey)
      const ordered = ascending ? primary : -primary
      // Ties fall back to the natural key so the order is stable between renders.
      return ordered || compareText(a.process, b.process)
    })
    return copy
  }, [groups, sortKey, ascending])

  const sort = (key: SortKey) => {
    if (key === sortKey) setAscending(!ascending)
    else {
      setSortKey(key)
      setAscending(true)
    }
  }

  const arrow = (key: SortKey) => (key === sortKey ? (ascending ? ' ▲' : ' ▼') : '')

  if (!rows.length) {
    return (
      <div className="table-scroll">
        <div className="empty">No rows match the current filters.</div>
      </div>
    )
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th style={{ width: 74 }}>State</th>
            <th className="sortable" onClick={() => sort('Process')}>
              Process{arrow('Process')}
            </th>
            <th className="sortable" onClick={() => sort('Dependency')}>
              Depends on{arrow('Dependency')}
            </th>
            <th>Flags</th>
            {READY_FIELDS.map((f) => (
              <th key={f.key} style={{ width: 54 }} title={`Ready for ${f.label}`}>
                {f.label}
              </th>
            ))}
            <th>Run at</th>
            <th>Warehouse</th>
            <th className="sortable" onClick={() => sort('LastModifiedDate')}>
              Modified{arrow('LastModifiedDate')}
            </th>
            {!readOnly && <th />}
          </tr>
        </thead>
        <tbody>
          {sorted.map((group) => {
            const problems = group.rows.flatMap((r) => errorsByRow.get(r.RowId) ?? [])
            const busy = busyProcess === group.process
            const activeRows = group.rows.filter((r) => r.isActive)
            const allInactive = activeRows.length === 0
            const mixedActive = !allInactive && activeRows.length < group.rows.length
            const shared = group.rows[0]
            const latest = group.rows.reduce((best, r) =>
              (r.LastModifiedDate ?? '') > (best.LastModifiedDate ?? '') ? r : best,
            )
            const dependencyRows = [...group.rows]
              .filter((r) => r.Dependency)
              .sort((a, b) => (a.Dependency ?? '').localeCompare(b.Dependency ?? ''))

            return (
              <tr key={group.process} className={allInactive ? 'inactive' : undefined}>
                <td>
                  <div className="flags">
                    {allInactive && (
                      <span className="badge off" title="Deactivated — the orchestrator skips it.">
                        OFF
                      </span>
                    )}
                    {mixedActive && (
                      <span
                        className="badge off"
                        title={`${activeRows.length} of ${group.rows.length} dependencies active`}
                      >
                        PARTIAL
                      </span>
                    )}
                  </div>
                </td>

                <td className="name">
                  {group.process}
                  {problems.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      {problems.map((issue, index) => (
                        <div key={index} className="badge off" title={issue.message}>
                          ⚠ {issue.message.length > 48 ? `${issue.message.slice(0, 48)}…` : issue.message}
                        </div>
                      ))}
                    </div>
                  )}
                </td>

                <td className="name">
                  {dependencyRows.length === 0 ? (
                    <span className="muted">— no upstream</span>
                  ) : (
                    <div className="chips">
                      {dependencyRows.map((r) => (
                        <span
                          key={r.RowId}
                          className={`chip${r.isActive ? '' : ' chip--inactive'}`}
                          title={r.isActive ? undefined : 'Deactivated — excluded from orchestration.'}
                        >
                          {r.Dependency}
                        </span>
                      ))}
                    </div>
                  )}
                </td>

                <td>
                  <div className="flags">
                    {FLAGS.filter((flag) => shared[flag.key]).map((flag) => (
                      <span key={flag.label} className="badge on">
                        {flag.label}
                      </span>
                    ))}
                  </div>
                </td>

                {READY_FIELDS.map((f) => (
                  <td key={f.key} className="gate-cell">
                    {readOnly ? (
                      <span
                        className={`badge${shared[f.key] ? ' on' : ' off'}`}
                        title={`Ready for ${f.label}: ${shared[f.key] ? 'yes' : 'not yet'}`}
                      >
                        {shared[f.key] ? '✓' : '–'}
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={shared[f.key]}
                        disabled={busy}
                        aria-label={`Ready for ${f.label} for ${group.process}`}
                        title={`Ready for ${f.label} — applies to every row on file for ${group.process}`}
                        onChange={(e) => onToggleReady(group.process, f.key, e.target.checked)}
                      />
                    )}
                  </td>
                ))}

                <td className="muted" title={shared.RunTimes ?? undefined}>
                  {formatRunTimes(shared.RunTimes)}
                </td>
                <td className="muted">{shared.WarehouseName ?? '—'}</td>

                <td className="muted" title={latest.LastModifiedDate ?? ''}>
                  {latest.LastModifiedDate?.slice(0, 10) ?? '—'}
                  {latest.ModifiedBy && (
                    <div style={{ fontSize: 11.5 }}>{latest.ModifiedBy}</div>
                  )}
                </td>

                {!readOnly && (
                  <td className="actions">
                    <button onClick={() => onEdit(group.process)} disabled={busy}>
                      Edit
                    </button>{' '}
                    {allInactive ? (
                      <button onClick={() => onSetActive(group.process, true)} disabled={busy}>
                        {busy ? '…' : 'Restore'}
                      </button>
                    ) : (
                      <button
                        className="danger"
                        onClick={() => onSetActive(group.process, false)}
                        disabled={busy}
                        title="Soft delete: sets isActive = false. The rows are kept."
                      >
                        {busy ? '…' : 'Deactivate'}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
