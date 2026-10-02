/**
 * Health model for the Status dashboard.
 *
 * The raw `Status` column is not a health signal on its own. 91 days after its
 * last success, a process still reads `Completed` — and nothing alerts on green.
 * That "stale green" case is the one this model exists to surface, so severity is
 * derived from *when a process last succeeded*, not from what its status says.
 *
 * Severity is exclusive: every row gets exactly one tier, so the tiers sum to the
 * row count and can be stacked as a part-to-whole bar.
 */
import type { ProcessStatus } from './types'

export type Severity = 'critical' | 'warning' | 'good' | 'unknown' | 'inactive' | 'orphaned'

/** No success in this many days is stale. Every graph row carries RunTimes, so
 *  the expectation is at least daily; a week is a generous grace period. */
export const STALE_DAYS = 1

export const SEVERITY_ORDER: Severity[] = [
  'critical',
  'warning',
  'unknown',
  'good',
  'inactive',
  'orphaned',
]

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Failing',
  warning: 'Stale',
  good: 'Healthy',
  unknown: 'Unknown',
  inactive: 'Deactivated',
  orphaned: 'Orphaned',
}

/**
 * Icon paired with every status colour. The status palette's warning step sits
 * below 3:1 on a white surface by design -- the icon plus a text label is the
 * documented mitigation, so colour never carries the meaning alone.
 */
export const SEVERITY_ICON: Record<Severity, string> = {
  critical: '✕',
  warning: '!',
  good: '✓',
  unknown: '?',
  inactive: '–',
  orphaned: '⊘',
}

export const SEVERITY_DESCRIPTION: Record<Severity, string> = {
  critical: 'Last run failed, or the process has never succeeded.',
  warning: `Succeeded, but not in the last ${STALE_DAYS} days — it may have stopped being scheduled.`,
  good: `Succeeded within the last ${STALE_DAYS} days.`,
  unknown: 'No status recorded, so the orchestrator has never reported on it.',
  inactive: 'Deactivated in the dependency graph, so it is not expected to run.',
  orphaned:
    'No matching row in the dependency graph — usually left behind by a rename or ' +
    'removal. Its Status and LastSuccess are frozen from whenever that happened, so ' +
    'they will never change on their own.',
}

export function severityOf(row: ProcessStatus): Severity {
  // Orphaned first, and checked before everything else: nothing writes to this
  // row any more once its process is renamed or removed from the graph, so
  // Status/LastSuccess are frozen at whatever they were at that moment. Falling
  // through to the critical/warning checks below would misreport a dead row as
  // an active failure -- permanently, since nothing will ever update it again.
  if (!row.inGraph) return 'orphaned'
  // Deactivated next: a row nobody schedules is not a failure, and alarming on
  // it would train people to ignore the dashboard.
  if (row.isActive === false) return 'inactive'
  if (row.Status === 'Failed' || row.LastSuccess === null) return 'critical'
  if (row.daysSinceSuccess !== null && row.daysSinceSuccess > STALE_DAYS) return 'warning'
  if (!row.Status) return 'unknown'
  return 'good'
}

export interface HealthSummary {
  total: number
  bySeverity: Record<Severity, number>
  /** critical + warning: the number a human has to act on. Orphaned rows are
   *  excluded by construction (severityOf never classifies one as critical or
   *  warning), so a renamed process cannot inflate this count forever. */
  needsAttention: number
  /** Of the *currently failing* rows, how many have never once succeeded. Scoped
   *  to severity 'critical' rather than a bare LastSuccess-is-null filter, so an
   *  orphaned or deactivated row that happens to have a null LastSuccess is not
   *  counted here either -- this note sits directly under the Failing tile, so it
   *  must describe exactly that tile's rows and nothing else. */
  neverSucceeded: number
  running: number
  /** Status rows whose process is absent from the orchestrator's graph. Same
   *  count as bySeverity.orphaned; kept as a named field because callers show it
   *  paired with `untracked`, the opposite gap. */
  orphaned: number
  /** Graph processes with no status row at all. */
  untracked: number
  worst: ProcessStatus | null
}

export function healthSummary(
  rows: ProcessStatus[],
  untracked: string[],
): HealthSummary {
  const bySeverity = {
    critical: 0,
    warning: 0,
    good: 0,
    unknown: 0,
    inactive: 0,
    orphaned: 0,
  } as Record<Severity, number>

  for (const row of rows) bySeverity[severityOf(row)] += 1

  // The single worst offender, for the hero line: never-succeeded outranks any
  // number of days, then oldest success wins. Orphaned rows never reach this
  // filter -- severityOf() already routed them to 'orphaned' -- so a renamed
  // process can never be reported as the longest-running outage.
  const ranked = [...rows]
    .filter((row) => severityOf(row) === 'critical')
    .sort((a, b) => {
      if ((a.LastSuccess === null) !== (b.LastSuccess === null)) {
        return a.LastSuccess === null ? -1 : 1
      }
      return (b.daysSinceSuccess ?? 0) - (a.daysSinceSuccess ?? 0)
    })

  return {
    total: rows.length,
    bySeverity,
    needsAttention: bySeverity.critical + bySeverity.warning,
    neverSucceeded: rows.filter(
      (r) => severityOf(r) === 'critical' && r.LastSuccess === null,
    ).length,
    running: rows.filter((r) => r.Status === 'Running').length,
    orphaned: bySeverity.orphaned,
    untracked: untracked.length,
    worst: ranked[0] ?? null,
  }
}

// --------------------------------------------------------------------------
// Failure age buckets
// --------------------------------------------------------------------------

/**
 * Buckets answer "chronic rot or a fresh outage?", which the raw failure count
 * cannot. Ordered most severe first, and coloured with a validated single-hue
 * ordinal ramp -- age is ordered magnitude, not identity, so a categorical
 * palette would be wrong here.
 */
export interface AgeBucket {
  key: string
  label: string
  match: (daysSinceSuccess: number | null) => boolean
}

export const AGE_BUCKETS: AgeBucket[] = [
  { key: 'never', label: 'Never succeeded', match: (d) => d === null },
  { key: 'over90', label: 'Over 90 days', match: (d) => d !== null && d > 90 },
  { key: '31to90', label: '31 to 90 days', match: (d) => d !== null && d > 30 && d <= 90 },
  { key: '8to30', label: '8 to 30 days', match: (d) => d !== null && d > 7 && d <= 30 },
  { key: 'under7', label: 'Within 7 days', match: (d) => d !== null && d <= 7 },
]

export function bucketOf(row: ProcessStatus): AgeBucket {
  // The list is exhaustive over (null | number), so the fallback is unreachable;
  // it exists so the return type needs no assertion.
  return AGE_BUCKETS.find((b) => b.match(row.daysSinceSuccess)) ?? AGE_BUCKETS[0]
}

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

/** "122 days ago" / "3 hours ago" / "never". Ages come from the server already
 *  differenced, because these timestamps are naive UTC and a browser would read
 *  them as local time. */
export function relativeAge(days: number | null, hours: number | null): string {
  if (days === null && hours === null) return 'never'
  if (days !== null && days >= 1) return `${days} day${days === 1 ? '' : 's'} ago`
  if (hours !== null) {
    if (hours < 1) return 'under an hour ago'
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
    return `${Math.floor(hours / 24)} days ago`
  }
  return 'today'
}

/** Compact display for a stat-tile or hero value. */
export function compact(value: number): string {
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}K` : String(value)
}
