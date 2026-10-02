import type { ERDData, ERDRelationship, ERDTable } from './types'

/**
 * The part of an ERD response the layout reads. Narrower than ERDData so that
 * slicing a graph does not have to carry scope metadata that means nothing here.
 */
export type ERDGraphData = Pick<ERDData, 'tables' | 'relationships'>

// --------------------------------------------------------------------------
// Box geometry
//
// Exported so the renderer draws exactly what the layout measured -- the two
// drifting apart is what produced the first version's overlapping boxes.
// --------------------------------------------------------------------------

/** The table-name band at the top of a box. */
export const HEADER_H = 26
/** Baseline of the table name, from the top of the box. */
export const TITLE_BASELINE = 17
/** One column row. */
export const ROW_H = 17
/** The "+N more columns" line at the bottom. */
export const FOOTER_H = 16
/** The left gutter, holding the PK / FK1 labels. */
export const GUTTER_W = 36
/** Horizontal padding inside a box. */
export const PAD_X = 9
export const RADIUS = 4

const BODY_PAD = 4
/** Space taken by the rule between the PK block and the FK block. */
const SPLIT_GAP = 5
/** One character of the 10.5px monospace row font. */
const CHAR_W = 6.15
/** The title face is wider than the monospace row face. */
const TITLE_SCALE = 1.08
const MIN_W = 134
/** Wide enough for a schema-qualified name of ~42 characters before it clips. */
const MAX_W = 300

const LAYER_GAP = 104
const NODE_GAP = 26
const CLUSTER_GAP = 64
const PAD = 28
/** How far a relationship line runs straight out of a box before it turns. */
const STUB = 16

/** A key column, drawn as one row inside a table box. */
export interface ERDRow {
  column_name: string
  data_type: string
  isPrimary: boolean
  isForeign: boolean
  nullable: boolean
  /** Gutter text: `PK`, `PK,FK1`, `FK2`. */
  label: string
  /** `column_name`, shortened to what the measured box width can hold. */
  text: string
  /** Centre of the row, relative to the box's top-left corner. */
  cy: number
}

/** A table box, measured and positioned. */
export interface ERDNode extends ERDTable {
  /** Every PK column, then every FK column. Non-key columns are summarised. */
  rows: ERDRow[]
  /** Schema-qualified name, shortened to what the measured box width can hold. */
  title: string
  /** Footer text; empty when every column is already drawn as a row. */
  footer: string
  /** y of the rule between the PK block and the FK block, if both exist. */
  splitY: number | null
  x: number
  y: number
  w: number
  h: number
  rank: number
}

/** One end of a relationship line. */
export interface ERDPort {
  x: number
  y: number
  /** Which way the line leaves the box: 1 = right, -1 = left. */
  dir: 1 | -1
}

export interface ERDEdge extends ERDRelationship {
  path: string
  /** The foreign-key end, drawn with a crow's foot. */
  many: ERDPort
  /** The primary-key end, drawn with a single bar. */
  one: ERDPort
  /** The FK is part of the child's own PK, so the line is solid, not dashed. */
  identifying: boolean
  /** The FK is nullable, so the relationship is optional (drawn with a ring). */
  optional: boolean
}

export interface ERDLayout {
  nodes: ERDNode[]
  byName: Map<string, ERDNode>
  edges: ERDEdge[]
  width: number
  height: number
  /** Tables with no matched key relationship; they sit in a grid at the end. */
  unlinked: number
}

function textWidth(text: string): number {
  return text.length * CHAR_W
}

