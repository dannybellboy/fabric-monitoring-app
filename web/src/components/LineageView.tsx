import { useMemo, useState } from 'react'

import EnvBar from './EnvBar'
import GraphCanvas from './GraphCanvas'
import LineageFocus from './LineageFocus'
import { buildGraph, layoutGraph } from '../lineage'
import type { Cluster, ProcMapping } from '../lineage'
import { SEVERITY_LABEL, severityOf } from '../health'
import type { EnvironmentInfo, GraphRow, ProcessStatus } from '../types'

interface Props {
  envs: EnvironmentInfo[]
  env: string
  onEnvChange: (env: string) => void
  /** This environment's own dependency-graph edges, shared with the Health tab. */
  rows: GraphRow[]
  /** Execution status per process, for the health overlay -- also shared with Health. */
  statusByProcess: Map<string, ProcessStatus>
  /** Procedure -> table it builds, for the node labels. Also shared with Health,
   *  which opens the same lineage popup. */
  procs: Map<string, ProcMapping>
  loading: boolean
  onRefresh: () => void
}

/**
 * Search hits the drawn label *and* the process name, so a stored proc shown as
 * `Encounter.EHR_Charges` is still findable by the procedure someone read off a
 * Fabric error or a run log.
 */
function matches(node: { name: string; label: string }, needle: string): boolean {
  return (
    node.label.toLowerCase().includes(needle) || node.name.toLowerCase().includes(needle)
  )
}

export default function LineageView({
  envs,
  env,
  onEnvChange,
  rows,
  statusByProcess,
  procs,
  loading,
  onRefresh,
}: Props) {
  const [search, setSearch] = useState('')
  const [hideInactive, setHideInactive] = useState(false)
  const [hideStandalone, setHideStandalone] = useState(false)

  /** The process whose lineage popup is open. */
  const [focus, setFocus] = useState<string | null>(null)
  /** Processes visited before the current one, for the Back button. */
  const [trail, setTrail] = useState<string[]>([])

  const graph = useMemo(() => buildGraph(rows, procs), [rows, procs])

  const current = envs.find((e) => e.key === env)

  /** Nodes currently drawn with a health badge, for the legend count. */
  const unhealthy = useMemo(() => {
    let count = 0
    for (const name of graph.nodes.keys()) {
      const status = statusByProcess.get(name)
      if (!status) continue
      const severity = severityOf(status)
      if (severity === 'critical' || severity === 'warning') count += 1
    }
    return count
  }, [graph, statusByProcess])

  const layout = useMemo(
    () => layoutGraph(graph, { hideInactive, hideStandalone }),
    [graph, hideInactive, hideStandalone],
  )

  const stats = useMemo(() => {
    const nodes = [...graph.nodes.values()]
    return {
      processes: nodes.filter((n) => n.isProcess).length,
      inactive: nodes.filter((n) => n.isProcess && !n.isActive).length,
      edges: [...graph.succ.values()].reduce((total, set) => total + set.size, 0),
      clusters: layout.clusters.length,
      shown: layout.nodes.length,
    }
  }, [graph, layout])

  /**
   * Search dims everything that is not a match or adjacent to one. Including
   * neighbours means a hit still shows what it connects to, which is the point of
   * looking it up on a diagram rather than in the table.
   */
  const highlight = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return null
    const matched = layout.nodes.filter((n) => matches(n, needle)).map((n) => n.name)
    const keep = new Set<string>(matched)
    for (const name of matched) {
      for (const up of graph.pred.get(name) ?? []) keep.add(up)
      for (const down of graph.succ.get(name) ?? []) keep.add(down)
    }
    return keep
  }, [search, layout.nodes, graph])

  const matchCount = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return null
    return layout.nodes.filter((n) => matches(n, needle)).length
  }, [search, layout.nodes])

  const clusterLabel = (cluster: Cluster): string | null => {
    const standalone = cluster.members.every((name) => {
      const node = graph.nodes.get(name)
      return node && node.upstream.length === 0 && node.downstream.length === 0
    })
    if (standalone && cluster.members.length > 1) {
      return `${cluster.members.length} standalone processes — no dependencies either way`
    }
    if (cluster.members.length === 1) return null
    return `${cluster.members.length} processes`
  }

  const openFocus = (name: string) => {
    setFocus(name)
    setTrail([])
  }

  const navigateTo = (name: string) => {
    setTrail((current) => (focus ? [...current, focus] : current))
    setFocus(name)
  }

  const goBack = () => {
    setTrail((current) => {
      if (!current.length) return current
      setFocus(current[current.length - 1])
      return current.slice(0, -1)
    })
  }

  return (
    <>
      <EnvBar envs={envs} env={env} onEnvChange={onEnvChange} loading={loading} />

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Highlight a table or process…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <label className="check check--inline">
          <input
            type="checkbox"
            checked={hideInactive}
            onChange={(e) => setHideInactive(e.target.checked)}
          />
          <span>Hide deactivated ({stats.inactive})</span>
        </label>

        <label className="check check--inline">
          <input
            type="checkbox"
            checked={hideStandalone}
            onChange={(e) => setHideStandalone(e.target.checked)}
          />
          <span>Hide standalone</span>
        </label>

        <button onClick={onRefresh} disabled={loading}>
          Refresh
        </button>

        <span className="count">
          {matchCount !== null
            ? `${matchCount} match${matchCount === 1 ? '' : 'es'} of ${stats.shown} shown`
            : `${stats.shown} nodes · ${stats.edges} dependencies · ${stats.clusters} groups`}
        </span>
      </div>

      <div className="legend">
        <span className="legend-item">
          <i className="swatch swatch--pipeline" /> Pipeline
        </span>
        <span className="legend-item">
          <i className="swatch swatch--proc" /> Silver
        </span>
        <span className="legend-item">
          <i className="swatch swatch--gold" /> Gold
        </span>
        {unhealthy > 0 && (
          <span className="legend-item" title="Failing or stale, from ProcessExecutionStatus">
            <i className="swatch swatch--critical" /> {SEVERITY_LABEL.critical} /{' '}
            {SEVERITY_LABEL.warning} ({unhealthy})
          </span>
        )}
        <span className="legend-hint">
          Arrows point downstream · drag to pan, scroll to zoom · click a process for its lineage
        </span>
      </div>

      {loading && !rows.length ? (
        <div className="table-scroll">
          <div className="empty">Loading {current?.label ?? env} graph…</div>
        </div>
      ) : (
        <GraphCanvas
          layout={layout}
          highlight={highlight}
          clusterLabel={clusterLabel}
          statusByProcess={statusByProcess}
          onNodeClick={openFocus}
          fitKey={`${env}-${hideInactive}-${hideStandalone}-${rows.length}`}
          height="calc(100vh - 280px)"
        />
      )}

      {focus && (
        <LineageFocus
          graph={graph}
          focus={focus}
          trail={trail}
          onFocus={navigateTo}
          onBack={goBack}
          statusByProcess={statusByProcess}
          onClose={() => {
            setFocus(null)
            setTrail([])
          }}
        />
      )}
    </>
  )
}
