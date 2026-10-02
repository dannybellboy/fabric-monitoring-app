/**
 * Graph model and layout for the lineage view.
 *
 * The table stores one row per dependency *edge*; the diagram shows one node per
 * *process*. So 192 rows collapse to 157 nodes and 143 unique edges.
 *
 * Edges point upstream -> downstream (Dependency -> Process), i.e. left to right
 * is execution order: a node cannot start until everything to its left is done.
 *
 * Layout is layered (Sugiyama-style, minus the crossing-minimisation heavy
 * machinery): rank by longest path, order within rank by barycentre, then place.
 * Crucially it lays out each connected component separately and stacks them,
 * because this graph is 38 disjoint components rather than one big DAG -- a single
 * global layout would put all 50 roots in one column and read as noise.
 */
import type { RowInput, S2TProcedureTable, S2TSourceRef } from './types'

/** What buildGraph needs from a row. RowId is optional so it also accepts
 *  GraphRow (an environment's read-only published edges, which have no RowId). */
type GraphEdge = RowInput & { RowId?: string }

/** One layer a table is mapped in, and the sources that layer declares. */
export interface MappedLayer {
  layer: string
  sources: S2TSourceRef[]
}

/**
 * What a stored proc builds, per the S2T spec (HDX.Table_Metadata /
 * HDX.Table_Columns).
 *
 * The dependency graph names a stored proc by its procedure name, which is not
 * what anyone calls it in conversation -- they name the table it populates. This
 * is the join that lets the diagram show the table instead.
 */
export interface ProcMapping {
  /** The table the proc populates. */
  tableName: string
  /** Layers it is mapped in; a few procs are mapped in both Gold and PostgreSQL. */
  layers: MappedLayer[]
}

export interface GraphNode {
  name: string
  /**
   * What the diagram draws for this node: the table a stored proc builds when the
   * S2T spec says which, and the process name otherwise. Never used as a key --
   * `name` is the orchestrator's identity and what every edge is keyed on.
   */
  label: string
  /** The S2T mapping `label` came from; null for anything unmapped. */
  mapping: ProcMapping | null
  /** False when the name only ever appears as a Dependency, never as a Process. */
  isProcess: boolean
  isStoredPro: boolean
  isGold: boolean
  /** True when at least one of the process's rows is active. */
  isActive: boolean
  /** True when some rows are active and others are not -- worth flagging. */
  mixedActive: boolean
  warehouse: string | null
  runTimes: string | null
  /** Rows that name this process in the Process column. */
  rowIds: string[]
  upstream: string[]
  downstream: string[]
}

export interface Graph {
  nodes: Map<string, GraphNode>
  /** upstream -> downstream */
  succ: Map<string, Set<string>>
  /** downstream -> upstream */
  pred: Map<string, Set<string>>
  /**
   * `tableKey()` -> the process that builds that table, for resolving a source
   * table back to a node. Tables built by more than one process are left out, so
   * a source either resolves to one definite node or to none.
   */
  byTable: Map<string, string>
}

/**
 * Comparison form of a table name, for matching a declared source against a table
 * the graph builds.
 *
 * The two are written inconsistently in the spec: a table is mapped as
 * `AP.3P_Invoice_Header` but cited as a source as
 * `[WH_HDX_DE_Silver].[AP].[3P_Invoice_Header]`. Dropping brackets and any
 * database prefix reduces both to `ap.3p_invoice_header`, which is what makes the
 * source chips in the lineage popup clickable.
 */
export function tableKey(name: string): string {
  const parts = name
    .replace(/[[\]]/g, '')
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.slice(-2).join('.').toLowerCase()
}

export interface PositionedNode extends GraphNode {
  x: number
  y: number
  rank: number
  /** True when ranking could not place it acyclically (should not happen today). */
  inCycle: boolean
}

export interface PositionedEdge {
  from: string
  to: string
  path: string
  /** True when either endpoint is inactive, so the edge can be drawn muted. */
  muted: boolean
}

export interface Cluster {
  /** Index in the stacked order; 0 is the largest component. */
  index: number
  size: number
  y: number
  height: number
  /** Node names, for "focus this cluster" interactions. */
  members: string[]
}

