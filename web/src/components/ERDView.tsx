import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError, api } from '../api'
import { filteredERD, layoutERD, narrowERD, scopeFrom } from '../erd'
import type { EnvironmentInfo, ERDData, ERDTable } from '../types'
import ERDCanvas from './ERDCanvas'

interface Props {
  notify: (kind: 'success' | 'error', text: string) => void
  envs: EnvironmentInfo[]
  /** Shared with the Lineage and Fabric Monitoring tabs, so picking an
   *  environment on any of the three follows you to the other two. */
  env: string
  onEnvChange: (key: string) => void
}

/** Scope value meaning "every table the spec maps", built or not. */
const FULL_SPEC = 'all'

/** How far a focused view follows relationships out from the clicked table. */
const HOPS = [
  { label: 'Direct', value: 1 },
  { label: '2 hops', value: 2 },
  { label: 'All', value: Infinity },
]

export default function ERDView({ notify, envs, env, onEnvChange }: Props) {
  const [data, setData] = useState<ERDData | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [hops, setHops] = useState(Infinity)
  // "Full spec" has no equivalent on Lineage or Fabric Monitoring, so it stays a
  // local override layered on top of the shared environment rather than a value
  // those tabs could ever be asked to show.
  const [fullSpec, setFullSpec] = useState(false)

  // A change that came from Lineage or Fabric Monitoring should be reflected
  // here too, the same way it would be if this tab had made it -- so a full-spec
  // view doesn't linger once someone has picked a different environment elsewhere.
  useEffect(() => {
    setFullSpec(false)
  }, [env])

  const scope = fullSpec ? FULL_SPEC : env

  // The spec itself is one shared set of HDX tables; `scope` decides which
  // environment's warehouse it gets intersected with.
  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.erd(scope))
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e)
      notify('error', `Failed to load ERD: ${msg}`)
    } finally {
      setLoading(false)
    }
  }, [notify, scope])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // A table focused in one scope may not exist in the next one, which would
  // otherwise leave the diagram narrowed to a table that is no longer there.
  useEffect(() => {
    if (!data || !selected) return
    if (!data.tables.some(table => table.table_name === selected)) setSelected(null)
  }, [data, selected])

  // Clicking a table narrows the diagram to what it actually joins to. The
  // whole Silver layer at once is a wall of 136 boxes; one table's neighbourhood
  // is a diagram you can read.
  const scoped = useMemo(() => {
    if (!data) return null
    if (!selected) return data
    return narrowERD(data, scopeFrom(data, selected, hops))
  }, [data, selected, hops])

  const layout = useMemo(() => (scoped ? layoutERD(scoped) : null), [scoped])

  const { dimmed, highlighted } = useMemo(
    () =>
      layout ? filteredERD(layout, search) : { dimmed: new Set<string>(), highlighted: new Set<string>() },
    [layout, search],
  )

  const selectedTable: ERDTable | null = useMemo(
    () => (selected ? data?.tables.find(table => table.table_name === selected) ?? null : null),
    [data, selected],
  )

  const scopeLabel =
    scope === FULL_SPEC ? 'the spec' : envs.find(e => e.key === scope)?.label ?? scope.toUpperCase()

  return (
    <div className="erd-view">
      <div className="erd-toolbar">
        <span className="erd-scope-label">Tables in</span>
        <span className="segmented">
          {envs
            .filter(option => option.configured)
            .map(option => (
              <button
                key={option.key}
                className={scope === option.key ? 'is-active' : undefined}
                disabled={loading}
                title={`Only the tables that actually exist in ${option.label}`}
                onClick={() => {
                  if (fullSpec) setFullSpec(false)
                  if (option.key !== env) onEnvChange(option.key)
                }}
              >
                {option.label}
              </button>
            ))}
          <button
            className={scope === FULL_SPEC ? 'is-active' : undefined}
            disabled={loading}
            title="Every table mapped in the HDX spec, whether it has been built yet or not"
            onClick={() => !fullSpec && setFullSpec(true)}
          >
            Full spec
          </button>
        </span>

        <div className="erd-search">
          <input
            type="text"
            placeholder="Search tables and columns..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            disabled={loading}
          />
          {search && (
            <button className="erd-search-clear" onClick={() => setSearch('')} title="Clear search">
              ✕
            </button>
          )}
        </div>

        <button onClick={() => void loadData()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>

        {layout && (
          <span className="erd-counts">
            {layout.nodes.length} tables · {layout.edges.length} relationships
            {!selected && layout.unlinked > 0 && ` · ${layout.unlinked} unrelated`}
            {!selected && data && data.hidden > 0 && (
              <span
                className="erd-hidden"
                title={`Mapped in HDX.Table_Metadata but not built in ${scopeLabel} yet, so they are left out of the diagram.`}
              >
                {' · '}
                {data.hidden} mapped, not in {scopeLabel}
              </span>
            )}
          </span>
        )}

        {selected ? (
          <>
            <span className="erd-focus">
              Showing what <code>{selected}</code> joins to
            </span>
            <span className="segmented">
              {HOPS.map(option => (
                <button
                  key={option.label}
                  className={hops === option.value ? 'is-active' : ''}
                  onClick={() => setHops(option.value)}
                  title={
                    option.value === Infinity
                      ? 'Every table reachable through any chain of keys'
                      : `Tables within ${option.value} relationship${option.value > 1 ? 's' : ''}`
                  }
                >
                  {option.label}
                </button>
              ))}
            </span>
            <button onClick={() => setSelected(null)}>Show all tables</button>
          </>
        ) : (
          <span className="erd-hint">Click a table to narrow the diagram to its relationships.</span>
        )}
      </div>

      <div className="erd-legend">
        <span className="erd-legend-item">
          <span className="erd-legend-key">PK</span> primary key
        </span>
        <span className="erd-legend-item">
          <span className="erd-legend-key">FK1</span> foreign key
        </span>
        <span className="erd-legend-item">
          <svg width="46" height="12" aria-hidden="true">
            <path d="M 4 6 H 42" className="erd-legend-line" />
            <path d="M 15 6 L 4 2 M 15 6 L 4 10" className="erd-legend-line" />
            <path d="M 38 1 V 11" className="erd-legend-line" />
          </svg>
          many to one
        </span>
        <span className="erd-legend-item">
          <svg width="30" height="12" aria-hidden="true">
            <path d="M 2 6 H 28" className="erd-legend-line is-dashed" />
          </svg>
          FK outside the primary key
        </span>
        <span className="erd-legend-item">
          <svg width="30" height="12" aria-hidden="true">
            <path d="M 2 6 H 28" className="erd-legend-line" />
            <circle cx="12" cy="6" r="3.2" className="erd-legend-ring" />
          </svg>
          optional (nullable FK)
        </span>
        <span className="erd-legend-note">
          Relationships are inferred by matching a Foreign Key column to a Primary Key column of
          the same name, from <code>field_category</code> in <code>HDX.Table_Columns</code>.
        </span>
      </div>

      <div className="erd-content">
        {loading ? (
          <div className="erd-loading">Loading Silver layer schema…</div>
        ) : layout && layout.nodes.length > 0 ? (
          <>
            <ERDCanvas
              layout={layout}
              onTableClick={setSelected}
              selected={selected}
              highlight={highlighted}
              dim={dimmed}
              fitKey={`${selected ?? ''}:${hops}:${layout.nodes.length}:${layout.edges.length}`}
            />

            {selectedTable && (
              <div className="erd-details">
                <div className="erd-details-header">
                  <h3>{selectedTable.table_name}</h3>
                  <button
                    className="erd-details-close"
                    onClick={() => setSelected(null)}
                    title="Close details"
                  >
                    ✕
                  </button>
                </div>

                <div className="erd-details-body">
                  {selectedTable.description && (
                    <p className="erd-details-description">{selectedTable.description}</p>
                  )}

                  <div className="erd-details-columns">
                    <h4>Columns ({selectedTable.columns.length})</h4>
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Type</th>
                          <th>Null</th>
                          <th>Key</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedTable.columns.map(col => (
                          <tr key={col.column_name}>
                            <td className="erd-col-name">{col.column_name}</td>
                            <td className="erd-col-type">{col.data_type}</td>
                            <td className="erd-col-nullable">{col.nullable ? 'Yes' : 'No'}</td>
                            <td className="erd-col-role">
                              {col.is_primary_key && <span className="badge badge-pk">PK</span>}
                              {col.is_foreign_key && <span className="badge badge-fk">FK</span>}
                              {!col.is_primary_key && !col.is_foreign_key && <span>—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {selectedTable.last_modified && (
                  <p className="erd-details-modified">
                    Last modified: {new Date(selectedTable.last_modified).toLocaleDateString()}
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="erd-empty">
            {scope === FULL_SPEC
              ? 'No Silver-layer tables found in HDX.Table_Metadata / HDX.Table_Columns.'
              : `None of the Silver tables mapped in the HDX spec exist in ${scopeLabel} yet. Switch to Full spec to see what is mapped.`}
          </div>
        )}
      </div>
    </div>
  )
}
