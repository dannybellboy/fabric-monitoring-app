import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { NODE_H, NODE_W } from '../lineage'
import type { Cluster, Layout, PositionedNode } from '../lineage'
import { SEVERITY_ICON, SEVERITY_LABEL, relativeAge, severityOf } from '../health'
import { centralSchedule } from '../schedule'
import type { Severity } from '../health'
import type { ProcessStatus } from '../types'

const MIN_ZOOM = 0.15
const MAX_ZOOM = 2.5

interface Props {
  layout: Layout
  /** The node drawn as the centre of attention, if any. */
  focus?: string | null
  /** Nodes to keep fully opaque; everything else is dimmed. Null = no dimming. */
  highlight?: Set<string> | null
  /** Label drawn above each cluster; omit to draw none. */
  clusterLabel?: (cluster: Cluster) => string | null
  /** Execution status per process; enables the health overlay when provided. */
  statusByProcess?: Map<string, ProcessStatus> | null
  onNodeClick?: (name: string) => void
  onNodeDoubleClick?: (name: string) => void
  /** Changing this refits the view -- pass something that varies with the layout. */
  fitKey?: string
  height?: number | string
}

/** How many characters of a label fit in a node box at the rendered font size. */
const LABEL_CHARS = 27

function truncate(name: string): string {
  return name.length > LABEL_CHARS ? `${name.slice(0, LABEL_CHARS - 1)}…` : name
}

function nodeClass(node: PositionedNode, focus: string | null | undefined, dim: boolean): string {
  const classes = ['gnode']
  // Kind decides the colour -- silver (proc), gold or green (pipeline) -- and is
  // never overridden by "inactive": that is drawn as a pattern layered on top
  // (see .gnode--inactive), not a new colour.
  if (node.isGold) classes.push('gnode--gold')
  else if (node.isStoredPro) classes.push('gnode--proc')
  else classes.push('gnode--pipeline')
  if (node.isProcess && !node.isActive) classes.push('gnode--inactive')
  if (node.inCycle) classes.push('gnode--cycle')
  if (node.name === focus) classes.push('gnode--focus')
  if (dim) classes.push('gnode--dim')
  return classes.join(' ')
}

