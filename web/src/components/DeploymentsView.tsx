import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, api } from '../api'
import {
  formatDate,
  gatesPassed,
  groupByItem,
  labelOf,
  piAtLeast,
  piRelease,
  priorityFlagText,
  priorityOf,
  priorityTitle,
  releaseKey,
  releaseOptions,
  releaseToken,
  stageLabel,
  stageOf,
  summarise,
  todayLocal,
} from '../deployments'
import { GATES, OWNERS, TABLE_OWNERS } from '../types'
import type { Deployment, DeploymentInput, GateKey, ReleaseSummary } from '../types'
import DeploymentForm from './DeploymentForm'

interface Props {
  notify: (kind: 'success' | 'error', text: string) => void
  /** Hides create/edit/delete and gate-ticking — a stand-in for a real Fabric
   *  permission check. */
  readOnly?: boolean
}

type StageFilter = 'all' | 'not-started' | 'in-progress' | 'completed'

/** null = closed, 'new' = create form, Deployment = edit that row. */
type Editing = null | 'new' | Deployment

const ALL_RELEASES = ''
const ANY = ''

/** The tracker only shows PI 27.3 onward — earlier PIs are done and stay in
 *  the spreadsheet/warehouse history, not this view. */
const MIN_TRACKED_PI = 27.3

