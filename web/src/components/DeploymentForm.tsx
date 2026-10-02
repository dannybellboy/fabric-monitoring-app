import { useEffect, useMemo, useRef, useState } from 'react'

import { releaseKey, todayLocal } from '../deployments'
import { COMPONENT_TYPES, EMPTY_DEPLOYMENT, GATES, OWNERS } from '../types'
import type { Deployment, DeploymentInput } from '../types'

interface Props {
  /** The component being edited, or null to track a new one. */
  deployment: Deployment | null
  /** The date already on record for each PI + wave, keyed by releaseKey(). */
  releaseDates: Map<string, string>
  saving: boolean
  error: string | null
  /**
   * One entry per component. Creating several components under one item saves
   * one row each — the table's grain is one row per component, and the grid
   * already renders a shared Item once across them.
   */
  onSave: (values: DeploymentInput[]) => void
  onCancel: () => void
}

function toInput(row: Deployment | null): DeploymentInput {
  if (!row) return { ...EMPTY_DEPLOYMENT }
  // Server-managed columns are stripped; only the editable ones are sent back.
  const { DeploymentId, CreatedBy, CreatedDate, LastModified, LastModifiedBy, ...input } = row
  return input
}

/** One line of the component repeater. Name and type travel together: the type
 *  describes that component, and both are part of a row's natural key. */
interface ComponentDraft {
  name: string
  type: string
}

function toComponents(row: Deployment | null): ComponentDraft[] {
  return [{ name: row?.ComponentName ?? '', type: row?.ComponentType ?? '' }]
}

/**
 * Every gate's "who passed it", blanked. Applied to rows this form creates
 * alongside an existing one — see rowsToSave.
 *
 * ProdSmokeTestsPassedBy is listed separately because its gate is deliberately
 * absent from GATES; the column still exists and would otherwise be inherited.
 */
const NO_SIGNOFFS: Partial<DeploymentInput> = {
  ...Object.fromEntries(GATES.map((gate) => [gate.byKey, null])),
  ProdSmokeTestsPassedBy: null,
}

