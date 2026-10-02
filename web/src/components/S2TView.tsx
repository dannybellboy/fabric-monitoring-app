import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError, api } from '../api'
import S2TValidationModal from './S2TValidationModal'
import S2TCheckModal from './S2TCheckModal'
import {
  EMPTY_S2T_COLUMN,
  EMPTY_S2T_METADATA,
} from '../types'
import type {
  S2TColumn,
  S2TColumnIn,
  S2TMapping,
  S2TMetadataIn,
  S2TSuggestions,
  S2TTableRef,
  S2TTarget,
  S2TValidation,
} from '../types'

interface Props {
  notify: (kind: 'success' | 'error', text: string) => void
  /** Hides create/edit/delete and switches fields to a static display — a
   *  stand-in for a real Fabric permission check. */
  readOnly?: boolean
  /** Hides "Validate against DDL" and "Check all DDLs" — Non HDX User gets no
   *  DDL validation. Defaults to true so every other caller keeps today's
   *  behaviour. */
  canValidate?: boolean
}

/** The long SQL fields get textareas; everything else a single line. */
const LONG_FIELDS: (keyof S2TMetadataIn)[] = [
  'base_table_logic',
  'join_logic',
  'filter_logic',
  'table_description',
]

const METADATA_LABELS: Record<keyof S2TMetadataIn, string> = {
  load_method: 'Load method',
  procedure_name: 'Procedure name',
  workflow: 'Workflow',
  base_table_logic: 'Base table logic',
  join_logic: 'Join logic',
  filter_logic: 'Filter logic',
  table_description: 'Table description',
}

/** Grid columns, in display order. `wide` fields get more room. */
const COLUMN_GRID: {
  key: keyof S2TColumnIn
  label: string
  kind: 'text' | 'number' | 'bool'
  list?: string
  wide?: boolean
}[] = [
  { key: 'column_ordinal', label: '#', kind: 'number' },
  { key: 'data_type', label: 'Data type', kind: 'text', list: 'data_type' },
  { key: 'not_null', label: 'Not null', kind: 'bool' },
  { key: 'field_category', label: 'Field category', kind: 'text', list: 'field_category' },
  { key: 'transformation', label: 'Transformation', kind: 'text', wide: true },
  { key: 'source_table_name', label: 'Source table', kind: 'text' },
  { key: 'source_column_name', label: 'Source column', kind: 'text' },
  { key: 'mapping_status', label: 'Mapping', kind: 'text', list: 'mapping_status' },
  { key: 'dev_status', label: 'Dev', kind: 'text', list: 'dev_status' },
  { key: 'change_requiring_update', label: 'Needs update', kind: 'bool' },
  { key: 'business_description', label: 'Business description', kind: 'text', wide: true },
]

const blank = (value: string | null | undefined) => (value ?? '') as string

/** Empty input means NULL — the table uses NULL, not '', for "unset". */
const toNull = (value: string) => (value.trim() === '' ? null : value)

function pickEditable(row: S2TColumn): S2TColumnIn {
  const { table_name, column_name, medallion_layer, last_modified, last_modified_by, ...rest } = row
  return rest
}

function metadataOf(mapping: S2TMapping | null): S2TMetadataIn {
  if (!mapping?.metadata) return { ...EMPTY_S2T_METADATA }
  const {
    table_name,
    medallion_layer,
    last_modified,
    last_modified_by,
    ...rest
  } = mapping.metadata
  return rest
}