/** Shorten `text` to what `width` can hold, since a box stops growing at MAX_W. */
function clip(text: string, width: number): string {
  const max = Math.max(3, Math.floor(width / CHAR_W))
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Measure one table box.
 *
 * Only key columns get a row. Silver tables run to 67 columns, and a diagram
 * that drew all of them would be unreadable at any zoom that still showed the
 * relationships -- which are the reason to draw an ERD at all. The full column
 * list is one click away in the details panel.
 */
function measure(table: ERDTable): ERDNode {
  // FK numbering runs in column order across the whole table, so a column that
  // is both PK and FK keeps the same number it would have had in the FK block.
  const fkNumber = new Map<string, string>()
  for (const column of table.columns) {
    if (column.is_foreign_key) fkNumber.set(column.column_name, `FK${fkNumber.size + 1}`)
  }

  const primary = table.columns.filter(c => c.is_primary_key)
  const foreign = table.columns.filter(c => c.is_foreign_key && !c.is_primary_key)

  const rows: ERDRow[] = []
  let cursor = HEADER_H + BODY_PAD

  const addRow = (column: ERDTable['columns'][number], label: string) => {
    rows.push({
      column_name: column.column_name,
      data_type: column.data_type,
      isPrimary: column.is_primary_key,
      isForeign: column.is_foreign_key,
      nullable: column.nullable,
      label,
      text: column.column_name,
      cy: cursor + ROW_H / 2,
    })
    cursor += ROW_H
  }

  for (const column of primary) {
    const fk = fkNumber.get(column.column_name)
    addRow(column, fk ? `PK,${fk}` : 'PK')
  }

  let splitY: number | null = null
  if (primary.length && foreign.length) {
    splitY = cursor + SPLIT_GAP / 2
    cursor += SPLIT_GAP
  }

  for (const column of foreign) {
    addRow(column, fkNumber.get(column.column_name) ?? 'FK')
  }

  const hidden = table.columns.length - rows.length
  // A table with no keys at all would otherwise be a bare header, giving no
  // sense of its size.
  const footer = rows.length === 0
    ? `${table.columns.length} columns`
    : hidden > 0 ? `+${hidden} more` : ''
  if (footer) cursor += FOOTER_H

  const w = Math.min(
    MAX_W,
    Math.max(
      MIN_W,
      textWidth(table.table_name) * TITLE_SCALE + PAD_X * 2,
      textWidth(footer) + PAD_X * 2,
      ...rows.map(row => GUTTER_W + textWidth(row.column_name) + PAD_X * 2),
    ),
  )

  for (const row of rows) row.text = clip(row.column_name, w - GUTTER_W - PAD_X * 2)

  return {
    ...table,
    rows,
    title: clip(table.table_name, (w - PAD_X * 2) / TITLE_SCALE),
    footer,
    splitY,
    x: 0,
    y: 0,
    w,
    h: cursor + BODY_PAD,
    rank: 0,
  }
}

/** Undirected connected components, largest first. */
function components(names: string[], adjacent: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>()
  const groups: string[][] = []

  for (const start of names) {
    if (seen.has(start)) continue
    const group: string[] = []
    const stack = [start]

    while (stack.length) {
      const name = stack.pop()!
      if (seen.has(name)) continue
      seen.add(name)
      group.push(name)
      for (const next of adjacent.get(name) ?? []) {
        if (!seen.has(next)) stack.push(next)
      }
    }

    groups.push(group)
  }

  return groups.sort((a, b) => b.length - a.length)
}

/**
 * Split one component into columns: referenced tables on the left, the tables
 * that point at them to the right.
 */
function layerComponent(members: string[], childrenOf: Map<string, Set<string>>): string[][] {
  const inside = new Set(members)
  const rank = new Map(members.map(name => [name, 0]))

  // Longest path, relaxed until it settles. The pass cap is what stops a
  // circular set of foreign keys -- which name matching can produce, since
  // nothing in the spec forbids A.b_id and B.a_id both existing -- from looping
  // forever; it keeps the ranks found so far.
  for (let pass = 0; pass < members.length; pass++) {
    let moved = false
    for (const parent of members) {
      for (const child of childrenOf.get(parent) ?? []) {
        if (!inside.has(child)) continue
        if (rank.get(child)! < rank.get(parent)! + 1) {
          rank.set(child, rank.get(parent)! + 1)
          moved = true
        }
      }
    }
    if (!moved) break
  }

  const byRank = new Map<number, string[]>()
  for (const name of members) {
    const at = rank.get(name)!
    if (!byRank.has(at)) byRank.set(at, [])
    byRank.get(at)!.push(name)
  }

  return [...byRank.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, layer]) => layer.sort((a, b) => a.localeCompare(b)))
}

