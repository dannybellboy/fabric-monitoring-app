import { useEffect, useMemo, useRef, useState } from 'react'

import type { Row, RowInput } from '../types'
import { EMPTY_ROW } from '../types'

/**
 * Each flag gets a one-line description. These columns drive orchestrator
 * behaviour and their names are not self-explanatory (isStoredPro, NeedsTimestamp),
 * so the form explains them instead of assuming the reader already knows.
 */
const FLAG_HELP: Record<string, { label: string; desc: string }> = {
  isStoredPro: {
    label: 'Stored procedure',
    desc: 'Runs as a stored proc, so WarehouseName is required.',
  },
  isGold: { label: 'Gold layer', desc: 'Targets a Gold warehouse rather than Silver.' },
  readyForUAT: { label: 'Ready for UAT', desc: 'Included in UAT orchestration runs.' },
  readyForProd: { label: 'Ready for Prod', desc: 'Included in Production runs.' },
  RequiresHashing: { label: 'Requires hashing', desc: 'Row hashing runs for change detection.' },
  NeedsTimestamp: { label: 'Needs timestamp', desc: 'Orchestrator passes a watermark timestamp.' },
  lookbackRequired: {
    label: 'Lookback required',
    desc: 'Orchestrator re-reads a trailing window rather than only new rows.',
  },
  isActive: { label: 'Active', desc: 'Unchecked means the orchestrator skips this row.' },
}

const FLAG_ORDER = [
  'isActive',
  'isStoredPro',
  'isGold',
  'readyForUAT',
  'readyForProd',
  'RequiresHashing',
  'NeedsTimestamp',
  'lookbackRequired',
] as const

/** One "depends on" line in the form. `rowId` is null for one not yet saved. */
interface DepEntry {
  rowId: string | null
  dependency: string
  active: boolean
}

/**
 * What onSave needs to reconcile the form against the warehouse: new edges to
 * create, and existing ones to update in place (rename, active-toggle, and the
 * shared fields all travel together, since PUT already accepts all of them).
 */
export interface SavePlan {
  process: string
  creates: RowInput[]
  updates: { rowId: string; input: RowInput }[]
  /** RowIds to hard-delete -- removed dependencies that were already saved. */
  deletes: string[]
}

interface Props {
  /**
   * null creates a brand-new process. Otherwise every edge currently on file
   * for one process -- one row for a standalone process, several for one with
   * multiple dependencies -- fetched fresh (not filtered), so a dependency
   * hidden by a table filter is never silently dropped by editing here.
   */
  group: Row[] | null
  /** Known process names, offered as dependency suggestions. */
  processNames: string[]
  /** Known warehouse names already in use, offered as suggestions. */
  warehouseNames: string[]
  saving: boolean
  error: string | null
  onSave: (plan: SavePlan) => void
  onCancel: () => void
}

type SchedulePreset = 'custom' | 'hourly' | 'daily' | 'weekly' | 'monthly'

interface HumanSchedule {
  preset: SchedulePreset
  time: string
  times: string[]
  intervalHours: number
  intervalWeeks: number
  weekdays: string[]
  dayOfMonth: number
}

const DEFAULT_SCHEDULE: HumanSchedule = {
  preset: 'custom',
  time: '09:00',
  times: ['09:00'],
  intervalHours: 1,
  intervalWeeks: 1,
  weekdays: ['Mon'],
  dayOfMonth: 1,
}

const WEEKDAY_OPTIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const WEEKDAY_CRON = {
  Mon: '1',
  Tue: '2',
  Wed: '3',
  Thu: '4',
  Fri: '5',
  Sat: '6',
  Sun: '0',
} as const

function parseCronTime(value: string | null | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return '09:00'
  const match = raw.match(/^(\d{1,2}):(\d{2})$/)
  if (match) {
    const hour = Number.parseInt(match[1], 10)
    const minute = Number.parseInt(match[2], 10)
    if (!Number.isNaN(hour) && !Number.isNaN(minute)) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    }
  }
  return '09:00'
}