export default function GraphCanvas({
  layout,
  focus = null,
  highlight = null,
  clusterLabel,
  statusByProcess = null,
  onNodeClick,
  onNodeDoubleClick,
  fitKey,
  height = '100%',
}: Props) {
  const wrapper = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const [panning, setPanning] = useState(false)

  useLayoutEffect(() => {
    const element = wrapper.current
    if (!element) return
    const measure = () =>
      setSize({ w: element.clientWidth, h: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fit = useCallback(() => {
    if (!size.w || !size.h || !layout.width || !layout.height) return
    // Never zoom past 1: blowing a small graph up to fill the pane makes the
    // boxes huge and reads worse than leaving it at natural size, centred.
    const k = Math.min(size.w / layout.width, size.h / layout.height, 1)
    setView({
      k,
      x: (size.w - layout.width * k) / 2,
      y: (size.h - layout.height * k) / 2,
    })
  }, [size.w, size.h, layout.width, layout.height])

  // Refit when the layout changes shape or the pane resizes, but not on every
  // hover -- otherwise the view would jump while the pointer moves.
  useEffect(() => {
    fit()
  }, [fit, fitKey])

  const zoomBy = (factor: number, cx?: number, cy?: number) => {
    setView((current) => {
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
    const element = wrapper.current
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
    setView((current) => ({
      ...current,
      x: start.vx + (event.clientX - start.x),
      y: start.vy + (event.clientY - start.y),
    }))
  }

  const endDrag = () => {
    drag.current = null
    setPanning(false)
  }

  const dimmed = (name: string) => !!highlight && !highlight.has(name)

  return (
    <div className="graph-wrap" style={{ height }}>
      <div className="graph-controls">
        <button onClick={() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(1 / 1.25)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button onClick={fit} title="Fit to view">
          Fit
        </button>
        <span className="graph-zoom">{Math.round(view.k * 100)}%</span>
      </div>

      <div
        ref={wrapper}
        className={`graph-pane${panning ? ' is-panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <svg width="100%" height="100%" role="img" aria-label="Process lineage diagram">
          <defs>
            <marker
              id="dg-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 7 4 L 0 7 z" className="garrow" />
            </marker>
          </defs>

          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {clusterLabel &&
              layout.clusters.map((cluster) => {
                const label = clusterLabel(cluster)
                if (!label) return null
                return (
                  <text
                    key={`cluster-${cluster.index}`}
                    className="gcluster"
                    x={8}
                    y={cluster.y - 10}
                  >
                    {label}
                  </text>
                )
              })}

            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}->${edge.to}`}
                d={edge.path}
                className={
                  'gedge' +
                  (edge.muted ? ' gedge--muted' : '') +
                  (dimmed(edge.from) || dimmed(edge.to) ? ' gedge--dim' : '')
                }
                markerEnd="url(#dg-arrow)"
              />
            ))}

            {layout.nodes.map((node) => (
              <g
                key={node.name}
                transform={`translate(${node.x} ${node.y})`}
                className={nodeClass(node, focus, dimmed(node.name))}
                onClick={(event) => {
                  event.stopPropagation()
                  onNodeClick?.(node.name)
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation()
                  onNodeDoubleClick?.(node.name)
                }}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onNodeClick?.(node.name)
                  }
                }}
                role="button"
                aria-label={node.label}
              >
                <title>
                  {node.label}
                  {/* The procedure behind a relabelled node. Kept in the tooltip
                      because it is still what the orchestrator runs and what a
                      Fabric search needs. */}
                  {node.label !== node.name ? `\nprocedure: ${node.name}` : ''}
                  {`\nupstream: ${node.upstream.length}   downstream: ${node.downstream.length}`}
                  {node.warehouse ? `\nwarehouse: ${node.warehouse}` : ''}
                  {/* Central, not the stored UTC cron -- the popup says it that way
                      too, and the diagram must not contradict it. */}
                  {centralSchedule(node.runTimes)
                    ? `\nruns at: ${centralSchedule(node.runTimes)}`
                    : ''}
                  {node.isActive ? '' : '\ndeactivated'}
                  {node.mixedActive ? '\nsome rows active, some not' : ''}
                </title>
                <rect width={NODE_W} height={NODE_H} rx={5} className="gnode-box" />
                <rect width={4} height={NODE_H} rx={2} className="gnode-accent" />
                <text x={14} y={NODE_H / 2 + 4} className="gnode-label">
                  {truncate(node.label)}
                </text>

                {/* Health overlay. Only drawn for states that need attention, so
                    a clean graph stays clean. The glyph is what carries the
                    meaning -- a coloured dot alone would be colour-only. */}
                {(() => {
                  if (!statusByProcess) return null
                  const status = statusByProcess.get(node.name)
                  if (!status) return null
                  const severity = severityOf(status)
                  // 'orphaned' cannot actually occur here -- every node.name comes
                  // from the loaded dependency graph, so a matched status row is
                  // structurally guaranteed to have inGraph=true -- but excluding
                  // it costs nothing and keeps this in step with severityOf().
                  if (severity === 'good' || severity === 'inactive' || severity === 'orphaned') {
                    return null
                  }
                  return (
                    <g
                      className={`gstatus gstatus--${severity}`}
                      transform={`translate(${NODE_W - 17} ${NODE_H / 2})`}
                    >
                      <title>
                        {`${SEVERITY_LABEL[severity]} — last success ${relativeAge(
                          status.daysSinceSuccess,
                          status.hoursSinceRun,
                        )}`}
                      </title>
                      <circle r={7} className="gstatus-dot" />
                      <text y={3.5} textAnchor="middle" className="gstatus-glyph">
                        {SEVERITY_ICON[severity as Severity]}
                      </text>
                    </g>
                  )
                })()}
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  )
}