export default function DeploymentsView({ notify, readOnly }: Props) {
  const [rows, setRows] = useState<Deployment[]>([])
  const [releases, setReleases] = useState<ReleaseSummary[]>([])
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({})

  const [release, setRelease] = useState(ALL_RELEASES)
  /** A PI+wave key from releaseKey(), or ANY. Carries the date implicitly. */
  const [wave, setWave] = useState(ANY)
  const [search, setSearch] = useState('')
  // Defaults to showing everything: with the view already narrowed to PI 27.3
  // onward, hiding rows by stage on top of that left people wondering where
  // their row went.
  const [stage, setStage] = useState<StageFilter>('all')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Set when the server refuses a write because the row moved (HTTP 412). */
  const [stale, setStale] = useState<string | null>(null)

  /** Fields editable in place, via a double-click, rather than through the
   *  full Edit dialog. */
  type InlineField = 'ComponentName' | 'Notes'
  const [inlineEdit, setInlineEdit] = useState<{ id: string; field: InlineField } | null>(null)
  const [inlineDraft, setInlineDraft] = useState('')
  const inlineInputRef = useRef<HTMLInputElement>(null)
  /** Escape blurs the input on its way out; this stops that blur from
   *  re-committing the very edit Escape just cancelled. */
  const cancelledInlineEdit = useRef(false)

  const loadRows = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await api.deployments())
      setStale(null)
    } catch (e) {
      notify('error', e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [notify])

  /** Release counts and the name suggestions both move whenever a row does. */
  const loadContext = useCallback(async () => {
    try {
      const [nextReleases, nextSuggestions] = await Promise.all([
        api.deploymentReleases(),
        api.deploymentSuggestions(),
      ])
      // Same PI 27.3-onward scope as the grid, so the PI picker never offers a
      // release the table itself would immediately filter back out.
      setReleases(nextReleases.filter((r) => piAtLeast(r.release, MIN_TRACKED_PI)))
      setSuggestions(nextSuggestions)
    } catch {
      /* the picker falls back to "all releases" and the datalists to empty */
    }
  }, [])

  useEffect(() => {
    void loadRows()
    void loadContext()
  }, [loadRows, loadContext])

  // Switching to read-only mid-edit should not leave an edit dialog or inline
  // editor open behind it.
  useEffect(() => {
    if (!readOnly) return
    setEditing(null)
    setInlineEdit(null)
  }, [readOnly])

  /**
   * A 412 means someone else changed the row after it was loaded, so the write
   * was refused rather than silently overwriting them. It gets a persistent
   * banner with a Reload action, because it needs a decision, not a dismissal.
   */
  const handleWriteError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 412) setStale(e.message)
    else notify('error', e instanceof ApiError ? e.message : String(e))
  }

  const replaceRow = (next: Deployment) =>
    setRows((current) =>
      current.map((row) => (row.DeploymentId === next.DeploymentId ? next : row)),
    )

  /** Everything loaded, restricted to PI 27.3 onward — the page's standing scope. */
  const trackedRows = useMemo(
    () => rows.filter((row) => piAtLeast(row.PINumberRelease, MIN_TRACKED_PI)),
    [rows],
  )

  /** Rows matching everything except the stage filter — what the pickers offer. */
  const inScope = useMemo(
    () => trackedRows.filter((row) => !release || row.PINumberRelease === release),
    [trackedRows, release],
  )

  const waveOptions = useMemo(() => releaseOptions(inScope), [inScope])

  /**
   * Releases the grid's per-row dropdown offers, as compact `27.3.1` tokens
   * matching what the column shows.
   *
   * Drawn from the whole tracked scope rather than the filtered view, so
   * narrowing to one release does not leave you unable to move a row out of
   * it — but still only PI 27.3 onward, so a row cannot be dropped into a PI
   * the page hides and appear to vanish.
   */
  const releaseChoices = useMemo(
    () =>
      releaseOptions(trackedRows).map((o) => ({
        value: o.value,
        token: releaseToken(o.pi === '—' ? null : o.pi, o.wave),
      })),
    [trackedRows],
  )

  /** True when the picker spans more than one PI, so options need a PI heading. */
  const groupByPi = useMemo(
    () => new Set(waveOptions.map((o) => o.pi)).size > 1,
    [waveOptions],
  )

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return inScope.filter((row) => {
      if (wave && releaseKey(row.PINumberRelease, row.ReleaseWave) !== wave) return false
      if (stage !== 'all' && stageOf(row) !== stage) return false
      if (needle) {
        const haystack = [
          row.ComponentName,
          row.Item,
          row.ComponentType,
          row.Requestor,
          // The combined form too, so searching "27.3.1" finds the release the
          // grid actually shows.
          piRelease(row),
          ...OWNERS.map((o) => row[o.key]),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })
  }, [inScope, wave, stage, search])

  // Summarised over the release, not the filtered view, so the totals do not
  // change as you narrow the list -- and so "Complete" still reports the rows
  // the default filter is hiding.
  const summary = useMemo(() => summarise(inScope), [inScope])

  /** How many rows the stage filter alone is hiding, for the count line. */
  const hiddenByStage = useMemo(() => {
    if (stage === 'all') return 0
    return inScope.filter((r) => stageOf(r) !== stage).length
  }, [inScope, stage])

  /** Rows grouped so a shared Item renders once via rowSpan. */
  const grouped = useMemo(() => groupByItem(visible), [visible])

  /**
   * The date already on record for each PI + wave, from every loaded row — not
   * just the filtered view, and deliberately including the PIs the grid hides,
   * because the form can still be pointed at one. Passed to DeploymentForm,
   * which uses it to keep Release Date in step with the PI and wave.
   */
  const releaseDates = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of rows) {
      if (row.ReleaseDate) {
        const key = releaseKey(row.PINumberRelease, row.ReleaseWave)
        if (!map.has(key)) map.set(key, row.ReleaseDate)
      }
    }
    return map
  }, [rows])

  // ---------------------------------------------------------------- actions

  /**
   * Ticking a gate stamps today and clearing it clears both flag and date, and
   * neither touches any other field: this is the action people take twenty times
   * a day, and it must not be capable of overwriting a column the clicker never
   * looked at.
   */
  const toggleGate = async (row: Deployment, gate: GateKey) => {
    setBusyId(row.DeploymentId)
    try {
      const passed = !row[gate]
      const next = await api.setDeploymentGate(
        row.DeploymentId,
        gate,
        passed,
        passed ? todayLocal() : null,
        row.LastModified,
      )
      replaceRow(next)
      // Prod is the gate the release summary counts, so its picker goes stale.
      if (gate === 'DeployedToProd') void loadContext()
    } catch (e) {
      handleWriteError(e)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Creating several components under one item is several creates — there is
   * no multi-row endpoint and no transaction spanning them. So they go one at
   * a time and a failure partway through reports exactly how far it got,
   * rather than claiming the whole thing failed when rows were already
   * written. The successful ones stay; the form stays open on the rest.
   */
  const save = async (values: DeploymentInput[]) => {
    setSaving(true)
    setSaveError(null)
    try {
      const pending = [...values]
      let updated: Deployment | null = null

      // When editing, the first entry is the row already on screen. Everything
      // after it — in either mode — is a new row under the same item.
      if (editing && editing !== 'new') {
        updated = await api.updateDeployment(
          editing.DeploymentId,
          pending.shift()!,
          editing.LastModified,
        )
        replaceRow(updated)
      }

      const created: Deployment[] = []
      let failure: string | null = null
      for (const value of pending) {
        try {
          created.push(await api.createDeployment(value))
        } catch (e) {
          failure = e instanceof ApiError ? e.message : String(e)
          break
        }
      }
      // Whatever got written is real, so it goes into the grid either way.
      if (created.length) setRows((current) => [...created, ...current])

      const done = created.length + (updated ? 1 : 0)
      if (failure) {
        setSaveError(
          done
            ? `Saved ${done} of ${values.length} components, then stopped. Those ${done} ` +
              `are already in the tracker — take them off the list before retrying, or ` +
              `this will report them as duplicates. ${failure}`
            : failure,
        )
        void loadContext()
        return
      }

      const item = (updated ?? created[0])?.Item
      notify(
        'success',
        done === 1
          ? updated
            ? `Saved ${labelOf(updated)}.`
            : `Tracking ${labelOf(created[0])}.`
          : `Saved ${done} components under ${item ?? 'this item'}.`,
      )
      setEditing(null)
      void loadContext()
    } catch (e) {
      // Shown inside the still-open form, so nothing typed is lost.
      setSaveError(e instanceof ApiError ? e.message : String(e))
      void loadContext()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: Deployment) => {
    if (
      !window.confirm(
        `Remove ${labelOf(row)} from the tracker?\n\n` +
          'This deletes the row and its gate history outright — unlike the Dependency ' +
          'Graph tab, there is no deactivate here and no undo.',
      )
    ) {
      return
    }
    setBusyId(row.DeploymentId)
    try {
      const result = await api.deleteDeployment(row.DeploymentId, row.LastModified)
      setRows((current) => current.filter((r) => r.DeploymentId !== row.DeploymentId))
      notify('success', result.message)
      void loadContext()
    } catch (e) {
      handleWriteError(e)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Move a row to another release straight from the grid.
   *
   * The release date comes with it: a date belongs to the release, not to the
   * row, so leaving the old one behind would claim the item ships on a day its
   * new release does not. A release nobody has dated yet has nothing to point
   * at, so the row keeps the date it had rather than being blanked.
   *
   * Reloads afterwards because PI and wave are the grid's first sort keys and
   * drive the Item row-spanning — a moved row left sitting among its old
   * release's rows would be grouped under the wrong item.
   */
  const changeRelease = async (row: Deployment, key: string) => {
    const [pi, wave] = JSON.parse(key) as [string, string]
    const nextPI = pi || null
    const nextWave = wave || null
    if (nextPI === row.PINumberRelease && nextWave === row.ReleaseWave) return

    const { DeploymentId, CreatedBy, CreatedDate, LastModified, LastModifiedBy, ...values } = row
    setBusyId(row.DeploymentId)
    try {
      const next = await api.updateDeployment(
        row.DeploymentId,
        {
          ...values,
          PINumberRelease: nextPI,
          ReleaseWave: nextWave,
          ReleaseDate: releaseDates.get(key) ?? row.ReleaseDate,
        },
        row.LastModified,
      )
      replaceRow(next)
      notify('success', `Moved ${labelOf(next)} to ${piRelease(next)}.`)
      void loadRows()
      void loadContext()
    } catch (e) {
      handleWriteError(e)
    } finally {
      setBusyId(null)
    }
  }

  /** Double-click Component Name or Notes to edit it in place, without
   *  opening Edit. */
  const startInlineEdit = (row: Deployment, field: InlineField) => {
    if (busyId === row.DeploymentId) return
    setInlineEdit({ id: row.DeploymentId, field })
    setInlineDraft(row[field] ?? '')
  }

  useEffect(() => {
    if (inlineEdit) {
      inlineInputRef.current?.focus()
      inlineInputRef.current?.select()
    }
    // Re-run whenever *which* cell is active changes, not just whether one is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineEdit?.id, inlineEdit?.field])

  const cancelInlineEdit = () => {
    cancelledInlineEdit.current = true
    setInlineEdit(null)
  }

  /**
   * Writes the whole row back, like the Edit dialog does — there is no
   * partial-field write path other than the dedicated gate endpoint — but only
   * the one field changes, so this stays a double-click-and-type action
   * instead of opening the dialog for a one-field edit.
   */
  const commitInlineEdit = async (row: Deployment, field: InlineField) => {
    const nextValue = inlineDraft.trim() || null
    if (nextValue === (row[field] ?? null)) {
      setInlineEdit(null)
      return
    }
    if (field === 'ComponentName' && !nextValue && !(row.Item ?? '').trim()) {
      // Same rule the Edit dialog enforces: a row needs a name or an item to
      // stay findable. Left open so the typed text is not lost.
      notify(
        'error',
        'Give it a Component Name or an Item — clearing both would make this row impossible to find again.',
      )
      return
    }

    const { DeploymentId, CreatedBy, CreatedDate, LastModified, LastModifiedBy, ...values } = row
    setBusyId(row.DeploymentId)
    try {
      const next = await api.updateDeployment(
        row.DeploymentId,
        { ...values, [field]: nextValue },
        row.LastModified,
      )
      replaceRow(next)
      // A guarded clear: if a double-click on a *different* cell already
      // started a new inline edit while this write was in flight, that edit
      // must win — closing whatever is active now would cut it off mid-type.
      setInlineEdit((current) =>
        current && current.id === row.DeploymentId && current.field === field ? null : current,
      )
      if (field === 'ComponentName') void loadContext()
    } catch (e) {
      // Left open on failure, same as the dialog: nothing typed is lost.
      handleWriteError(e)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Renders one inline-editable text cell: the plain display, or the editor
   * input when this exact row+field is the one currently active. Shared
   * between Component Name and Notes so the double-click/Enter/Escape/blur
   * wiring exists in exactly one place.
   */
  const inlineTextCell = (row: Deployment, field: InlineField, display: React.ReactNode, title: string) => {
    if (readOnly) return <span>{display}</span>
    if (inlineEdit?.id === row.DeploymentId && inlineEdit.field === field) {
      return (
        <input
          ref={inlineInputRef}
          className="cell inline-edit"
          type="text"
          value={inlineDraft}
          disabled={busyId === row.DeploymentId}
          onChange={(e) => setInlineDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commitInlineEdit(row, field)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelInlineEdit()
            }
          }}
          onBlur={() => {
            if (cancelledInlineEdit.current) {
              cancelledInlineEdit.current = false
              return
            }
            void commitInlineEdit(row, field)
          }}
        />
      )
    }
    return (
      <span className="editable-inline" onDoubleClick={() => startInlineEdit(row, field)} title={title}>
        {display}
      </span>
    )
  }

  // ---------------------------------------------------------------- render

  const showRelease = release === ALL_RELEASES

  return (
    <>
      {Object.entries(suggestions).map(([name, values]) => (
        <datalist id={`dep-${name}`} key={name}>
          {values.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      ))}

      <p className="page-sub">
        PI 27.3 onward. Every component moving through a release, in{' '}
        <code>WH_HDX_DE_Silver.deploy</code>. Tick a gate to stamp today's date and
        your initials; open <strong>Edit</strong> to set a different date. A ticked
        gate showing <strong>–</strong> instead of a date came from the spreadsheet,
        which recorded only Y/N — those have no initials either. Edits are written
        straight to the warehouse — there is no publish step.
      </p>

      <div className="toolbar">
        <label className="picker">
          <span>PI</span>
          <select
            value={release}
            onChange={(e) => {
              setRelease(e.target.value)
              // The release list is per-PI, so a stale choice from the previous
              // PI would silently match nothing.
              setWave(ANY)
            }}
          >
            <option value={ALL_RELEASES}>All PIs ({trackedRows.length})</option>
            {releases.map((r) => (
              <option key={r.release} value={r.release}>
                {r.release} ({r.components})
              </option>
            ))}
          </select>
        </label>

        <label className="picker">
          <span>Release</span>
          <select
            value={wave}
            onChange={(e) => setWave(e.target.value)}
            title={`Each release with its date. (Complete) means every component in it has passed all ${GATES.length} tracked gates.`}
          >
            <option value={ANY}>All releases ({inScope.length})</option>
            {groupByPi
              ? // Wave 1 exists in more than one PI, so the options need a heading
                // to say which release is which.
                [...new Set(waveOptions.map((o) => o.pi))].map((pi) => (
                  <optgroup key={pi} label={pi}>
                    {waveOptions
                      .filter((o) => o.pi === pi)
                      .map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                  </optgroup>
                ))
              : waveOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
          </select>
        </label>

        <input
          className="search"
          type="search"
          placeholder="Search component, item or owner…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <select
          value={stage}
          onChange={(e) => setStage(e.target.value as StageFilter)}
          title={`Complete means all ${GATES.length} tracked gates passed.`}
        >
          <option value="all">All stages</option>
          <option value="not-started">Not started</option>
          <option value="in-progress">In progress</option>
          <option value="completed">Completed only</option>
        </select>

        <button
          onClick={() => {
            void loadRows()
            void loadContext()
          }}
          disabled={loading || saving}
        >
          Refresh
        </button>

        {!readOnly && (
          <button className="primary" onClick={() => setEditing('new')}>
            Track a component
          </button>
        )}

        <span className="count">
          {loading
            ? 'loading…'
            : `${visible.length} of ${trackedRows.length} components` +
              (hiddenByStage ? ` · ${hiddenByStage} hidden by stage filter` : '')}
        </span>
      </div>

      {stale && (
        <div className="notice error">
          <span>
            <strong>Someone else changed this component — your change was not applied</strong>
            {stale}
          </span>
          <button
            className="dismiss"
            title="Reload the tracker from the warehouse"
            onClick={() => {
              setStale(null)
              void loadRows()
            }}
          >
            ⟳
          </button>
        </div>
      )}

      <section className="panel">
        <div className="panel-body">
          <div className="kpi-row">
            <div className="kpi">
              <span className="kpi-label">Components</span>
              <span className="kpi-value">{summary.total}</span>
              <span className="kpi-note">{showRelease ? 'across all releases' : release}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Not started</span>
              <span className="kpi-value">{summary.notStarted}</span>
              <span className="kpi-note">no gate passed yet</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">In progress</span>
              <span className="kpi-value">{summary.inProgress}</span>
              <span className="kpi-note">started, not in Prod</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Deployed</span>
              <span className="kpi-value">{summary.deployed}</span>
              <span className="kpi-note">live in Production</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Complete</span>
              <span className="kpi-value">{summary.completed}</span>
              <span className="kpi-note">
                all {GATES.length} gates
                {stage !== 'all' && stage !== 'completed' ? ' · hidden below' : ''}
              </span>
            </div>
          </div>
        </div>
      </section>

      {!loading && !visible.length ? (
        <div className="table-scroll">
          <div className="empty">
            {!trackedRows.length ? (
              'Nothing tracked yet in PI 27.3 or later. Use Track a component to add the first one.'
            ) : hiddenByStage ? (
              <>
                No components match the current filters — {hiddenByStage} row
                {hiddenByStage === 1 ? ' is' : 's are'} hidden by the stage filter.{' '}
                <button className="link" onClick={() => setStage('all')}>
                  Show all stages
                </button>
              </>
            ) : (
              'No components match the current filters.'
            )}
          </div>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="gridtable">
            <thead>
              <tr>
                <th style={{ minWidth: 56 }} title="High / Medium / Low priority">
                  Priority
                </th>
                <th style={{ minWidth: 68 }} title="Who asked for the work">
                  Requestor
                </th>
                <th style={{ minWidth: 180 }}>Item</th>
                <th style={{ minWidth: 200 }}>Component</th>
                <th style={{ minWidth: 78 }} title="PI and release wave, e.g. 27.3.1">
                  PI / Release
                </th>
                <th style={{ minWidth: 96 }}>Release date</th>
                <th style={{ minWidth: 128 }}>Progress</th>
                {GATES.map((gate) => (
                  <th key={gate.key} style={{ minWidth: 62 }} title={gate.label}>
                    {gate.short}
                  </th>
                ))}
                {TABLE_OWNERS.map((owner) => (
                  <th key={owner.key} style={{ minWidth: 110 }}>
                    {owner.label}
                  </th>
                ))}
                <th style={{ minWidth: 140 }}>Notes</th>
                {!readOnly && <th />}
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ row, itemSpan }) => {
                const busy = busyId === row.DeploymentId
                const passed = gatesPassed(row)
                const complete = passed === GATES.length
                return (
                  <tr key={row.DeploymentId}>
                    {/* Priority and Requestor are set once per item, not per
                        component — every component under one item shares
                        both — so they row-span exactly like Item does, and
                        for the same reason: repeating them per component row
                        would just be restating the same value. */}
                    {itemSpan > 0 && (
                      <td className="prio-cell" rowSpan={itemSpan > 1 ? itemSpan : undefined}>
                        <span
                          className={`prio prio--${priorityOf(row)}`}
                          title={priorityTitle(row)}
                        >
                          {priorityFlagText(priorityOf(row))}
                        </span>
                      </td>
                    )}

                    {itemSpan > 0 && (
                      <td className="muted nowrap" rowSpan={itemSpan > 1 ? itemSpan : undefined}>
                        {row.Requestor ?? '—'}
                      </td>
                    )}

                    {itemSpan > 0 && (
                      <td rowSpan={itemSpan > 1 ? itemSpan : undefined}>
                        {readOnly ? (
                          row.Item ?? <span className="muted">—</span>
                        ) : (
                          <span
                            className="open-edit"
                            onDoubleClick={() => setEditing(row)}
                            title="Double-click to open the Edit dialog"
                          >
                            {row.Item ?? <span className="muted">—</span>}
                          </span>
                        )}
                      </td>
                    )}

                    <td className="name">
                      {inlineTextCell(
                        row,
                        'ComponentName',
                        row.ComponentName ?? (
                          // Planned work often has no component yet; the item
                          // in the previous column is the only handle on it.
                          <span className="muted" title="No component name provided">
                            no component name provided
                          </span>
                        ),
                        'Double-click to edit the component name',
                      )}
                      {row.ComponentType && (
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {row.ComponentType}
                        </div>
                      )}
                    </td>

                    <td className="muted nowrap" title={row.PINumberRelease ?? undefined}>
                      {readOnly ? (
                        piRelease(row)
                      ) : (
                        <select
                          className="cell release-select"
                          value={releaseKey(row.PINumberRelease, row.ReleaseWave)}
                          disabled={busy}
                          aria-label={`Release for ${labelOf(row)}`}
                          title="Move this component to another release. Its release date moves with it."
                          onChange={(e) => void changeRelease(row, e.target.value)}
                        >
                          {/* A row whose release is not among the options —
                              possible only if it moved underneath us — still
                              needs its own value selectable, or the dropdown
                              would silently show someone else's release. */}
                          {!releaseChoices.some(
                            (o) => o.value === releaseKey(row.PINumberRelease, row.ReleaseWave),
                          ) && (
                            <option value={releaseKey(row.PINumberRelease, row.ReleaseWave)}>
                              {piRelease(row)}
                            </option>
                          )}
                          {releaseChoices.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.token}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="muted nowrap" title={row.ReleaseDate ?? undefined}>
                      {row.ReleaseDate ? formatDate(row.ReleaseDate) : '—'}
                    </td>

                    <td>
                      <div
                        className={`gate-progress${complete ? ' is-complete' : ''}`}
                        role="img"
                        aria-label={`${passed} of ${GATES.length} gates passed`}
                        title={stageLabel(row)}
                      >
                        <span
                          className="gate-progress-fill"
                          style={{ width: `${(passed / GATES.length) * 100}%` }}
                        />
                      </div>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {passed}/{GATES.length} · {stageLabel(row)}
                      </div>
                    </td>

                    {GATES.map((gate) => {
                      const passed = row[gate.key]
                      const on = row[gate.dateKey]
                      // Who ticked it — stamped automatically, so blank on
                      // anything passed before this column existed or
                      // imported from the spreadsheet, same as the date.
                      const by = row[gate.byKey]
                      return (
                        <td key={gate.key} className="gate-cell">
                          {readOnly ? (
                            <span
                              className={`badge${passed ? ' on' : ' off'}`}
                              title={
                                passed
                                  ? `${gate.label}: passed${on ? ` ${on}` : ''}${by ? ` by ${by}` : ''}.`
                                  : `${gate.label}: not yet.`
                              }
                            >
                              {passed ? '✓' : '–'}
                            </span>
                          ) : (
                            <input
                              type="checkbox"
                              checked={passed}
                              disabled={busy}
                              aria-label={`${gate.label} for ${labelOf(row)}`}
                              title={
                                !passed
                                  ? `${gate.label}: not yet. Ticking stamps today and your initials.`
                                  : on
                                    ? `${gate.label}: passed ${on}${by ? ` by ${by}` : ''}. Unticking clears it.`
                                    : `${gate.label}: passed, day not recorded (imported from the spreadsheet). Unticking clears it.`
                              }
                              onChange={() => void toggleGate(row, gate.key)}
                            />
                          )}
                          {/* Month-day only: the year is on the release, and
                              eleven full dates would not fit on any screen. An
                              en dash marks "passed, day unknown" so it is
                              visibly different from a blank not-passed cell.
                              Initials sit right after the date, on the same
                              line, for the same space reason. */}
                          <span className="gate-date" title={on ?? undefined}>
                            {passed ? (on ? on.slice(5) : '–') : ''}
                            {passed && by ? ` ${by}` : ''}
                          </span>
                        </td>
                      )
                    })}

                    {TABLE_OWNERS.map((owner) => (
                      <td key={owner.key} className="muted">
                        {row[owner.key] ?? '—'}
                      </td>
                    ))}

                    <td className="muted note-cell">
                      {inlineTextCell(
                        row,
                        'Notes',
                        row.Notes ?? (
                          // An empty string renders no box at all, so a blank
                          // note would be nothing to double-click on. This
                          // placeholder is what makes "add a note" reachable.
                          <span className="muted" title="No note yet">
                            add a note
                          </span>
                        ),
                        // The full text, since the cell truncates with an ellipsis —
                        // this is the only way to read a long note without opening
                        // Edit — plus the same discoverability hint as Component Name.
                        row.Notes ? `${row.Notes}\n\nDouble-click to edit.` : 'Double-click to add a note.',
                      )}
                    </td>

                    {!readOnly && (
                      <td className="actions">
                        <button onClick={() => setEditing(row)} disabled={busy}>
                          Edit
                        </button>{' '}
                        <button
                          className="danger"
                          onClick={() => void remove(row)}
                          disabled={busy}
                          title="Delete this row and its gate history"
                        >
                          {busy ? '…' : 'Remove'}
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <DeploymentForm
          deployment={editing === 'new' ? null : editing}
          releaseDates={releaseDates}
          saving={saving}
          error={saveError}
          onSave={(values) => void save(values)}
          onCancel={() => {
            setEditing(null)
            setSaveError(null)
          }}
        />
      )}
    </>
  )
}