function inferSchedulePreset(runTimes: string | null): SchedulePreset {
  const cron = (runTimes ?? '').trim()
  if (!cron) return 'custom'

  const fields = cron.split(/\s+/)
  if (fields.length !== 5) return 'custom'

  const [minute, hour, dayOfMonth, month, weekday] = fields

  if (minute === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && weekday === '*') {
    return 'hourly'
  }
  if (dayOfMonth === '*' && month === '*' && weekday !== '*' && !weekday.includes('/')) {
    return 'weekly'
  }
  if (minute !== '*' && hour !== '*' && dayOfMonth !== '*' && month === '*' && weekday === '*') {
    return 'monthly'
  }
  if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && month === '*' && weekday === '*') {
    return 'daily'
  }

  return 'custom'
}

function parseCronToHuman(runTimes: string | null): HumanSchedule {
  const cron = (runTimes ?? '').trim()
  if (!cron) {
    return { ...DEFAULT_SCHEDULE }
  }

  const fields = cron.split(/\s+/)
  if (fields.length !== 5) {
    return { ...DEFAULT_SCHEDULE }
  }

  const [minute, hour, dayOfMonth, month, weekday] = fields
  const time = parseCronTime(`${String(Number.parseInt(hour, 10) || 0)}:${String(Number.parseInt(minute, 10) || 0).padStart(2, '0')}`)

  if (minute === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && weekday === '*') {
    const interval = Number.parseInt(hour.slice(2), 10) || 1
    return {
      preset: 'hourly',
      time: '00:00',
      times: ['00:00'],
      intervalHours: Math.max(1, interval),
      intervalWeeks: 1,
      weekdays: ['Mon'],
      dayOfMonth: 1,
    }
  }

  if (dayOfMonth === '*' && month === '*' && weekday !== '*' && !weekday.includes('/')) {
    const weekdays = weekday
      .split(',')
      .map((token) => {
        const name = Object.keys(WEEKDAY_CRON).find((key) => WEEKDAY_CRON[key as keyof typeof WEEKDAY_CRON] === token)
        return name ?? token
      })
      .filter(Boolean)
    if (weekdays.length) {
      return {
        preset: 'weekly',
        time,
        times: [time],
        intervalHours: 1,
        intervalWeeks: 1,
        weekdays,
        dayOfMonth: 1,
      }
    }
  }

  if (minute !== '*' && hour !== '*' && dayOfMonth !== '*' && month === '*' && weekday === '*') {
    return {
      preset: 'monthly',
      time,
      times: [time],
      intervalHours: 1,
      intervalWeeks: 1,
      weekdays: ['Mon'],
      dayOfMonth: Number.parseInt(dayOfMonth, 10) || 1,
    }
  }

  if (minute !== '*' && hour !== '*' && dayOfMonth === '*' && month === '*' && weekday === '*') {
    const hours = hour
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value))
    const times = hours.map((hourValue) => `${String(hourValue).padStart(2, '0')}:${String(Number.parseInt(minute, 10) || 0).padStart(2, '0')}`)
    return {
      preset: 'daily',
      time: times[0] ?? '09:00',
      times: times.length ? times : [time],
      intervalHours: 1,
      intervalWeeks: 1,
      weekdays: ['Mon'],
      dayOfMonth: 1,
    }
  }

  return { ...DEFAULT_SCHEDULE, time, times: [time] }
}

function humanScheduleToCron(schedule: HumanSchedule, fallbackCron: string | null): string | null {
  const [hourText, minuteText] = (schedule.time || '09:00').split(':')
  const hour = Number.parseInt(hourText, 10) || 0
  const minute = Number.parseInt(minuteText, 10) || 0

  switch (schedule.preset) {
    case 'hourly':
      return `0 */${Math.max(1, Number(schedule.intervalHours) || 1)} * * *`
    case 'daily': {
      const dailyTimes = schedule.times.length ? schedule.times : [schedule.time || '09:00']
      const minuteValue = Number.parseInt((dailyTimes[0] ?? '09:00').split(':')[1] ?? String(minute), 10) || 0
      const hours = [...new Set(dailyTimes.map((value) => Number.parseInt(value.split(':')[0] ?? String(hour), 10)).filter((value) => Number.isFinite(value))) ]
      return `${minuteValue} ${hours.join(',')} * * *`
    }
    case 'weekly':
      return `${minute} ${hour} * * ${schedule.weekdays.map((day) => WEEKDAY_CRON[day as keyof typeof WEEKDAY_CRON] ?? day).join(',')}`
    case 'monthly':
      return `${minute} ${hour} ${Math.max(1, Math.min(31, Number(schedule.dayOfMonth) || 1))} * *`
    case 'custom':
      return fallbackCron ?? null
  }
}