export interface Layout {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  clusters: Cluster[]
  width: number
  height: number
}

export const NODE_W = 212
export const NODE_H = 32
const COL_GAP = 76
const ROW_GAP = 14
const CLUSTER_GAP = 44
const PAD = 28

const COL_W = NODE_W + COL_GAP
const ROW_H = NODE_H + ROW_GAP

// --------------------------------------------------------------------------
// Model
// --------------------------------------------------------------------------

/**
 * Group the flat `/api/s2t/procedures` response by procedure, keyed lowercase so
 * a procedure name spelled differently in the two tables still matches -- both
 * live in the same case-insensitive warehouse, so they already compare equal
 * there and the diagram should not be stricter.
 *
 * Some rows write the procedure schema-qualified (`dbo.SP_Create_EHR_Claims_Header`)
 * while the dependency graph never does, so each mapping is also registered under
 * its unqualified tail. Only as a fallback: a couple of procedures have a dot
 * *inside* the name (`SP_Create_Item.3P`), where the tail is meaningless, so an
 * exact key always wins and a stray alias just never gets looked up.
 */
export function procMappings(rows: S2TProcedureTable[]): Map<string, ProcMapping> {
  const byProc = new Map<string, ProcMapping>()
  const aliases = new Map<string, ProcMapping>()

  for (const row of rows) {
    const name = row.procedure_name.replace(/[[\]]/g, '').trim().toLowerCase()
    if (!name || !row.table_name) continue
    let mapping = byProc.get(name)
    if (!mapping) {
      mapping = { tableName: row.table_name, layers: [] }
      byProc.set(name, mapping)
      const dot = name.indexOf('.')
      if (dot > 0) aliases.set(name.slice(dot + 1), mapping)
    }
    mapping.layers.push({ layer: row.medallion_layer, sources: row.sources })
  }

  for (const [alias, mapping] of aliases) {
    if (alias && !byProc.has(alias)) byProc.set(alias, mapping)
  }
  for (const mapping of byProc.values()) {
    mapping.layers.sort((a, b) => a.layer.localeCompare(b.layer))
  }
  return byProc
}

export function buildGraph(
  rows: GraphEdge[],
  procs?: Map<string, ProcMapping>,
): Graph {
  const nodes = new Map<string, GraphNode>()
  const succ = new Map<string, Set<string>>()
  const pred = new Map<string, Set<string>>()

  const blank = (name: string): GraphNode => ({
    name,
    label: name,
    mapping: null,
    isProcess: false,
    isStoredPro: false,
    isGold: false,
    isActive: false,
    mixedActive: false,
    warehouse: null,
    runTimes: null,
    rowIds: [],
    upstream: [],
    downstream: [],
  })

  const ensure = (name: string): GraphNode => {
    let node = nodes.get(name)
    if (!node) {
      node = blank(name)
      nodes.set(name, node)
      succ.set(name, new Set())
      pred.set(name, new Set())
    }
    return node
  }

  // First pass: every Process becomes a node carrying that process's attributes.
  // A process with three dependencies has three rows that should agree on the
  // flags; if they disagree, the active flag is tracked as "mixed" rather than
  // silently taking whichever row happened to be first.
  rows.forEach((row, index) => {
    const node = ensure(row.Process)
    const first = node.rowIds.length === 0
    node.isProcess = true
    node.rowIds.push(row.RowId ?? `${row.Process}::${row.Dependency ?? ''}::${index}`)

    if (first) {
      node.isStoredPro = row.isStoredPro
      node.isGold = row.isGold
      node.isActive = row.isActive
      node.warehouse = row.WarehouseName
      node.runTimes = row.RunTimes
    } else {
      if (node.isActive !== row.isActive) node.mixedActive = true
      node.isActive = node.isActive || row.isActive
    }
  })

  // Second pass: edges. A Dependency that is not itself a Process still gets a
  // node, flagged isProcess:false -- these are the "external upstream" warnings.
  for (const row of rows) {
    if (!row.Dependency) continue
    ensure(row.Dependency)
    succ.get(row.Dependency)!.add(row.Process)
    pred.get(row.Process)!.add(row.Dependency)
  }

  for (const [name, node] of nodes) {
    node.upstream = [...pred.get(name)!].sort()
    node.downstream = [...succ.get(name)!].sort()
  }

  // Third pass: relabel stored procs as the table they build. Only the label
  // changes -- the node stays keyed on the process name, because that is what the
  // orchestrator runs and what every edge in the table refers to.
  const claims = new Map<string, string[]>()
  if (procs?.size) {
    for (const node of nodes.values()) {
      if (!node.isProcess || !node.isStoredPro) continue
      const mapping = procs.get(node.name.toLowerCase())
      if (!mapping) continue // no S2T row for it: keep showing the proc name
      node.mapping = mapping
      node.label = mapping.tableName
      const key = tableKey(mapping.tableName)
      claims.set(key, [...(claims.get(key) ?? []), node.name])
    }

    // A table can be built by two procs -- a Silver loader and a Gold one, sharing
    // one table_name across layers. Two boxes with the identical label would be
    // unreadable, so those carry their layer; a table with one builder stays clean.
    for (const owners of claims.values()) {
      if (owners.length < 2) continue
      for (const name of owners) {
        const node = nodes.get(name)!
        const layers = node.mapping!.layers.map((l) => l.layer).filter(Boolean)
        if (layers.length) node.label = `${node.label} · ${layers.join(' + ')}`
      }
    }
  }

  const byTable = new Map<string, string>()
  for (const [key, owners] of claims) {
    if (owners.length === 1) byTable.set(key, owners[0])
  }

  return { nodes, succ, pred, byTable }
}

