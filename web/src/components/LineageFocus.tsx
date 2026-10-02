import { useEffect, useMemo } from 'react'

import GraphCanvas from './GraphCanvas'
import { layoutLineage, lineageOf, tableKey } from '../lineage'
import type { Graph } from '../lineage'
import { centralSchedule } from '../schedule'
import type { ProcessStatus } from '../types'

interface Props {
  graph: Graph
  focus: string
  /** Non-empty when the user has navigated here from another node. */
  trail: string[]
  onFocus: (name: string) => void
  onBack: () => void
  onClose: () => void
  /** Execution status per process, for the health overlay on the popup's own
   *  diagram -- the same map the calling view's full diagram already colours by. */
  statusByProcess?: Map<string, ProcessStatus> | null
}

export default function LineageFocus({
  graph,
  focus,
  trail,
  onFocus,
  onBack,
  onClose,
  statusByProcess,
}: Props) {
  const node = graph.nodes.get(focus)

  const { layout, lineage } = useMemo(
    () => ({ layout: layoutLineage(graph, focus), lineage: lineageOf(graph, focus) }),
    [graph, focus],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      // Backspace walks back through the navigation trail, like a browser.
      if (event.key === 'Backspace' && trail.length) {
        event.preventDefault()
        onBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onBack, trail.length])

  if (!node) return null

  const downstreamTotal = lineage.descendants.size
  const isolated = lineage.ancestors.size === 0 && downstreamTotal === 0

  // Stored as a UTC cron; shown in Central, which is what people mean by "8am".
  const schedule = centralSchedule(node.runTimes)

  /**
   * The header's one-line summary. "Stored proc" is deliberately absent: the box
   * colour already says which kind a node is and the label says which table, so
   * spending the first words of the line on it told nobody anything. What survives
   * is the part that is not visible on the diagram.
   */
  const facts = [
    !node.isProcess ? 'External upstream' : null,
    node.isProcess && !node.isStoredPro ? 'Pipeline' : null,
    node.isGold ? 'Gold' : null,
    node.warehouse,
    schedule && `runs at ${schedule}`,
    node.isActive ? null : 'deactivated',
  ].filter(Boolean)

  /**
   * Every source table declared for this node's table, in HDX.Table_Columns.
   *
   * Deduplicated across layers: a table mapped in both Gold and PostgreSQL
   * usually names the same sources twice, and listing them twice would only look
   * like a data problem. Column counts add up so the ordering still puts the base
   * table first.
   */
  const sources = useMemo(() => {
    const totals = new Map<string, { name: string; columns: number }>()
    for (const layer of node.mapping?.layers ?? []) {
      for (const source of layer.sources) {
        const key = tableKey(source.table_name)
        const seen = totals.get(key)
        if (seen) seen.columns += source.columns
        else totals.set(key, { name: source.table_name, columns: source.columns })
      }
    }
    return [...totals.values()].sort(
      (a, b) => b.columns - a.columns || a.name.localeCompare(b.name),
    )
  }, [node.mapping])

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog dialog--wide dialog--focus"
        role="dialog"
        aria-modal="true"
        aria-label={`Lineage of ${node.label}`}
      >
        <header>
          <div className="focus-head">
            <div>
              <h2>{node.label}</h2>
              {facts.length > 0 && <p>{facts.join(' · ')}</p>}
              {/* The diagram shows the table, so the procedure that builds it is
                  only visible here -- and it is still the name the orchestrator,
                  the run logs and Fabric all use. */}
              {node.label !== node.name && (
                <p className="focus-proc">
                  Built by <code>{node.name}</code>
                  {node.mapping && node.mapping.layers.length > 0
                    ? ` · mapped in ${node.mapping.layers.map((l) => l.layer).join(', ')}`
                    : ''}
                </p>
              )}
            </div>
            <div className="focus-actions">
              {trail.length > 0 && (
                <button onClick={onBack} title="Back to the previous process (Backspace)">
                  ← Back
                </button>
              )}
              <button onClick={onClose}>Close</button>
            </div>
          </div>

          {/* No breadcrumb of where you have been. It listed raw process names
              rather than the table labels the rest of the popup uses, and clicking
              back and forth repeated entries, so it read as a broken lineage path
              when it was only a history. Back still walks it. */}
        </header>

        <div className="body body--flush">
          {!node.isProcess && (
            <div className="notice warning" style={{ margin: '0 0 12px' }}>
              <span>
                <strong>Not a process in the table</strong>
                {downstreamTotal} process
                {downstreamTotal === 1 ? '' : 'es'} depend on <code>{focus}</code>, but it has
                no row of its own — so the orchestrator has nothing to run for it. Either add
                it as a process or correct the spelling on the rows that name it.
              </span>
            </div>
          )}

          {/* The upstream/downstream counts that used to sit here are gone: the
              diagram below is the same information, read faster. */}
          {isolated ? (
            <div className="empty" style={{ padding: '28px 16px' }}>
              <strong>{node.label}</strong> has no dependencies and nothing depends on it.
              <br />
              It runs standalone.
            </div>
          ) : (
            <>
              <p className="focus-hint">
                Left to right is execution order. Click any process to centre the view on it.
              </p>
              {/* Fills whatever height is left once the header and the source list
                  have taken theirs, so the whole dialog fits without scrolling. */}
              <div className="focus-graph">
                <GraphCanvas
                  layout={layout}
                  focus={focus}
                  statusByProcess={statusByProcess}
                  onNodeClick={(name) => name !== focus && onFocus(name)}
                  fitKey={focus}
                />
              </div>
            </>
          )}

          {/* Sources, not the upstream/downstream lists that used to sit here --
              those said exactly what the diagram above already shows. This does
              not: execution order is one thing, and which tables the SQL actually
              reads is another. */}
          <div className="focus-sources">
            <h3>Curated from ({sources.length})</h3>
            {sources.length ? (
              <div className="chips">
                {sources.map((source) => {
                  // A source that is itself built here is worth a click through.
                  const builder = graph.byTable.get(tableKey(source.name))
                  const label = `${source.columns} column${source.columns === 1 ? '' : 's'} of ${node.label} come from ${source.name}`
                  return builder && builder !== focus ? (
                    <button
                      key={source.name}
                      className="chip"
                      title={`${label} — click to open its lineage`}
                      onClick={() => onFocus(builder)}
                    >
                      {source.name}
                    </button>
                  ) : (
                    <span key={source.name} className="chip chip--static" title={label}>
                      {source.name}
                    </span>
                  )
                })}
              </div>
            ) : (
              <p className="muted">
                {node.mapping
                  ? `No source tables are recorded for ${node.mapping.tableName} in the S2T spec.`
                  : node.isStoredPro
                    ? `${focus} is not mapped in the S2T spec, so the tables it reads are unknown here.`
                    : 'Only stored procs have a source-to-target mapping.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