function toInput(row: Row | null): RowInput {
  if (!row) return { ...EMPTY_ROW }
  // Server-managed columns are stripped off; only the editable ones are sent
  // back. TypeScript exempts rest-siblings from its unused-variable check.
  const { RowId, LastModifiedDate, CreatedBy, createdDate, ModifiedBy, ...input } = row
  return input
}

function entriesOf(group: Row[] | null): DepEntry[] {
  if (!group || !group.length) return [{ rowId: null, dependency: '', active: true }]
  return group.map((r) => ({ rowId: r.RowId, dependency: r.Dependency ?? '', active: r.isActive }))
}

export default function RowForm({
  group,
  processNames,
  warehouseNames,
  saving,
  error,
  onSave,
  onCancel,
}: Props) {
  const isNew = group === null
  // Shared fields are seeded from whichever row happens to be first -- editing
  // always writes the same values back to every row in the group, so which one
  // they started from does not matter.
  const [draft, setDraft] = useState<RowInput>(() => toInput(group?.[0] ?? null))
  const [entries, setEntries] = useState<DepEntry[]>(() => entriesOf(group))
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>(() =>
    inferSchedulePreset(group?.[0]?.RunTimes ?? null),
  )
  const [dailyTimeInput, setDailyTimeInput] = useState<string>('09:00')
  /** RowIds of already-saved dependencies removed in this session, hard-deleted on save. */
  const [removedRowIds, setRemovedRowIds] = useState<string[]>([])
  const firstField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const nextGroup = group?.[0] ?? null
    setDraft(toInput(nextGroup))
    setEntries(entriesOf(group))
    setRemovedRowIds([])
    const preset = inferSchedulePreset(nextGroup?.RunTimes ?? null)
    setSchedulePreset(preset)
    const parsed = parseCronToHuman(nextGroup?.RunTimes ?? null)
    setDailyTimeInput(parsed.times[0] ?? '09:00')
  }, [group])
  useEffect(() => firstField.current?.focus(), [])

  // Escape closes the dialog, matching what any other modal on this machine does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const set = <K extends keyof RowInput>(key: K, value: RowInput[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const schedule = useMemo(() => {
    const parsed = parseCronToHuman(draft.RunTimes)
    return { ...parsed, preset: schedulePreset === 'custom' ? 'custom' : parsed.preset }
  }, [draft.RunTimes, schedulePreset])

  const updateSchedule = (patch: Partial<HumanSchedule>) => {
    const next = { ...schedule, ...patch }
    const cron = humanScheduleToCron(next, draft.RunTimes ?? null)
    set('RunTimes', cron)
    setSchedulePreset(next.preset)
  }

  const addDailyTime = (timeValue = dailyTimeInput || '09:00') => {
    const nextTimes = [...new Set([...(schedule.times || []), timeValue])].sort()
    setDailyTimeInput(timeValue)
    updateSchedule({ times: nextTimes, time: timeValue })
  }

  const removeDailyTime = (timeToRemove: string) => {
    const times = (schedule.times || []).filter((time) => time !== timeToRemove)
    const nextTimes = times.length ? times : ['09:00']
    const firstTime = nextTimes[0] ?? '09:00'
    setDailyTimeInput(firstTime)
    updateSchedule({ times: nextTimes, time: firstTime })
  }

  const text = (key: 'RunTimes' | 'WarehouseName' | 'WorkspacePrefix') => ({
    value: draft[key] ?? '',
    // Empty input means NULL, not '': the table uses NULL for "not applicable".
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value || null),
  })

  const updateEntry = (index: number, patch: Partial<DepEntry>) =>
    setEntries((current) => current.map((e, i) => (i === index ? { ...e, ...patch } : e)))

  const removeEntry = (index: number) => {
    const entry = entries[index]
    if (entry.rowId) setRemovedRowIds((current) => [...current, entry.rowId as string])
    setEntries((current) => current.filter((_, i) => i !== index))
  }

  const isKnownProcess = (name: string) =>
    processNames.some((p) => p.toLowerCase() === name.toLowerCase())

  /** Client-side mirror of the server's blocking rules, for immediate feedback. */
  const localError = useMemo(() => {
    const process = draft.Process.trim()
    if (!process) return 'Process is required.'

    const named = entries
      .map((e) => e.dependency.trim())
      .filter((d) => d !== '')

    if (named.some((d) => d.toLowerCase() === process.toLowerCase())) {
      return 'A process cannot depend on itself.'
    }
    const seen = new Set<string>()
    for (const d of named) {
      const key = d.toLowerCase()
      if (seen.has(key)) return `${d} is listed more than once.`
      seen.add(key)
    }

    if (draft.isStoredPro && !(draft.WarehouseName ?? '').trim()) {
      return 'Stored procedures need a WarehouseName.'
    }

    const runTimes = (draft.RunTimes ?? '').trim()
    if (runTimes) {
      // Structural check only (matches server/models.py's _CRON_FIELD): five
      // whitespace-separated fields, each a '*', number, range, step, or a
      // comma list of those.
      const cronField = /^(\*|\d+)(-\d+)?(\/\d+)?(,(\*|\d+)(-\d+)?(\/\d+)?)*$/
      const fields = runTimes.split(/\s+/)
      if (fields.length !== 5 || !fields.every((f) => cronField.test(f))) {
        return `RunTimes must be a 5-field cron expression (minute hour day month weekday), e.g. '0 9 * * *'; got '${runTimes}'.`
      }
    }
    return null
  }, [draft, entries])

  const processField = (
    <div className="field">
      <label htmlFor="f-process">Process</label>
      <input
        id="f-process"
        ref={firstField}
        type="text"
        list="dg-processes"
        value={draft.Process}
        onChange={(e) => set('Process', e.target.value)}
        placeholder="SP_Create_Something_Silver"
      />
      <div className="hint">The pipeline or stored proc being orchestrated.</div>
    </div>
  )

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (localError || saving) return

    if (removedRowIds.length > 0) {
      const noun = removedRowIds.length === 1 ? 'dependency' : 'dependencies'
      if (
        !window.confirm(
          `Permanently delete ${removedRowIds.length} removed ${noun}?\n\n` +
            'This deletes the row(s) outright — unlike unchecking Active, there is no undo.',
        )
      ) {
        return
      }
    }

    const shared = draft
    const hasExisting = entries.some((e) => e.rowId !== null)
    const namedNew = entries.filter((e) => !e.rowId && e.dependency.trim())

    if (!hasExisting && namedNew.length === 0) {
      // A brand-new, standalone process: nothing typed, so one row with no
      // upstream -- the same thing a blank Dependency has always meant.
      onSave({
        process: shared.Process,
        creates: [{ ...shared, Dependency: null, isActive: true }],
        updates: [],
        deletes: removedRowIds,
      })
      return
    }

    const creates: RowInput[] = []
    const updates: SavePlan['updates'] = []
    for (const entry of entries) {
      const dependency = entry.dependency.trim() || null
      if (entry.rowId) {
        updates.push({ rowId: entry.rowId, input: { ...shared, Dependency: dependency, isActive: entry.active } })
      } else if (dependency) {
        creates.push({ ...shared, Dependency: dependency, isActive: true })
      }
    }
    onSave({ process: shared.Process, creates, updates, deletes: removedRowIds })
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label={isNew ? 'New process' : 'Edit process'}
      >
        <header>
          <h2>{isNew ? 'New process' : 'Edit process'}</h2>
          <p>
            {isNew
              ? 'Add every dependency below and one row is created for each — everything else here is only entered once.'
              : 'Every field here applies to all of this process’s rows. Uncheck a dependency’s Active box to skip it without deleting its history, or use × to delete it outright.'}
          </p>
        </header>

        <div className="body">
          {error && (
            <div className="notice error">
              <span>{error}</span>
            </div>
          )}

          {processField}

          <div className="field">
            <label htmlFor="f-dep-0">{entries.length > 1 ? 'Dependencies' : 'Dependency'}</label>
            <div className="dep-rows">
              {entries.map((entry, index) => {
                const trimmedDep = entry.dependency.trim()
                const isExisting = entry.rowId !== null
                return (
                  <div
                    className={`dep-row${isExisting && !entry.active ? ' dep-row--inactive' : ''}`}
                    key={entry.rowId ?? `new-${index}`}
                  >
                    <input
                      id={index === 0 ? 'f-dep-0' : undefined}
                      type="text"
                      list="dg-processes"
                      value={entry.dependency}
                      onChange={(e) => updateEntry(index, { dependency: e.target.value })}
                      placeholder={index === 0 ? 'leave blank if it has no upstream' : 'another dependency'}
                    />
                    {trimmedDep && !isKnownProcess(trimmedDep) && (
                      <span className="muted dep-new-tag">not in the table yet</span>
                    )}
                    {isExisting && (
                      <label className="check check--inline dep-active">
                        <input
                          type="checkbox"
                          checked={entry.active}
                          onChange={(e) => updateEntry(index, { active: e.target.checked })}
                        />
                        <span>Active</span>
                      </label>
                    )}
                    {entries.length > 1 && (
                      <button
                        type="button"
                        className="iconbtn"
                        title={
                          isExisting
                            ? 'Remove this dependency — deletes it permanently, unlike unchecking Active'
                            : 'Remove this dependency'
                        }
                        onClick={() => removeEntry(index)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              onClick={() => setEntries((current) => [...current, { rowId: null, dependency: '', active: true }])}
            >
              + Add another dependency
            </button>
            <div className="hint">
              {isNew
                ? 'Must finish before Process runs. Each one becomes its own row.'
                : 'Must finish before Process runs. Renaming, un-checking Active, or removing one only affects that one row.'}
            </div>
          </div>

          <datalist id="dg-processes">
            {processNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <fieldset>
            <legend>Flags</legend>
            <div className="checks">
              {FLAG_ORDER.map((key) => (
                <label className="check" key={key}>
                  <input
                    type="checkbox"
                    checked={draft[key]}
                    onChange={(e) => set(key, e.target.checked)}
                  />
                  <span>
                    {FLAG_HELP[key].label}
                    <span className="desc">{FLAG_HELP[key].desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="f-runtimes">Run schedule</label>
              <div className="schedule-picker">
                <select
                  className="schedule-control"
                  value={schedule.preset}
                  onChange={(e) => {
                    const preset = e.target.value as SchedulePreset
                    const next = { ...schedule, preset }
                    if (preset === 'weekly') next.intervalWeeks = 1
                    if (preset === 'custom') {
                      setSchedulePreset('custom')
                      return
                    }
                    updateSchedule(next)
                  }}
                >
                  <option value="custom">Custom cron</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>

                {schedule.preset === 'hourly' && (
                  <div className="schedule-row">
                    <span>Every</span>
                    <input
                      className="schedule-control schedule-control--compact"
                      type="number"
                      min={1}
                      max={24}
                      value={schedule.intervalHours}
                      onChange={(e) => updateSchedule({ intervalHours: Number(e.target.value) || 1 })}
                    />
                    <span>hours</span>
                  </div>
                )}

                {schedule.preset === 'daily' && (
                  <>
                    <div className="schedule-row">
                      <input
                        className="schedule-control"
                        type="time"
                        value={dailyTimeInput}
                        onChange={(e) => setDailyTimeInput(e.target.value || '09:00')}
                      />
                      <button type="button" onClick={() => addDailyTime(dailyTimeInput)}>
                        + Add time
                      </button>
                    </div>
                    <div className="schedule-days">
                      {(schedule.times || []).map((time) => (
                        <button
                          type="button"
                          key={time}
                          className="schedule-day schedule-day--button"
                          onClick={() => removeDailyTime(time)}
                          title={`Remove ${time}`}
                          aria-label={`Remove ${time}`}
                        >
                          <span>{time}</span>
                          <span className="schedule-day__remove" aria-hidden="true">
                            ×
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {(schedule.preset === 'weekly' || schedule.preset === 'monthly') && (
                  <div className="schedule-row">
                    <input
                      className="schedule-control"
                      type="time"
                      value={schedule.time}
                      onChange={(e) => updateSchedule({ time: e.target.value || '09:00' })}
                    />
                  </div>
                )}

                {schedule.preset === 'weekly' && (
                  <>
                    <div className="schedule-row">
                      <span>Every</span>
                      <select
                        className="schedule-control schedule-control--compact"
                        value={schedule.intervalWeeks}
                        onChange={(e) => updateSchedule({ intervalWeeks: Number(e.target.value) || 1 })}
                      >
                        {[1, 2, 3, 4, 5, 6].map((weeks) => (
                          <option key={weeks} value={weeks}>
                            {weeks}
                          </option>
                        ))}
                      </select>
                      <span>weeks</span>
                    </div>
                    <div className="schedule-days">
                      {WEEKDAY_OPTIONS.map((day) => (
                        <label key={day} className="schedule-day">
                          <input
                            type="checkbox"
                            checked={schedule.weekdays.includes(day)}
                            onChange={(e) => {
                              const weekdays = e.target.checked
                                ? [...schedule.weekdays, day]
                                : schedule.weekdays.filter((item) => item !== day)
                              updateSchedule({ weekdays: weekdays.length ? weekdays : ['Mon'] })
                            }}
                          />
                          <span>{day}</span>
                        </label>
                      ))}
                    </div>
                  </>
                )}

                {schedule.preset === 'monthly' && (
                  <div className="schedule-row">
                    <span>Day</span>
                    <input
                      className="schedule-control schedule-control--compact"
                      type="number"
                      min={1}
                      max={31}
                      value={schedule.dayOfMonth}
                      onChange={(e) =>
                        updateSchedule({ dayOfMonth: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })
                      }
                    />
                  </div>
                )}

                {schedule.preset === 'custom' && (
                  <input
                    id="f-runtimes"
                    className="schedule-control"
                    type="text"
                    {...text('RunTimes')}
                    placeholder="0 9 * * *"
                  />
                )}
              </div>
              <div className="hint">
                {schedule.preset === 'custom'
                  ? '5-field cron: minute hour day month weekday. e.g. 0 2,3,12,13 * * *'
                  : `Stored as cron: ${draft.RunTimes ?? humanScheduleToCron(schedule, null) ?? 'not set'}`}
              </div>
            </div>

            <div className="field">
              <label htmlFor="f-warehouse">WarehouseName</label>
              <input
                id="f-warehouse"
                type="text"
                list="dg-warehouses"
                {...text('WarehouseName')}
                placeholder={draft.isStoredPro ? 'WH_HDX_DE_Silver' : 'not needed for pipelines'}
              />
              <div className="hint">
                {draft.isStoredPro
                  ? 'Where the stored proc runs.'
                  : 'Only used when Stored procedure is checked.'}
              </div>
              <datalist id="dg-warehouses">
                {warehouseNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="field">
            <label htmlFor="f-prefix">WorkspacePrefix</label>
            <input id="f-prefix" type="text" {...text('WorkspacePrefix')} />
            <div className="hint">
              Workspace the process lives in. Every current row uses WS_HDX_DE_.
            </div>
          </div>

          {localError && (
            <div className="notice warning">
              <span>{localError}</span>
            </div>
          )}

          {!isNew && group.length === 1 && (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Created by {group[0].CreatedBy ?? 'unknown'}
              {group[0].createdDate ? ` on ${group[0].createdDate.slice(0, 10)}` : ''}
              {group[0].ModifiedBy ? ` · last edited in HDX Management Tool by ${group[0].ModifiedBy}` : ''}
            </p>
          )}
        </div>

        <footer>
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving || !!localError}>
            {saving ? 'Saving…' : isNew ? 'Create process' : 'Save changes'}
          </button>
        </footer>
      </form>
    </div>
  )
}