/** Connected components, treating edges as undirected, largest first. */
export function components(graph: Graph): string[][] {
  const seen = new Set<string>()
  const found: string[][] = []

  for (const start of [...graph.nodes.keys()].sort()) {
    if (seen.has(start)) continue
    const stack = [start]
    const group: string[] = []
    while (stack.length) {
      const name = stack.pop()!
      if (seen.has(name)) continue
      seen.add(name)
      group.push(name)
      for (const next of graph.succ.get(name) ?? []) if (!seen.has(next)) stack.push(next)
      for (const next of graph.pred.get(name) ?? []) if (!seen.has(next)) stack.push(next)
    }
    found.push(group.sort())
  }

  // Largest first, ties broken by name so the diagram is stable across reloads.
  return found.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))
}

/**
 * Longest-path ranking: rank(n) = 1 + max(rank of upstreams), roots at 0.
 *
 * Cycle-safe by construction -- Kahn's algorithm only emits nodes whose
 * upstreams are all placed, and anything left over (necessarily in a cycle) is
 * appended afterwards and reported so it can be drawn differently. There are no
 * cycles in this data today, but the diagram must not hang if one appears.
 */
function rankNodes(
  members: string[],
  pred: Map<string, Set<string>>,
  succ: Map<string, Set<string>>,
): { rank: Map<string, number>; cyclic: Set<string> } {
  const inScope = new Set(members)
  const rank = new Map<string, number>()
  const indegree = new Map<string, number>()

  for (const name of members) {
    const ups = [...(pred.get(name) ?? [])].filter((u) => inScope.has(u))
    indegree.set(name, ups.length)
    rank.set(name, 0)
  }

  const queue = members.filter((n) => indegree.get(n) === 0).sort()
  const placed = new Set<string>()

  while (queue.length) {
    const name = queue.shift()!
    placed.add(name)
    for (const down of [...(succ.get(name) ?? [])].sort()) {
      if (!inScope.has(down)) continue
      rank.set(down, Math.max(rank.get(down)!, rank.get(name)! + 1))
      const remaining = indegree.get(down)! - 1
      indegree.set(down, remaining)
      if (remaining === 0) queue.push(down)
    }
  }

  const cyclic = new Set(members.filter((n) => !placed.has(n)))
  for (const name of cyclic) {
    const ups = [...(pred.get(name) ?? [])].filter((u) => placed.has(u))
    const deepest = ups.reduce((max, u) => Math.max(max, rank.get(u) ?? 0), -1)
    rank.set(name, deepest + 1)
  }

  return { rank, cyclic }
}