/** Position one component's layers, left to right. */
function placeLayers(
  layers: string[][],
  nodes: Map<string, ERDNode>,
  adjacent: Map<string, Set<string>>,
): void {
  // Order within each layer by the barycentre of its neighbours, so related
  // boxes end up level with each other and fewer lines cross.
  for (let pass = 0; pass < 6; pass++) {
    const index = new Map<string, number>()
    for (const layer of layers) layer.forEach((name, i) => index.set(name, i))

    for (const layer of layers) {
      const key = new Map<string, number>()
      layer.forEach((name, i) => {
        const near = [...(adjacent.get(name) ?? [])].filter(other => index.has(other))
        key.set(
          name,
          near.length
            ? near.reduce((sum, other) => sum + index.get(other)!, 0) / near.length
            : i,
        )
      })
      layer.sort((a, b) => key.get(a)! - key.get(b)! || a.localeCompare(b))
    }
  }

  // A hub table that 50 others point at would otherwise put all 50 in one
  // column, giving a diagram ten times taller than it is wide -- unreadable at
  // any zoom that fits the pane. Oversized layers wrap into side-by-side
  // stacks instead, aimed at a canvas roughly the shape of the pane.
  const area = layers
    .flat()
    .reduce((sum, name) => {
      const node = nodes.get(name)!
      return sum + (node.w + LAYER_GAP) * (node.h + NODE_GAP)
    }, 0)
  const budget = Math.max(1200, Math.sqrt(area / 2.2))

  const columns: string[][] = []
  const layerOfColumn: number[] = []

  layers.forEach((layer, index) => {
    let stack: string[] = []
    let height = 0
    for (const name of layer) {
      const step = nodes.get(name)!.h + NODE_GAP
      if (stack.length && height + step > budget) {
        columns.push(stack)
        layerOfColumn.push(index)
        stack = []
        height = 0
      }
      stack.push(name)
      height += step
    }
    if (stack.length) {
      columns.push(stack)
      layerOfColumn.push(index)
    }
  })

  let x = 0
  columns.forEach((column, index) => {
    for (const name of column) {
      const node = nodes.get(name)!
      node.x = x
      node.rank = layerOfColumn[index]
    }
    // Stacks of one layer sit closer together than separate layers do: no line
    // ever runs between them, so the wider channel would just be dead space.
    const sameLayer = layerOfColumn[index + 1] === layerOfColumn[index]
    x +=
      Math.max(...column.map(name => nodes.get(name)!.w)) +
      (sameLayer ? NODE_GAP * 2 : LAYER_GAP)
  })

  const span = (column: string[]) =>
    column.reduce((sum, name) => sum + nodes.get(name)!.h + NODE_GAP, -NODE_GAP)

  for (const column of columns) {
    let y = 0
    for (const name of column) {
      const node = nodes.get(name)!
      node.y = y
      y += node.h + NODE_GAP
    }
  }

  const tallest = Math.max(0, ...columns.map(span))
  for (const column of columns) {
    const offset = (tallest - span(column)) / 2
    for (const name of column) nodes.get(name)!.y += offset
  }

  // Pull each box level with the boxes it connects to, then push apart anything
  // that now overlaps. Straighter lines, and no box ever lands on another.
  for (let pass = 0; pass < 4; pass++) {
    for (const layer of columns) {
      const here = new Set(layer)
      const want = new Map<string, number>()

      for (const name of layer) {
        const node = nodes.get(name)!
        const near = [...(adjacent.get(name) ?? [])]
          .filter(other => !here.has(other))
          .map(other => nodes.get(other)!)
        want.set(
          name,
          near.length
            ? near.reduce((sum, other) => sum + other.y + other.h / 2, 0) / near.length -
                node.h / 2
            : node.y,
        )
      }

      let floor = -Infinity
      for (const name of [...layer].sort((a, b) => want.get(a)! - want.get(b)!)) {
        const node = nodes.get(name)!
        node.y = Math.max(want.get(name)!, floor)
        floor = node.y + node.h + NODE_GAP
      }
      layer.sort((a, b) => nodes.get(a)!.y - nodes.get(b)!.y)
    }
  }
}