export default function S2TView({ notify, readOnly, canValidate = true }: Props) {
  const [targets, setTargets] = useState<S2TTarget[]>([])
  const [target, setTarget] = useState('')
  const [tables, setTables] = useState<S2TTableRef[]>([])
  const [orphans, setOrphans] = useState<S2TTableRef[]>([])
  const [table, setTable] = useState('')
  const [filter, setFilter] = useState('')

  const [mapping, setMapping] = useState<S2TMapping | null>(null)
  const [suggestions, setSuggestions] = useState<S2TSuggestions>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  /** Metadata draft, plus the columns draft keyed by the row's original name. */
  const [metaDraft, setMetaDraft] = useState<S2TMetadataIn>({ ...EMPTY_S2T_METADATA })
  const [colDrafts, setColDrafts] = useState<Record<string, S2TColumnIn>>({})
  const [renames, setRenames] = useState<Record<string, string>>({})

  const [creating, setCreating] = useState(false)
  const [newTable, setNewTable] = useState('')
  const [copyPrompt, setCopyPrompt] = useState(false)
  const [copyName, setCopyName] = useState('')
  const [addingColumn, setAddingColumn] = useState(false)
  const [newColumn, setNewColumn] = useState('')
  /** Set when the server refuses a write because the row moved (HTTP 412). */
  const [stale, setStale] = useState<string | null>(null)
  /** True when a background focus refetch was skipped to protect unsaved edits. */
  const [mayBeStale, setMayBeStale] = useState(false)

  const [validation, setValidation] = useState<S2TValidation | null>(null)
  const [validating, setValidating] = useState(false)
  const [checkModalOpen, setCheckModalOpen] = useState(false)

  useEffect(() => {
    api
      .s2tTargets()
      .then((list) => {
        setTargets(list)
        if (list.length && !target) setTarget(list[0].target)
      })
      .catch((e) => notify('error', `Could not list targets: ${e.message}`))
    api.s2tSuggestions().then(setSuggestions).catch(() => {
      /* datalists are a convenience; the inputs still work without them */
    })
    // Intentionally once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!target) return
    setTable('')
    setMapping(null)
    Promise.all([api.s2tTables(target), api.s2tOrphans(target)])
      .then(([list, orphanList]) => {
        setTables(list)
        setOrphans(orphanList)
      })
      .catch((e) => notify('error', `Could not list ${target} tables: ${e.message}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const load = useCallback(
    async (t: string, tbl: string) => {
      setLoading(true)
      try {
        const next = await api.s2tMapping(t, tbl)
        setMapping(next)
        setMetaDraft(metadataOf(next))
        setColDrafts(
          Object.fromEntries(next.columns.map((c) => [c.column_name, pickEditable(c)])),
        )
        setRenames({})
        setStale(null)
        setMayBeStale(false)
        setValidation(null)
      } catch (e) {
        notify('error', e instanceof ApiError ? e.message : String(e))
        setMapping(null)
      } finally {
        setLoading(false)
      }
    },
    [notify],
  )

  useEffect(() => {
    if (target && table) void load(target, table)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, table])

  // Switching to read-only mid-edit should not leave an edit prompt open behind it.
  useEffect(() => {
    if (!readOnly) return
    setCreating(false)
    setCopyPrompt(false)
    setAddingColumn(false)
  }, [readOnly])

  const visibleTables = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return tables
    return tables.filter((t) => t.table_name.toLowerCase().includes(needle))
  }, [tables, filter])

  const metaDirty = useMemo(() => {
    const original = metadataOf(mapping)
    return (Object.keys(original) as (keyof S2TMetadataIn)[]).some(
      (k) => blank(original[k]) !== blank(metaDraft[k]),
    )
  }, [mapping, metaDraft])

  const dirtyColumns = useMemo(() => {
    if (!mapping) return []
    return mapping.columns.filter((row) => {
      const draft = colDrafts[row.column_name]
      if (!draft) return false
      const original = pickEditable(row)
      const renamed = (renames[row.column_name] ?? row.column_name) !== row.column_name
      return (
        renamed ||
        (Object.keys(original) as (keyof S2TColumnIn)[]).some(
          (k) => String(original[k] ?? '') !== String(draft[k] ?? ''),
        )
      )
    })
  }, [mapping, colDrafts, renames])

  const blocked = mapping?.duplicates.metadataRows !== undefined && mapping.duplicates.metadataRows > 1
  const blockedColumns = new Set(
    (mapping?.duplicates.duplicateColumns ?? []).map((d) => d.columnName),
  )

  const anyDirty = metaDirty || dirtyColumns.length > 0

  /**
   * Re-read the mapping when the window regains focus, since HDX.* is shared and
   * may have moved while you were elsewhere.
   *
   * Never while there are unsaved edits: silently replacing a draft with server
   * state would destroy work. In that case it only flags that the view may be
   * behind, and the save's own version check is what actually protects the data.
   */
  useEffect(() => {
    const onFocus = () => {
      if (!target || !table || saving) return
      if (anyDirty) {
        setMayBeStale(true)
        return
      }
      void load(target, table)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [target, table, anyDirty, saving, load])

  /**
   * A 412 means someone else changed the row after it was loaded, so the write was
   * refused rather than silently overwriting them. It gets a persistent banner with
   * a Reload action instead of a toast, because it needs a decision, not a dismissal.
   */
  const handleWriteError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 412) setStale(e.message)
    else notify('error', e instanceof ApiError ? e.message : String(e))
  }

  // ---------------------------------------------------------------- actions

  const saveMetadata = async () => {
    if (!mapping?.metadata) return
    setSaving(true)
    try {
      const next = await api.s2tUpdateMapping(
        mapping.metadata.table_name,
        mapping.metadata.medallion_layer,
        metaDraft,
        mapping.metadata.last_modified,
      )
      setMapping(next)
      setMetaDraft(metadataOf(next))
      notify('success', `Saved metadata for ${mapping.metadata.table_name}.`)
    } catch (e) {
      handleWriteError(e)
    } finally {
      setSaving(false)
    }
  }

  const saveColumns = async () => {
    if (!mapping || !dirtyColumns.length) return
    setSaving(true)
    let latest: S2TMapping | null = null
    try {
      // Sequential, not parallel: each response is a fresh snapshot of the whole
      // mapping, and concurrent writes to the same table would race.
      for (const row of dirtyColumns) {
        const draft = colDrafts[row.column_name]
        const rename = renames[row.column_name]
        latest = await api.s2tUpdateColumn(
          row.table_name,
          row.medallion_layer,
          row.column_name,
          draft,
          rename && rename !== row.column_name ? rename : null,
          row.last_modified,
        )
      }
      if (latest) {
        setMapping(latest)
        setColDrafts(
          Object.fromEntries(latest.columns.map((c) => [c.column_name, pickEditable(c)])),
        )
        setRenames({})
      }
      notify('success', `Saved ${dirtyColumns.length} column(s).`)
    } catch (e) {
      handleWriteError(e)
      // Reload so the grid reflects what actually landed after a partial failure.
      if (target && table) void load(target, table)
    } finally {
      setSaving(false)
    }
  }

  const validateAgainstDdl = async () => {
    if (!target || !table) return
    setValidating(true)
    try {
      setValidation(await api.s2tValidate(target, table))
    } catch (e) {
      notify('error', e instanceof ApiError ? e.message : String(e))
    } finally {
      setValidating(false)
    }
  }

  const removeColumn = async (row: S2TColumn) => {
    if (!window.confirm(`Delete column ${row.column_name} from ${row.table_name}?`)) return
    setSaving(true)
    try {
      const next = await api.s2tDeleteColumn(
        row.medallion_layer,
        row.table_name,
        row.column_name,
        row.last_modified,
      )
      setMapping(next)
      setColDrafts(Object.fromEntries(next.columns.map((c) => [c.column_name, pickEditable(c)])))
      notify('success', `Deleted ${row.column_name}.`)
    } catch (e) {
      handleWriteError(e)
    } finally {
      setSaving(false)
    }
  }

  const addColumn = async () => {
    const name = newColumn.trim()
    if (!name || !mapping?.metadata) return
    setSaving(true)
    try {
      const nextOrdinal =
        Math.max(0, ...mapping.columns.map((c) => c.column_ordinal ?? 0)) + 1
      const next = await api.s2tCreateColumn(
        mapping.metadata.table_name,
        mapping.metadata.medallion_layer,
        name,
        { ...EMPTY_S2T_COLUMN, column_ordinal: nextOrdinal },
      )
      setMapping(next)
      setColDrafts(Object.fromEntries(next.columns.map((c) => [c.column_name, pickEditable(c)])))
      setNewColumn('')
      setAddingColumn(false)
      notify('success', `Added ${name}.`)
    } catch (e) {
      notify('error', e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const createMapping = async () => {
    const name = newTable.trim()
    if (!name) return
    setSaving(true)
    try {
      await api.s2tCreateMapping(name, target, { ...EMPTY_S2T_METADATA })
      setTables(await api.s2tTables(target))
      setNewTable('')
      setCreating(false)
      setTable(name)
      notify('success', `Created mapping for ${name} in ${target}.`)
    } catch (e) {
      notify('error', e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const deleteMapping = async () => {
    if (!mapping?.metadata) return
    const name = mapping.metadata.table_name
    const typed = window.prompt(
      `This deletes the metadata row AND all ${mapping.columns.length} column(s) for ` +
        `${name} in ${target}.\n\nType the table name to confirm:`,
    )
    if (typed !== name) {
      if (typed !== null) notify('error', 'Name did not match — nothing was deleted.')
      return
    }
    setSaving(true)
    try {
      const result = await api.s2tDeleteMapping(
        target,
        name,
        mapping.metadata.last_modified,
      )
      notify('success', result.message)
      setTable('')
      setMapping(null)
      setTables(await api.s2tTables(target))
    } catch (e) {
      notify('error', e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const createCopy = async () => {
    if (!mapping?.metadata) return
    const original = mapping.metadata.table_name
    const defaultName = `${original}_copy1`
    setCopyName(defaultName)
    setCopyPrompt(true)
  }

  const createCopyConfirmed = async (name: string) => {
    if (!mapping?.metadata) return
    const trimmed = name.trim()
    if (!trimmed) {
      notify('error', 'Name is required — copy aborted.')
      return
    }
    setCopyPrompt(false)
    setSaving(true)
    try {
      const list = await api.s2tTables(target)
      if (list.some((t) => t.table_name === trimmed)) {
        notify('error', `A mapping named ${trimmed} already exists in ${target}. Pick another name.`)
        return
      }

      const metaValues = metadataOf(mapping)
      await api.s2tCreateMapping(trimmed, mapping.metadata.medallion_layer, metaValues)

      for (const col of mapping.columns) {
        const values = pickEditable(col)
        await api.s2tCreateColumn(trimmed, mapping.metadata.medallion_layer, col.column_name, values)
      }

      setTables(await api.s2tTables(target))
      setTable(trimmed)
      await load(target, trimmed)
      notify('success', `Created copy ${trimmed} in ${target}.`)
    } catch (e) {
      notify('error', e instanceof ApiError ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // ---------------------------------------------------------------- render

  const datalists = (
    <>
      {Object.entries(suggestions).map(([name, values]) => (
        <datalist id={`s2t-${name}`} key={name}>
          {values.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      ))}
    </>
  )

  return (
    <>
      {datalists}

      <p className="page-sub">
        The spec that drives table and stored-proc generation, in{' '}
        <code>WH_HDX_DE_Silver.HDX</code>. Edits are written straight to the warehouse
        — there is no staging copy and no publish step.
      </p>

      <div className="toolbar">
        <label className="picker">
          <span>Target</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t.target} value={t.target}>
                {t.target} ({t.mappings})
              </option>
            ))}
          </select>
        </label>

        <label className="picker picker--grow">
          <span>Table</span>
          <select value={table} onChange={(e) => setTable(e.target.value)}>
            <option value="">— select a table —</option>
            {visibleTables.map((t) => (
              <option key={t.table_name} value={t.table_name}>
                {t.table_name} ({t.columns})
              </option>
            ))}
          </select>
        </label>

        <input
          className="search"
          type="search"
          placeholder="Filter tables…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ maxWidth: 200 }}
        />

        {canValidate && (
          <button
            onClick={() => setCheckModalOpen(true)}
            disabled={loading || saving}
            title="Run DDL check across all targets and download JSON report"
          >
            Check all DDLs
          </button>
        )}

        <button
          onClick={() => {
            void (async () => {
              if (target) {
                const [list, orphanList] = await Promise.all([
                  api.s2tTables(target),
                  api.s2tOrphans(target),
                ])
                setTables(list)
                setOrphans(orphanList)
              }
              if (target && table) await load(target, table)
            })()
          }}
          disabled={loading || saving}
          title={
            anyDirty
              ? 'Reloading will discard your unsaved edits'
              : 'Re-read this mapping from the warehouse'
          }
        >
          Refresh
        </button>

        {!readOnly && (
          <button className="primary" onClick={() => setCreating(true)}>
            New table mapping
          </button>
        )}
      </div>

      <S2TCheckModal
        open={checkModalOpen}
        onClose={() => setCheckModalOpen(false)}
        notify={notify}
        targets={targets}
      />

      {stale && (
        <div className="notice error">
          <span>
            <strong>Someone else changed this row — your save was not applied</strong>
            {stale}
          </span>
          <button
            className="dismiss"
            title="Reload from the warehouse (discards your unsaved edits)"
            onClick={() => {
              setStale(null)
              if (target && table) void load(target, table)
            }}
          >
            ⟳
          </button>
        </div>
      )}

      {mayBeStale && !stale && (
        <div className="notice warning">
          <span>
            This mapping was not re-read while you have unsaved edits, so it may be behind
            the warehouse. Your edits are safe — saving checks the row version and will be
            refused rather than overwrite anyone.
          </span>
          <button className="dismiss" onClick={() => setMayBeStale(false)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {creating && (
        <div className="notice info">
          <span>
            <strong>New mapping in {target}</strong>
            <span className="inline-form">
              <input
                type="text"
                autoFocus
                placeholder="Schema.Table_Name"
                value={newTable}
                onChange={(e) => setNewTable(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void createMapping()}
              />
              <button className="primary" onClick={() => void createMapping()} disabled={saving || !newTable.trim()}>
                Create
              </button>
              <button onClick={() => setCreating(false)} disabled={saving}>
                Cancel
              </button>
            </span>
            Creates the <code>Table_Metadata</code> row only; add columns afterwards.
          </span>
        </div>
      )}

      {copyPrompt && (
        <div className="notice info">
          <span>
            <strong>Create copy in {target}</strong>
            <span className="inline-form">
              <input
                type="text"
                autoFocus
                placeholder="Schema.Table_Name_copy"
                value={copyName}
                onChange={(e) => setCopyName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void createCopyConfirmed(copyName)}
              />
              <button className="primary" onClick={() => void createCopyConfirmed(copyName)} disabled={saving || !copyName.trim()}>
                Create
              </button>
              <button onClick={() => setCopyPrompt(false)} disabled={saving}>
                Cancel
              </button>
            </span>
            Enter a unique table name for the copy.
          </span>
        </div>
      )}

      {orphans.length > 0 && (
        <details className="panel">
          <summary>
            {orphans.length} table{orphans.length === 1 ? '' : 's'} in {target} have columns
            but no metadata row
          </summary>
          <div className="panel-body">
            <p className="muted" style={{ marginTop: 0 }}>
              These are invisible to the Table picker because it lists{' '}
              <code>Table_Metadata</code>.{' '}
              {readOnly
                ? 'Read-only view cannot create a mapping to adopt them.'
                : 'Create a mapping with the same name to adopt the existing columns.'}
            </p>
            <div className="chips">
              {orphans.map((o) =>
                readOnly ? (
                  <span key={o.table_name} className="chip">
                    {o.table_name} ({o.columns})
                  </span>
                ) : (
                  <button
                    key={o.table_name}
                    className="chip"
                    onClick={() => {
                      setNewTable(o.table_name)
                      setCreating(true)
                    }}
                    title="Create a metadata row for this table"
                  >
                    {o.table_name} ({o.columns})
                  </button>
                ),
              )}
            </div>
          </div>
        </details>
      )}

      {loading && <p className="muted">Loading mapping…</p>}

      {mapping && blocked && (
        <div className="notice error">
          <span>
            <strong>
              {mapping.duplicates.metadataRows} metadata rows share this name
            </strong>
            <code>{table}</code> appears {mapping.duplicates.metadataRows} times in{' '}
            <code>Table_Metadata</code> for {target}. Neither table has a surrogate key, so
            HDX Management Tool will not guess which row to change — remove the duplicate directly, then
            editing here will work.
          </span>
        </div>
      )}

      {mapping?.duplicates.duplicateColumns.length ? (
        <div className="notice warning">
          <span>
            <strong>Duplicate column names</strong>
            {mapping.duplicates.duplicateColumns
              .map((d) => `${d.columnName} (×${d.count})`)
              .join(', ')}{' '}
            — these specific rows cannot be edited or deleted here until the duplicates are
            resolved.
            {!readOnly && ' Everything else on this table is editable.'}
          </span>
        </div>
      ) : null}

      {mapping && !mapping.metadata && !loading && (
        <div className="notice warning">
          <span>
            No <code>Table_Metadata</code> row for <code>{table}</code> in {target}.
          </span>
        </div>
      )}

      {/* ---------- metadata ---------- */}
      {mapping?.metadata && (
        <section className="panel">
          <div className="panel-head">
            <h3>
              Table metadata <span className="muted">HDX.Table_Metadata</span>
            </h3>
            <div className="panel-actions">
              <span className="muted" style={{ fontSize: 12 }}>
                {mapping.metadata.last_modified_by
                  ? `last edited by ${mapping.metadata.last_modified_by}`
                  : 'never edited'}
                {mapping.metadata.last_modified
                  ? ` on ${mapping.metadata.last_modified.slice(0, 10)}`
                  : ''}
              </span>
              {!readOnly && (
                <>
                  <button className="danger" onClick={() => void deleteMapping()} disabled={saving || blocked}>
                    Delete mapping
                  </button>
                  <button
                    onClick={() => void createCopy()}
                    disabled={saving || !mapping?.metadata}
                    title="Create a copy of this mapping with _copy1 (increments if needed)"
                  >
                    Create a Copy
                  </button>
                  <button
                    className="primary"
                    onClick={() => void saveMetadata()}
                    disabled={saving || !metaDirty || blocked}
                  >
                    {metaDirty ? 'Save metadata' : 'Saved'}
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="panel-body">
            {readOnly ? (
              <>
                <div className="grid-3">
                  {(['load_method', 'procedure_name', 'workflow'] as (keyof S2TMetadataIn)[]).map(
                    (key) => (
                      <div className="field" key={key}>
                        <label>{METADATA_LABELS[key]}</label>
                        <div className="field-value">{blank(metaDraft[key]) || '—'}</div>
                      </div>
                    ),
                  )}
                </div>

                {LONG_FIELDS.map((key) => (
                  <div className="field" key={key}>
                    <label>{METADATA_LABELS[key]}</label>
                    <pre className="field-value field-value--block">{blank(metaDraft[key]) || '—'}</pre>
                  </div>
                ))}
              </>
            ) : (
              <>
                <div className="grid-3">
                  {(['load_method', 'procedure_name', 'workflow'] as (keyof S2TMetadataIn)[]).map(
                    (key) => (
                      <div className="field" key={key}>
                        <label htmlFor={`m-${key}`}>{METADATA_LABELS[key]}</label>
                        <input
                          id={`m-${key}`}
                          type="text"
                          list={key === 'load_method' || key === 'workflow' ? `s2t-${key}` : undefined}
                          value={blank(metaDraft[key])}
                          disabled={blocked}
                          onChange={(e) =>
                            setMetaDraft((d) => ({ ...d, [key]: toNull(e.target.value) }))
                          }
                        />
                      </div>
                    ),
                  )}
                </div>

                {LONG_FIELDS.map((key) => (
                  <div className="field" key={key}>
                    <label htmlFor={`m-${key}`}>
                      {METADATA_LABELS[key]}
                      <span className="muted">
                        {' '}
                        {blank(metaDraft[key]).length} chars
                      </span>
                    </label>
                    <textarea
                      id={`m-${key}`}
                      className="sqlbox"
                      rows={key === 'table_description' ? 4 : 6}
                      spellCheck={key === 'table_description'}
                      value={blank(metaDraft[key])}
                      disabled={blocked}
                      onChange={(e) => setMetaDraft((d) => ({ ...d, [key]: toNull(e.target.value) }))}
                    />
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      )}

      {/* ---------- columns ---------- */}
      {mapping?.metadata && (
        <section className="panel">
          <div className="panel-head">
            <h3>
              Table columns <span className="muted">HDX.Table_Columns</span>
              <span className="badge" style={{ marginLeft: 8 }}>
                {mapping.columns.length}
              </span>
            </h3>
            <div className="panel-actions">
              {canValidate && (
                <button
                  onClick={() => void validateAgainstDdl()}
                  disabled={validating || saving || target.toLowerCase() === 'postgresql'}
                  title={
                    target.toLowerCase() === 'postgresql'
                      ? 'DDL validation is not yet supported for PostgreSQL-layer tables'
                      : `Compare this mapping against ${table}'s live columns in ${target}`
                  }
                >
                  {validating ? 'Validating…' : 'Validate against DDL'}
                </button>
              )}
              {!readOnly && (
                <>
                  <button onClick={() => setAddingColumn(true)} disabled={saving}>
                    Add column
                  </button>
                  <button
                    className="primary"
                    onClick={() => void saveColumns()}
                    disabled={saving || !dirtyColumns.length}
                  >
                    {dirtyColumns.length
                      ? `Save ${dirtyColumns.length} changed column${dirtyColumns.length === 1 ? '' : 's'}`
                      : 'Saved'}
                  </button>
                </>
              )}
            </div>
          </div>

          {!readOnly && addingColumn && (
            <div className="panel-body" style={{ paddingBottom: 0 }}>
              <span className="inline-form">
                <input
                  type="text"
                  autoFocus
                  placeholder="new_column_name"
                  value={newColumn}
                  onChange={(e) => setNewColumn(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void addColumn()}
                />
                <button className="primary" onClick={() => void addColumn()} disabled={saving || !newColumn.trim()}>
                  Add
                </button>
                <button onClick={() => setAddingColumn(false)} disabled={saving}>
                  Cancel
                </button>
              </span>
            </div>
          )}

          <div className="table-scroll" style={{ border: 'none', boxShadow: 'none' }}>
            <table className="gridtable">
              <thead>
                <tr>
                  {!readOnly && <th style={{ width: 34 }} />}
                  <th style={{ minWidth: 180 }}>Column name</th>
                  {COLUMN_GRID.map((c) => (
                    <th key={c.key} style={{ minWidth: c.wide ? 260 : c.kind === 'bool' ? 70 : 120 }}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mapping.columns.map((row) => {
                  const draft = colDrafts[row.column_name] ?? pickEditable(row)
                  const isBlocked = blockedColumns.has(row.column_name)
                  const isDirty = dirtyColumns.some((d) => d.column_name === row.column_name)

                  if (readOnly) {
                    return (
                      <tr key={row.column_name}>
                        <td className="mono">{row.column_name}</td>
                        {COLUMN_GRID.map((c) => (
                          <td key={c.key}>
                            {c.kind === 'bool'
                              ? row[c.key]
                                ? '✓'
                                : ''
                              : row[c.key] === null || row[c.key] === undefined || row[c.key] === ''
                                ? '—'
                                : String(row[c.key])}
                          </td>
                        ))}
                      </tr>
                    )
                  }

                  return (
                    <tr key={row.column_name} className={isDirty ? 'is-dirty' : undefined}>
                      <td className="actions">
                        <button
                          className="iconbtn"
                          title={isBlocked ? 'Duplicate name — resolve first' : 'Delete column'}
                          disabled={saving || isBlocked}
                          onClick={() => void removeColumn(row)}
                        >
                          ×
                        </button>
                      </td>
                      <td>
                        <input
                          className="cell mono"
                          type="text"
                          disabled={isBlocked}
                          value={renames[row.column_name] ?? row.column_name}
                          onChange={(e) =>
                            setRenames((r) => ({ ...r, [row.column_name]: e.target.value }))
                          }
                        />
                      </td>
                      {COLUMN_GRID.map((c) => (
                        <td key={c.key}>
                          {c.kind === 'bool' ? (
                            <input
                              type="checkbox"
                              disabled={isBlocked}
                              checked={draft[c.key] === true}
                              onChange={(e) =>
                                setColDrafts((d) => ({
                                  ...d,
                                  [row.column_name]: { ...draft, [c.key]: e.target.checked },
                                }))
                              }
                            />
                          ) : (
                            <input
                              className={`cell${c.key === 'transformation' ? ' mono' : ''}`}
                              type={c.kind === 'number' ? 'number' : 'text'}
                              list={c.list ? `s2t-${c.list}` : undefined}
                              disabled={isBlocked}
                              value={draft[c.key] === null || draft[c.key] === undefined ? '' : String(draft[c.key])}
                              onChange={(e) => {
                                const raw = e.target.value
                                const value =
                                  c.kind === 'number'
                                    ? raw === ''
                                      ? null
                                      : Number(raw)
                                    : toNull(raw)
                                setColDrafts((d) => ({
                                  ...d,
                                  [row.column_name]: { ...draft, [c.key]: value },
                                }))
                              }}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {mapping.columns.length === 0 && (
              <div className="empty">
                {readOnly ? (
                  'No columns mapped for this table yet.'
                ) : (
                  <>
                    No columns mapped for this table yet. Use <strong>Add column</strong>.
                  </>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {!table && !loading && (
        <div className="table-scroll">
          <div className="empty">
            Pick a target and a table to view and edit its mapping.
          </div>
        </div>
      )}

      {validation && (
        <S2TValidationModal
          table={table}
          target={target}
          validation={validation}
          onClose={() => setValidation(null)}
        />
      )}
    </>
  )
}
