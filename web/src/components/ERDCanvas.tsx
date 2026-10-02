import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { GUTTER_W, HEADER_H, PAD_X, RADIUS, TITLE_BASELINE } from '../erd'
import type { ERDLayout, ERDNode, ERDPort } from '../erd'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 2.5

interface Props {
  layout: ERDLayout
  onTableClick: (tableName: string) => void
  /** The table the details panel is open on, drawn as selected. */
  selected?: string | null
  highlight?: Set<string>
  dim?: Set<string>
  /** Changing this refits the view -- pass something that varies with the data. */
  fitKey?: string
}

/** A rectangle with only its top two corners rounded, for the header band. */
function headerPath(w: number, h: number, r: number): string {
  return `M 0 ${h} V ${r} A ${r} ${r} 0 0 1 ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h} Z`
}

/** The "many" end: three lines converging away from the box. */
function crowFoot(port: ERDPort): string {
  const apex = port.x + port.dir * 11
  return (
    `M ${apex} ${port.y} L ${port.x} ${port.y - 5} ` +
    `M ${apex} ${port.y} L ${port.x} ${port.y + 5}`
  )
}

/** The "one" end: a single bar across the line. */
function oneBar(port: ERDPort): string {
  const at = port.x + port.dir * 9
  return `M ${at} ${port.y - 5} L ${at} ${port.y + 5}`
}

function tableTooltip(node: ERDNode): string {
  const pk = node.rows.filter(row => row.isPrimary).length
  const fk = node.rows.filter(row => row.isForeign).length
  return [
    node.table_name,
    `${node.columns.length} columns — ${pk} primary key, ${fk} foreign key`,
    node.description ?? '',
  ]
    .filter(Boolean)
    .join('\n')
}

export default function ERDCanvas({
  layout,
  onTableClick,
  selected = null,
  highlight,
  dim,
  fitKey,
}: Props) {
  const pane = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const [panning, setPanning] = useState(false)

  useLayoutEffect(() => {
    const element = pane.current
    if (!element) return
    const measure = () => setSize({ w: element.clientWidth, h: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (!size.w || !size.h || !layout.width || !layout.height) return
    // Never past 1: blowing a three-table diagram up to fill the pane makes the
    // boxes huge and reads worse than leaving it at natural size, centred.
    const k = Math.min(size.w / layout.width, size.h / layout.height, 1)
    setView({
      k,
      x: (size.w - layout.width * k) / 2,
      y: (size.h - layout.height * k) / 2,
    })
  }, [size.w, size.h, layout.width, layout.height])

  useEffect(() => {
    fit()
  }, [fit, fitKey])

  const zoomBy = (factor: number, cx?: number, cy?: number) => {
    setView(current => {
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * factor))
      if (k === current.k) return current
      // Keep the point under the cursor (or the pane centre) stationary.
      const px = cx ?? size.w / 2
      const py = cy ?? size.h / 2
      const ratio = k / current.k
      return { k, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
    })
  }

  // Wheel must be a non-passive native listener: React's onWheel is registered
  // passively, so preventDefault() there is ignored and the page scrolls instead.
  useEffect(() => {
    const element = pane.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      zoomBy(
        event.deltaY < 0 ? 1.12 : 1 / 1.12,
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
    // zoomBy closes over `size`, which is captured fresh on each run.
  }, [size.w, size.h])

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }
    setPanning(true)
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const start = drag.current
    if (!start) return
    setView(current => ({
      ...current,
      x: start.vx + (event.clientX - start.x),
      y: start.vy + (event.clientY - start.y),
    }))
  }

  const endDrag = () => {
    drag.current = null
    setPanning(false)
  }

  const nodeClass = (node: ERDNode): string => {
    const classes = ['ernode']
    if (dim?.has(node.table_name)) classes.push('ernode--dim')
    if (highlight?.has(node.table_name)) classes.push('ernode--hit')
    if (node.table_name === selected) classes.push('ernode--selected')
    if (node.rows.length === 0) classes.push('ernode--keyless')
    return classes.join(' ')
  }

  return (
    <div className="erd-wrap">
      <div className="erd-controls">
        <button onClick={() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.25)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button onClick={fit} title="Fit to view">
          Fit
        </button>
        <span className="erd-zoom">{Math.round(view.k * 100)}%</span>
      </div>

      <div
        ref={pane}
        className={`erd-pane${panning ? ' is-panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <svg width="100%" height="100%" role="img" aria-label="Silver layer entity-relationship diagram">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {layout.edges.map(edge => {
              const faded = dim?.has(edge.from_table) || dim?.has(edge.to_table)
              const lit = highlight?.has(edge.from_table) || highlight?.has(edge.to_table)
              const className =
                'eredge' +
                (edge.identifying ? '' : ' eredge--optional-parent') +
                (faded ? ' eredge--dim' : '') +
                (lit ? ' eredge--hit' : '')

              return (
                <g
                  key={`${edge.from_table}.${edge.from_column}->${edge.to_table}.${edge.to_column}`}
                  className={className}
                >
                  <title>{`${edge.from_table}.${edge.from_column} → ${edge.to_table}.${edge.to_column}`}</title>
                  <path className="eredge-line" d={edge.path} />
                  <path className="eredge-mark" d={crowFoot(edge.many)} />
                  <path className="eredge-mark" d={oneBar(edge.one)} />
                  {edge.optional && (
                    <circle
                      className="eredge-ring"
                      cx={edge.many.x + edge.many.dir * 17}
                      cy={edge.many.y}
                      r={3.2}
                    />
                  )}
                </g>
              )
            })}

            {layout.nodes.map(node => (
              <g
                key={node.table_name}
                className={nodeClass(node)}
                transform={`translate(${node.x} ${node.y})`}
                onClick={event => {
                  event.stopPropagation()
                  onTableClick(node.table_name)
                }}
                tabIndex={0}
                role="button"
                aria-label={node.table_name}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onTableClick(node.table_name)
                  }
                }}
              >
                {/* One expression, not several: a <title> with more than one
                    child renders the markup as visible tooltip text. */}
                <title>{tableTooltip(node)}</title>

                <rect className="ernode-box" width={node.w} height={node.h} rx={RADIUS} />
                <path className="ernode-head" d={headerPath(node.w, HEADER_H, RADIUS)} />
                <text className="ernode-title" x={node.w / 2} y={TITLE_BASELINE}>
                  {node.title}
                </text>

                {node.rows.length > 0 && (
                  <line className="ernode-gutter" x1={GUTTER_W} y1={HEADER_H} x2={GUTTER_W} y2={node.h} />
                )}

                {node.rows.map(row => (
                  <g key={row.column_name}>
                    <text className="ernode-key" x={GUTTER_W - 5} y={row.cy + 3.5}>
                      {row.label}
                    </text>
                    <text
                      className={`ernode-col${row.isPrimary ? ' is-pk' : ''}`}
                      x={GUTTER_W + 6}
                      y={row.cy + 3.5}
                    >
                      {row.text}
                    </text>
                  </g>
                ))}

                {node.splitY !== null && (
                  <line className="ernode-split" x1={0} y1={node.splitY} x2={node.w} y2={node.splitY} />
                )}

                {node.footer && (
                  <text className="ernode-more" x={PAD_X} y={node.h - 5}>
                    {node.footer}
                  </text>
                )}
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}