/** The y a line should attach at: the row of its own column, not the box centre. */
function portY(node: ERDNode, column: string): number {
  const row = node.rows.find(candidate => candidate.column_name === column)
  return node.y + (row ? row.cy : node.h / 2)
}

function route(child: ERDNode, parent: ERDNode, rel: ERDRelationship): ERDEdge {
  const y1 = portY(child, rel.from_column)
  const y2 = portY(parent, rel.to_column)

  // Which side of each box the line uses. When the boxes overlap horizontally
  // -- same layer, or a table referencing itself -- both ends leave to the
  // right and the line goes round, rather than doubling back through a box.
  const clearRight = parent.x - (child.x + child.w) >= STUB * 2
  const clearLeft = child.x - (parent.x + parent.w) >= STUB * 2
  const childDir: 1 | -1 = clearLeft ? -1 : 1
  const parentDir: 1 | -1 = clearRight ? -1 : 1

  const x1 = childDir === 1 ? child.x + child.w : child.x
  const x2 = parentDir === 1 ? parent.x + parent.w : parent.x
  const ax = x1 + childDir * STUB
  const bx = x2 + parentDir * STUB

  const turn =
    childDir === parentDir
      ? childDir === 1
        ? Math.max(ax, bx)
        : Math.min(ax, bx)
      : (ax + bx) / 2

  const column = child.columns.find(candidate => candidate.column_name === rel.from_column)

  return {
    ...rel,
    path: `M ${x1} ${y1} L ${turn} ${y1} L ${turn} ${y2} L ${x2} ${y2}`,
    many: { x: x1, y: y1, dir: childDir },
    one: { x: x2, y: y2, dir: parentDir },
    identifying: column?.is_primary_key ?? false,
    optional: column?.nullable ?? false,
  }
}

/**
 * Measure every table, lay the related ones out as connected clusters, and
 * route a line per relationship between the two columns it actually joins.
 */
export function layoutERD(data: ERDGraphData): ERDLayout {
  const byName = new Map<string, ERDNode>()
  for (const table of data.tables) byName.set(table.table_name, measure(table))

  // A relationship whose primary-key side sits outside the Silver layer would
  // otherwise strand a line on nothing.
  const rels = data.relationships.filter(
    rel => byName.has(rel.from_table) && byName.has(rel.to_table),
  )

  const adjacent = new Map<string, Set<string>>()
  const childrenOf = new Map<string, Set<string>>()
  for (const name of byName.keys()) {
    adjacent.set(name, new Set())
    childrenOf.set(name, new Set())
  }
  for (const rel of rels) {
    if (rel.from_table === rel.to_table) continue
    adjacent.get(rel.from_table)!.add(rel.to_table)
    adjacent.get(rel.to_table)!.add(rel.from_table)
    childrenOf.get(rel.to_table)!.add(rel.from_table)
  }

  const groups = components([...byName.keys()], adjacent)
  const linked = groups.filter(group => group.length > 1)
  const unlinked = groups.filter(group => group.length === 1).flat()

  let cursorY = PAD
  let right = 0

  for (const members of linked) {
    placeLayers(layerComponent(members, childrenOf), byName, adjacent)

    const top = Math.min(...members.map(name => byName.get(name)!.y))
    let bottom = 0
    for (const name of members) {
      const node = byName.get(name)!
      node.x += PAD
      node.y += cursorY - top
      right = Math.max(right, node.x + node.w)
      bottom = Math.max(bottom, node.y + node.h)
    }
    cursorY = bottom + CLUSTER_GAP
  }

  if (unlinked.length) {
    // A grid rather than a column: tables whose keys matched nothing usually
    // outnumber the related ones, and one per row would dwarf the diagram.
    const columnW = Math.max(...unlinked.map(name => byName.get(name)!.w)) + NODE_GAP
    const perRow = Math.max(1, Math.floor((Math.max(right, 1100) - PAD) / columnW))
    let rowTop = cursorY
    let rowH = 0

    unlinked.sort((a, b) => a.localeCompare(b)).forEach((name, index) => {
      const node = byName.get(name)!
      const column = index % perRow
      if (column === 0 && index > 0) {
        rowTop += rowH + NODE_GAP
        rowH = 0
      }
      node.x = PAD + column * columnW
      node.y = rowTop
      node.rank = 0
      rowH = Math.max(rowH, node.h)
      right = Math.max(right, node.x + node.w)
    })

    cursorY = rowTop + rowH + CLUSTER_GAP
  }

  return {
    nodes: [...byName.values()],
    byName,
    edges: rels.map(rel => route(byName.get(rel.from_table)!, byName.get(rel.to_table)!, rel)),
    width: right + PAD,
    height: Math.max(cursorY - CLUSTER_GAP + PAD, PAD * 2),
    unlinked: unlinked.length,
  }
}