/**
 * Order nodes within each rank to shorten edges, by repeatedly moving each node
 * to the average position of its neighbours in the adjacent rank (barycentre
 * heuristic). Alternating sweep direction converges quickly; four passes is
 * plenty at this size and keeps the result deterministic.
 */
function orderRanks(
  byRank: Map<number, string[]>,
  pred: Map<string, Set<string>>,
  succ: Map<string, Set<string>>,
  inScope: Set<string>,
): void {
  const ranks = [...byRank.keys()].sort((a, b) => a - b)
  const indexOf = new Map<string, number>()
  const reindex = () => {
    for (const r of ranks) byRank.get(r)!.forEach((n, i) => indexOf.set(n, i))
  }
  reindex()

  const sweep = (order: number[], neighbours: Map<string, Set<string>>) => {
    for (const r of order) {
      const layer = byRank.get(r)!
      const barycentre = new Map<string, number>()
      layer.forEach((name, fallback) => {
        const positions = [...(neighbours.get(name) ?? [])]
          .filter((n) => inScope.has(n) && indexOf.has(n))
          .map((n) => indexOf.get(n)!)
        // No neighbour in that direction: keep the current position so isolated
        // nodes do not all collapse to the top of the column.
        barycentre.set(
          name,
          positions.length
            ? positions.reduce((a, b) => a + b, 0) / positions.length
            : fallback,
        )
      })
      layer.sort(
        (a, b) => barycentre.get(a)! - barycentre.get(b)! || a.localeCompare(b),
      )
      reindex()
    }
  }

  for (let pass = 0; pass < 2; pass++) {
    sweep([...ranks].slice(1), pred) // downstream ranks follow their upstreams
    sweep([...ranks].reverse().slice(1), succ) // and vice versa
  }
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(28, (x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export interface LayoutOptions {
  /** Drop nodes whose every row is inactive. */
  hideInactive?: boolean
  /** Drop components of one node (processes with no lineage at all). */
  hideStandalone?: boolean
  /** Lay out a single component's worth of nodes, ignoring the rest. */
  only?: Set<string>
}

export function layoutGraph(graph: Graph, options: LayoutOptions = {}): Layout {
  const visible = new Set(
    [...graph.nodes.values()]
      .filter((n) => (options.only ? options.only.has(n.name) : true))
      .filter((n) => (options.hideInactive ? n.isActive : true))
      .map((n) => n.name),
  )

  const groups = components(graph)
    .map((group) => group.filter((n) => visible.has(n)))
    .filter((group) => group.length > 0)
    .filter((group) => !(options.hideStandalone && group.length === 1))

  const nodes: PositionedNode[] = []
  const clusters: Cluster[] = []
  const positioned = new Map<string, PositionedNode>()

  // Singletons are laid out as a compact grid at the end rather than as 19
  // one-node clusters, which would waste an enormous amount of vertical space.
  const linked = groups.filter((g) => g.length > 1)
  const singles = groups.filter((g) => g.length === 1).flat()

  let cursorY = PAD
  let maxRight = 0

  linked.forEach((members, index) => {
    const { rank, cyclic } = rankNodes(members, graph.pred, graph.succ)

    const byRank = new Map<number, string[]>()
    for (const name of members) {
      const r = rank.get(name)!
      if (!byRank.has(r)) byRank.set(r, [])
      byRank.get(r)!.push(name)
    }
    for (const layer of byRank.values()) layer.sort()

    orderRanks(byRank, graph.pred, graph.succ, new Set(members))

    const tallest = Math.max(...[...byRank.values()].map((l) => l.length))
    const clusterHeight = tallest * ROW_H - ROW_GAP

    for (const [r, layer] of byRank) {
      // Centre each column within the cluster so edges stay roughly horizontal.
      const offset = (clusterHeight - (layer.length * ROW_H - ROW_GAP)) / 2
      layer.forEach((name, i) => {
        const node: PositionedNode = {
          ...graph.nodes.get(name)!,
          x: PAD + r * COL_W,
          y: cursorY + offset + i * ROW_H,
          rank: r,
          inCycle: cyclic.has(name),
        }
        nodes.push(node)
        positioned.set(name, node)
        maxRight = Math.max(maxRight, node.x + NODE_W)
      })
    }

    clusters.push({
      index,
      size: members.length,
      y: cursorY,
      height: clusterHeight,
      members,
    })
    cursorY += clusterHeight + CLUSTER_GAP
  })

  if (singles.length) {
    const perRow = Math.max(1, Math.floor((maxRight - PAD + COL_GAP) / COL_W)) || 4
    const rowsUsed = Math.ceil(singles.length / perRow)
    singles.sort().forEach((name, i) => {
      const node: PositionedNode = {
        ...graph.nodes.get(name)!,
        x: PAD + (i % perRow) * COL_W,
        y: cursorY + Math.floor(i / perRow) * ROW_H,
        rank: 0,
        inCycle: false,
      }
      nodes.push(node)
      positioned.set(name, node)
      maxRight = Math.max(maxRight, node.x + NODE_W)
    })
    const height = rowsUsed * ROW_H - ROW_GAP
    clusters.push({
      index: linked.length,
      size: singles.length,
      y: cursorY,
      height,
      members: singles,
    })
    cursorY += height + CLUSTER_GAP
  }

  const edges: PositionedEdge[] = []
  for (const [from, targets] of graph.succ) {
    const source = positioned.get(from)
    if (!source) continue
    for (const to of targets) {
      const target = positioned.get(to)
      if (!target) continue
      edges.push({
        from,
        to,
        path: edgePath(
          source.x + NODE_W,
          source.y + NODE_H / 2,
          target.x,
          target.y + NODE_H / 2,
        ),
        muted: !source.isActive || !target.isActive,
      })
    }
  }

  return {
    nodes,
    edges,
    clusters,
    width: maxRight + PAD,
    height: Math.max(cursorY - CLUSTER_GAP + PAD, PAD * 2),
  }
}

// --------------------------------------------------------------------------
// Lineage of a single node
// --------------------------------------------------------------------------

export interface Lineage {
  focus: string
  /** Every transitive upstream, with the number of hops to the focus. */
  ancestors: Map<string, number>
  /** Every transitive downstream, with the number of hops from the focus. */
  descendants: Map<string, number>
}

/** Transitive upstream and downstream sets, cycle-safe via a visited set. */
export function lineageOf(graph: Graph, focus: string): Lineage {
  const walk = (direction: Map<string, Set<string>>): Map<string, number> => {
    const depth = new Map<string, number>()
    let frontier = [focus]
    let hops = 0
    while (frontier.length) {
      hops += 1
      const next: string[] = []
      for (const name of frontier) {
        for (const neighbour of direction.get(name) ?? []) {
          if (neighbour === focus) continue // a cycle back to the focus
          // Keep the shortest hop count; the set itself is what matters.
          if (!depth.has(neighbour)) {
            depth.set(neighbour, hops)
            next.push(neighbour)
          }
        }
      }
      frontier = next
    }
    return depth
  }

  return { focus, ancestors: walk(graph.pred), descendants: walk(graph.succ) }
}

/**
 * Lay out just the focus node's lineage: the induced subgraph over the focus plus
 * all its ancestors and descendants.
 *
 * Ranking the induced subgraph places the focus correctly without special-casing:
 * every ancestor has a path *to* the focus so it must rank lower, and every
 * descendant has a path *from* it so it must rank higher.
 */
export function layoutLineage(graph: Graph, focus: string): Layout & { focusRank: number } {
  const { ancestors, descendants } = lineageOf(graph, focus)
  const scope = new Set<string>([focus, ...ancestors.keys(), ...descendants.keys()])
  const layout = layoutGraph(graph, { only: scope })
  const focusNode = layout.nodes.find((n) => n.name === focus)
  return { ...layout, focusRank: focusNode?.rank ?? 0 }
}
