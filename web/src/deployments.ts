/**
 * Progress model for the deployment tracker.
 *
 * "How far along is this component" is derived from the gate flags rather than
 * stored, so there is no status column to fall out of step with the gates that
 * actually record what happened.
 */

import { GATES } from './types'
import type { Deployment } from './types'

/**
 * Today as the user's calendar sees it.
 *
 * `toISOString()` alone would be UTC, so ticking a gate at 7pm Central would
 * stamp tomorrow's date — visibly wrong on a tracker people read by date.
 */
export function todayLocal(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)
}

/** How many of the eleven gates have been passed. */
export function gatesPassed(row: Deployment): number {
  return GATES.filter((gate) => row[gate.key]).length
}

/** The row's display name. Most planned rows have only an Item. */
export function labelOf(row: Deployment): string {
  return row.ComponentName || row.Item || '(unnamed)'
}

/**
 * PI and release as one identifier: PI 27.3 wave 1 reads `27.3.1`.
 *
 * The "PI " prefix is dropped because every row has it, and the wave is appended
 * so a component's release is one token you can say out loud and search for.
 */
export function releaseToken(pi: string | null, wave: string | null): string {
  const number = (pi ?? '').replace(/^PI\s*/i, '').trim()
  const inWave = wave?.trim()
  if (!number) return inWave || '—'
  return inWave ? `${number}.${inWave}` : number
}

export function piRelease(row: Deployment): string {
  return releaseToken(row.PINumberRelease, row.ReleaseWave)
}

/**
 * The numeric PI value in e.g. "PI 27.3" -> 27.3, or null if there is no
 * number to find (including an unset PINumberRelease).
 */
export function piNumber(release: string | null): number | null {
  const match = (release ?? '').match(/(\d+(?:\.\d+)?)/)
  return match ? Number(match[1]) : null
}

/**
 * Whether a row's PI is `min` or later. A row with no PI set at all (planned
 * work not yet assigned to a release) passes too — it is future work, not
 * something the cutoff is meant to hide.
 */
export function piAtLeast(release: string | null, min: number): boolean {
  const n = piNumber(release)
  return n === null || n >= min
}

export type Priority = 'high' | 'medium' | 'low' | 'unknown'

const PRIORITY_FLAG_TEXT: Record<Priority, string> = {
  high: 'H',
  medium: 'M',
  low: 'L',
  unknown: 'Unk',
}

/**
 * Priority as one of four buckets.
 *
 * Matches on the first letter so both the spreadsheet's H/M/L and the expanded
 * High/Medium/Low resolve the same way, and anything unrecognised is reported as
 * unknown rather than quietly dropped.
 */
export function priorityOf(row: Deployment): Priority {
  const value = (row.Priority ?? '').trim().toLowerCase()
  if (value.startsWith('h')) return 'high'
  if (value.startsWith('m')) return 'medium'
  if (value.startsWith('l')) return 'low'
  return 'unknown'
}

/** Text shown inside the priority flag. Colour never carries meaning alone. */
export function priorityFlagText(priority: Priority): string {
  return PRIORITY_FLAG_TEXT[priority]
}

export function priorityTitle(row: Deployment): string {
  const priority = priorityOf(row)
  return priority === 'unknown'
    ? `Priority not set${row.Priority ? ` (unrecognised value: ${row.Priority})` : ''}`
    : `Priority: ${row.Priority}`
}

export type Stage = 'not-started' | 'in-progress' | 'completed'

/**
 * Completed means every gate passed, not merely "deployed to prod".
 *
 * 49 of the imported rows are in production but have not passed prod smoke
 * tests — they are shipped, not finished. Treating prod as the finish line would
 * hide all 49 from a tracker whose whole job is showing what still needs doing.
 */
export function stageOf(row: Deployment): Stage {
  const passed = gatesPassed(row)
  if (passed === GATES.length) return 'completed'
  return passed === 0 ? 'not-started' : 'in-progress'
}

export function isCompleted(row: Deployment): boolean {
  return stageOf(row) === 'completed'
}

/**
 * The furthest gate passed, for the row's one-line summary.
 *
 * Deliberately the *last* gate passed rather than the first gap: gates get
 * passed out of order (a component re-deployed to QA after a UAT failure), and
 * reporting such a row as stuck at code review would be a lie.
 */
export function furthestGate(row: Deployment): string {
  for (let i = GATES.length - 1; i >= 0; i -= 1) {
    if (row[GATES[i].key]) return GATES[i].label
  }
  return 'Not started'
}

const STAGE_LABEL: Record<Stage, string> = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  completed: 'Complete',
}

export function stageLabel(row: Deployment): string {
  const stage = stageOf(row)
  return stage === 'in-progress' ? furthestGate(row) : STAGE_LABEL[stage]
}

/** Counts for the summary strip. */
export function summarise(rows: Deployment[]) {
  return {
    total: rows.length,
    notStarted: rows.filter((r) => stageOf(r) === 'not-started').length,
    inProgress: rows.filter((r) => stageOf(r) === 'in-progress').length,
    // Shipped, which is not the same as finished — see stageOf.
    deployed: rows.filter((r) => r.DeployedToProd).length,
    completed: rows.filter((r) => stageOf(r) === 'completed').length,
  }
}