/**
 * Every table reachable from `root` by following relationships, in either
 * direction, within `hops` steps. `Infinity` gives the whole set it is joined
 * to, however far the chain runs.
 */
export function scopeFrom(data: ERDGraphData, root: string, hops: number): Set<string> {
  const adjacent = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    if (!adjacent.has(from)) adjacent.set(from, new Set())
    adjacent.get(from)!.add(to)
  }
  for (const rel of data.relationships) {
    // Direction does not matter here: a table you point at is as related as one
    // that points at you.
    link(rel.from_table, rel.to_table)
    link(rel.to_table, rel.from_table)
  }

  const scope = new Set([root])
  let frontier = [root]

  for (let hop = 0; hop < hops && frontier.length; hop++) {
    const next: string[] = []
    for (const name of frontier) {
      for (const other of adjacent.get(name) ?? []) {
        if (scope.has(other)) continue
        scope.add(other)
        next.push(other)
      }
    }
    frontier = next
  }

  return scope
}

/** `data` cut down to one set of tables, for laying out a focused view. */
export function narrowERD(data: ERDGraphData, scope: Set<string>): ERDGraphData {
  return {
    tables: data.tables.filter(table => scope.has(table.table_name)),
    relationships: data.relationships.filter(
      rel => scope.has(rel.from_table) && scope.has(rel.to_table),
    ),
  }
}

/** Which tables a search term matches, and which to fade out. */
export function filteredERD(
  layout: ERDLayout,
  search: string,
): { dimmed: Set<string>; highlighted: Set<string> } {
  const term = search.trim().toLowerCase()
  if (!term) return { dimmed: new Set(), highlighted: new Set() }

  const highlighted = new Set<string>()
  for (const node of layout.nodes) {
    // Column names are searchable too: "patient_id" is a more natural way to
    // ask what joins to what than any table name is.
    if (
      node.table_name.toLowerCase().includes(term) ||
      node.columns.some(column => column.column_name.toLowerCase().includes(term))
    ) {
      highlighted.add(node.table_name)
    }
  }

  // Direct relations stay legible but unhighlighted -- the question behind a
  // search is usually "what does this table join to".
  const related = new Set<string>()
  for (const edge of layout.edges) {
    if (highlighted.has(edge.from_table)) related.add(edge.to_table)
    if (highlighted.has(edge.to_table)) related.add(edge.from_table)
  }

  const dimmed = new Set<string>()
  for (const node of layout.nodes) {
    if (!highlighted.has(node.table_name) && !related.has(node.table_name)) {
      dimmed.add(node.table_name)
    }
  }

  return { highlighted, dimmed }
}