export default function DeploymentForm({
  deployment,
  releaseDates,
  saving,
  error,
  onSave,
  onCancel,
}: Props) {
  const [draft, setDraft] = useState<DeploymentInput>(() => toInput(deployment))
  const [components, setComponents] = useState<ComponentDraft[]>(() => toComponents(deployment))
  const firstField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(toInput(deployment))
    setComponents(toComponents(deployment))
  }, [deployment])
  useEffect(() => firstField.current?.focus(), [])

  // Escape closes the dialog, matching every other modal in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const set = <K extends keyof DeploymentInput>(key: K, value: DeploymentInput[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  /** The text- and date-valued fields, i.e. everything but the gate flags. */
  type TextKey = {
    [K in keyof DeploymentInput]: DeploymentInput[K] extends string | null ? K : never
  }[keyof DeploymentInput]

  /** Empty input means NULL — the table uses NULL, not '', for "unset". */
  const field = (key: TextKey) => ({
    value: draft[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(key, e.target.value || null),
  })

  /**
   * Change handlers for PI and Release Wave that also fill in the date already
   * on record for that combination — e.g. picking wave 4 of PI 27.2 fills in
   * 5/14/2026, because every other row in that wave already has that date.
   *
   * Only ever fills a *blank* Release Date, and never overwrites one. That
   * covers opening an existing row for edit (its own date is already set, so
   * this never fires there) and covers picking a wave nobody has dated yet
   * (nothing to fill in, the field is simply left alone for hand entry).
   *
   * Moving a row to another release wholesale is done from the grid's
   * PI / Release dropdown, which does re-date the row — see DeploymentsView.
   */
  const setPI = (value: string | null) =>
    setDraft((current) => ({
      ...current,
      PINumberRelease: value,
      ReleaseDate: current.ReleaseDate ?? releaseDates.get(releaseKey(value, current.ReleaseWave)) ?? null,
    }))

  const setWave = (value: string | null) =>
    setDraft((current) => ({
      ...current,
      ReleaseWave: value,
      ReleaseDate:
        current.ReleaseDate ?? releaseDates.get(releaseKey(current.PINumberRelease, value)) ?? null,
    }))

  /**
   * The rows this form will save: one per filled-in component.
   *
   * A component line with nothing in it is dropped rather than saved as an
   * empty row. If they are *all* empty the form still yields one row, because
   * "an item exists but its component is not decided yet" is the normal state
   * of planned work — 65 of the 73 original PI 27.3 rows looked like that.
   *
   * When editing, entry 0 is the row already on screen and is kept however
   * blank it is — it is that row, not a component being described. Everything
   * after it is a new row sharing this item.
   */
  const rowsToSave = useMemo<DeploymentInput[]>(() => {
    const isFilled = (c: ComponentDraft) => !!(c.name.trim() || c.type.trim())
    let entries: ComponentDraft[]
    if (deployment) {
      entries = [components[0], ...components.slice(1).filter(isFilled)]
    } else {
      const filled = components.filter(isFilled)
      entries = filled.length ? filled : [{ name: '', type: '' }]
    }
    return entries.map((c, index) => ({
      ...draft,
      ComponentName: c.name.trim() || null,
      ComponentType: c.type.trim() || null,
      // Gates and their dates are inherited — components added under one item
      // are being taken through the release together, which is the whole point
      // of grouping them. The sign-off initials are not: those record who
      // personally passed a specific component, and stamping an existing
      // reviewer's name onto a brand-new row would invent an approval nobody
      // gave. The edited row itself keeps its own.
      ...(deployment && index === 0 ? {} : NO_SIGNOFFS),
    }))
  }, [components, draft, deployment])

  /**
   * Nothing is strictly required — planned rows legitimately have only an item —
   * but a row with no name and no item cannot be found again, so that is blocked.
   * Two components with the same name and type would collide on the natural key
   * and the server would refuse the second, so that is caught here instead.
   */
  const localError = useMemo(() => {
    if (!(draft.Item ?? '').trim() && rowsToSave.some((r) => !r.ComponentName)) {
      return 'Give the row a Component Name or an Item, otherwise it cannot be identified.'
    }
    const seen = new Set<string>()
    for (const r of rowsToSave) {
      const key = `${(r.ComponentName ?? '').toLowerCase()}|${(r.ComponentType ?? '').toLowerCase()}`
      if (seen.has(key)) {
        return `${r.ComponentName ?? 'A blank component'} is listed twice with the same type — each component becomes its own row, so they would collide.`
      }
      seen.add(key)
    }
    return null
  }, [draft.Item, rowsToSave])

  /**
   * Gates are allowed to be dated out of order — a component can genuinely go
   * back to QA after a UAT failure — so this warns rather than blocks.
   */
  const outOfOrder = useMemo(() => {
    const passed: { label: string; on: string }[] = []
    for (const gate of GATES) {
      const on = draft[gate.dateKey]
      if (draft[gate.key] && on) passed.push({ label: gate.label, on })
    }
    // ISO dates compare correctly as strings, so no parsing is needed.
    for (let i = 1; i < passed.length; i += 1) {
      if (passed[i].on < passed[i - 1].on) {
        return `${passed[i].label} is dated before ${passed[i - 1].label}. That is allowed — check it is not a typo.`
      }
    }
    return null
  }, [draft])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!localError && !saving) onSave(rowsToSave)
  }

  const setComponent = (index: number, patch: Partial<ComponentDraft>) =>
    setComponents((current) =>
      current.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    )

  const addComponent = () => setComponents((current) => [...current, { name: '', type: '' }])

  const removeComponent = (index: number) =>
    setComponents((current) => current.filter((_, i) => i !== index))

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog dialog--wide"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label={deployment ? 'Edit tracked component' : 'Track a new component'}
      >
        <header>
          <h2>
            {deployment
              ? draft.ComponentName || draft.Item || 'Edit component'
              : 'Track a component'}
          </h2>
          <p>
            {deployment
              ? 'Saved straight to the warehouse — there is no publish step.'
              : 'One row is one component moving through one release. Add several ' +
                'components and each becomes its own row under the same item.'}
          </p>
        </header>

        <div className="body">
          {error && (
            <div className="notice error">
              <span>{error}</span>
            </div>
          )}

          <div className="field">
            <label htmlFor="d-item">Item</label>
            <input
              id="d-item"
              ref={firstField}
              type="text"
              {...field('Item')}
              placeholder="Encounter.EHR_Transactions"
            />
            <div className="hint">
              What the work is about — the row's identity when there is no component
              name yet. Every component below shares it.
            </div>
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="d-requestor">Requestor</label>
              <input
                id="d-requestor"
                type="text"
                list="dep-Requestor"
                {...field('Requestor')}
                placeholder="HDX"
              />
              <div className="hint">Who asked for the work — HDX, HFN, Finance.</div>
            </div>

            <div className="field">
              <label htmlFor="d-priority">Priority</label>
              <input id="d-priority" type="text" list="dep-Priority" {...field('Priority')} />
            </div>
          </div>

          <fieldset>
            <legend>Components</legend>
            <p className="hint" style={{ margin: '0 0 10px' }}>
              {deployment
                ? 'The first line is this row. Anything added below it is saved as a new row under the same item, inheriting the release and gates set here.'
                : 'The tables, procs, reports or pipelines being released. Each one is saved as its own row, all sharing the item, release and gates set here.'}
            </p>

            {components.map((component, index) => (
              // Index as key: these lines have no identity of their own, and the
              // list is only ever appended to or spliced, never reordered.
              <div className="component-row" key={index}>
                <input
                  type="text"
                  aria-label={`Component ${index + 1} name`}
                  value={component.name}
                  onChange={(e) => setComponent(index, { name: e.target.value })}
                  placeholder="SP_Create_Something_Silver"
                />
                <select
                  aria-label={`Component ${index + 1} type`}
                  value={component.type}
                  onChange={(e) => setComponent(index, { type: e.target.value })}
                >
                  <option value="">— no type —</option>
                  {/* A row imported from the spreadsheet, or edited before this
                      list existed, can carry text that matches none of the fixed
                      options below. Keep it selectable so opening the row for an
                      unrelated edit can never silently reset it to blank. */}
                  {component.type && !COMPONENT_TYPES.includes(component.type as never) && (
                    <option value={component.type}>{component.type} (existing)</option>
                  )}
                  {COMPONENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="danger"
                  aria-label={`Remove component ${index + 1}`}
                  title={
                    deployment && index === 0
                      ? 'This line is the row being edited. Use Remove on the grid to delete it.'
                      : 'Remove this component'
                  }
                  // When editing, line 0 *is* the row on screen: removing it
                  // would quietly repurpose that row to whatever line moved up
                  // into its place. Deleting a row is the grid's Remove button.
                  // When creating, the last remaining line stays, because a row
                  // with no component is spelled "blank", not "absent".
                  disabled={deployment ? index === 0 : components.length === 1}
                  onClick={() => removeComponent(index)}
                >
                  ×
                </button>
              </div>
            ))}

            <button type="button" onClick={addComponent} title="Add another component to this item">
              + Add component
            </button>
          </fieldset>

          <div className="grid-3">
            <div className="field">
              <label htmlFor="d-pi">PI Number Release</label>
              <input
                id="d-pi"
                type="text"
                list="dep-PINumberRelease"
                value={draft.PINumberRelease ?? ''}
                onChange={(e) => setPI(e.target.value || null)}
                placeholder="PI 27.3"
              />
            </div>

            <div className="field">
              <label htmlFor="d-wave">Release Wave</label>
              <input
                id="d-wave"
                type="text"
                list="dep-ReleaseWave"
                value={draft.ReleaseWave ?? ''}
                onChange={(e) => setWave(e.target.value || null)}
                placeholder="1"
              />
              <div className="hint">
                The wave within the PI, or BACKLOG. Picking a wave that already has a
                date fills in Release Date.
              </div>
            </div>

            <div className="field">
              <label htmlFor="d-release-date">Release Date</label>
              <input id="d-release-date" type="date" {...field('ReleaseDate')} />
            </div>
          </div>

          <fieldset>
            <legend>Owners</legend>
            <div className="grid-3">
              {OWNERS.map((owner) => (
                <div className="field" key={owner.key}>
                  <label htmlFor={`d-${owner.key}`}>{owner.label}</label>
                  <input
                    id={`d-${owner.key}`}
                    type="text"
                    list={`dep-${owner.key}`}
                    {...field(owner.key)}
                  />
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Gates</legend>
            <p className="hint" style={{ margin: '0 0 10px' }}>
              Tick a gate once it is passed, and give the day if you know it. A ticked
              gate with no date means "passed, day not recorded" — which is how every
              row imported from the spreadsheet arrives.
            </p>
            <div className="grid-2">
              {GATES.map((gate) => {
                const passed = draft[gate.key]
                return (
                  <div className="gate-row" key={gate.key}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={passed}
                        onChange={(e) => {
                          const on = e.target.checked
                          setDraft((current) => ({
                            ...current,
                            [gate.key]: on,
                            // Clearing a gate clears its date: a date with the
                            // flag off would claim it passed on a day it did not.
                            [gate.dateKey]: on ? (current[gate.dateKey] ?? todayLocal()) : null,
                          }))
                        }}
                      />
                      <span>{gate.label}</span>
                    </label>
                    <input
                      type="date"
                      aria-label={`${gate.label} date`}
                      title={
                        passed
                          ? 'The day this gate was passed. Blank means the day is not known.'
                          : 'Tick the gate first.'
                      }
                      disabled={!passed}
                      {...field(gate.dateKey)}
                    />
                  </div>
                )
              })}
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor="d-notes">Notes</label>
            <textarea
              id="d-notes"
              className="sqlbox"
              rows={3}
              spellCheck
              style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13 }}
              value={draft.Notes ?? ''}
              onChange={(e) => set('Notes', e.target.value || null)}
            />
          </div>

          {localError && (
            <div className="notice warning">
              <span>{localError}</span>
            </div>
          )}

          {!localError && outOfOrder && (
            <div className="notice warning">
              <span>{outOfOrder}</span>
            </div>
          )}

          {deployment && (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              Added by {deployment.CreatedBy ?? 'unknown'}
              {deployment.CreatedDate ? ` on ${deployment.CreatedDate.slice(0, 10)}` : ''}
              {deployment.LastModifiedBy
                ? ` · last edited by ${deployment.LastModifiedBy}`
                : ''}
              {deployment.LastModified ? ` on ${deployment.LastModified.slice(0, 10)}` : ''}
            </p>
          )}
        </div>

        <footer>
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving || !!localError}>
            {saving
              ? 'Saving…'
              : deployment
                ? rowsToSave.length > 1
                  ? `Save + add ${rowsToSave.length - 1} row${rowsToSave.length > 2 ? 's' : ''}`
                  : 'Save changes'
                : rowsToSave.length > 1
                  ? `Add ${rowsToSave.length} rows to tracker`
                  : 'Add to tracker'}
          </button>
        </footer>
      </form>
    </div>
  )
}