/**
 * Release waves in the order people say them: 1, 2, … 10, 15, then BACKLOG.
 *
 * Plain string sort would put 10 before 2, and a numeric sort alone would drop
 * BACKLOG. Numbers first in numeric order, everything else alphabetically after.
 */
export function sortWaves(waves: string[]): string[] {
  return [...waves].sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    const aNum = a !== '' && Number.isFinite(na)
    const bNum = b !== '' && Number.isFinite(nb)
    if (aNum && bNum) return na - nb
    if (aNum) return -1
    if (bNum) return 1
    return a.localeCompare(b)
  })
}

/**
 * A stored `YYYY-MM-DD` as M/D/YYYY.
 *
 * Split rather than parsed: `new Date('2026-08-24')` is UTC midnight, which in
 * any negative offset renders as the 23rd. These are calendar dates with no time
 * and no zone, so they must never go through Date at all.
 */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  if (!y || !m || !d) return iso
  return `${Number(m)}/${Number(d)}/${y}`
}

export interface GroupedRow {
  row: Deployment
  /**
   * How many consecutive rows share this Item within the same release.
   * 0 means this row continues the group started by the nearest preceding
   * entry with `itemSpan > 0`, and its Item cell should not be rendered at all
   * — the caller uses this to drive a `rowSpan` instead of repeating the value.
   */
  itemSpan: number
}

/**
 * Groups consecutive rows that share an Item within the same PI/release, so the
 * grid can show the Item once (via `rowSpan`) over several components instead of
 * repeating it — 12 items in the current data each cover 2-3 components.
 *
 * Rows with no Item are never grouped with each other: null means "not
 * identified yet", not "the same item", and merging them would claim an
 * unrelated pair of planned rows are one piece of work.
 *
 * Relies on same-item rows already being adjacent, which holds as long as nothing
 * sorts between PI/wave and Item — true today because Priority ties (every
 * multi-component Item in the data shares one Priority), but a caller that sorts
 * by something that can differ within an Item (e.g. Component Name) would break
 * this and needs to group before applying that sort.
 */
export function groupByItem(rows: Deployment[]): GroupedRow[] {
  const out: GroupedRow[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (!row.Item) {
      out.push({ row, itemSpan: 1 })
      i += 1
      continue
    }
    let j = i + 1
    while (
      j < rows.length &&
      rows[j].Item === row.Item &&
      rows[j].PINumberRelease === row.PINumberRelease &&
      rows[j].ReleaseWave === row.ReleaseWave
    ) {
      j += 1
    }
    for (let k = i; k < j; k += 1) {
      out.push({ row: rows[k], itemSpan: k === i ? j - i : 0 })
    }
    i = j
  }
  return out
}

/** One entry in the release picker: a PI + wave, with its date and progress. */
export interface ReleaseOption {
  /** Exact filter value; encodes the PI so wave 1 of two PIs cannot collide. */
  value: string
  pi: string
  wave: string | null
  label: string
  count: number
}

export function releaseKey(pi: string | null, wave: string | null): string {
  // JSON rather than a delimiter: no character can appear in a PI name or a wave
  // and split the key by accident, and the result stays readable in the DOM.
  return JSON.stringify([pi ?? '', wave ?? ''])
}

/**
 * The release picker's options, grouped by PI and ordered by wave.
 *
 * A release is labelled Complete only when every row in it is — the picker is
 * how someone decides which release still needs attention, so it has to reflect
 * the whole release, not whatever the other filters have narrowed to.
 */
export function releaseOptions(rows: Deployment[]): ReleaseOption[] {
  const groups = new Map<string, Deployment[]>()
  for (const row of rows) {
    const key = releaseKey(row.PINumberRelease, row.ReleaseWave)
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }

  const options: ReleaseOption[] = []
  for (const [value, group] of groups) {
    const [pi, wave] = JSON.parse(value) as [string, string]
    // Every wave in the data maps to exactly one date, so the first is the date.
    const iso = group.find((r) => r.ReleaseDate)?.ReleaseDate ?? null
    const complete = group.every(isCompleted)

    const head = !wave ? 'No release set' : /^\d+$/.test(wave) ? `#${wave}` : wave
    // "No release set - no date" says the same thing twice; every other option
    // names its date, or says it has none, which is worth knowing.
    const when = !wave ? '' : ` - ${iso ? formatDate(iso) : 'no date'}`
    options.push({
      value,
      pi: pi || '—',
      wave: wave || null,
      label: `${head}${when}${complete ? ' (Complete)' : ''}`,
      count: group.length,
    })
  }

  // PI ascending -- 27.2 is older than 27.3, and a release plan reads forwards --
  // then wave ascending inside it, with rows that have no release at all last:
  // they are an exception to look at once, not a release anyone browses to.
  const order = new Map(
    sortWaves([...new Set(options.map((o) => o.wave).filter((w): w is string => !!w))]).map(
      (w, i) => [w, i],
    ),
  )
  const rank = (o: ReleaseOption) => (o.wave === null ? Infinity : (order.get(o.wave) ?? 0))
  return options.sort((a, b) => a.pi.localeCompare(b.pi) || rank(a) - rank(b))
}
