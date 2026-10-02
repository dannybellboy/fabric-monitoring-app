import React, { useEffect, useState } from 'react'
import { ApiError, api } from '../api'
import type { S2TTarget, EnvironmentInfo } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  notify: (kind: 'success' | 'error', text: string) => void
  targets: S2TTarget[]
}

export default function S2TCheckModal({ open, onClose, notify, targets }: Props) {
  const [envs, setEnvs] = useState<EnvironmentInfo[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [selectedTargets, setSelectedTargets] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const cancelRef = React.useRef(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [results, setResults] = useState<any[]>([])
  const [report, setReport] = useState<any | null>(null)
  const [showSelections, setShowSelections] = useState(true)

  const handleClose = () => {
    // clear runtime state when closing so reopening starts fresh
    setReport(null)
    setResults([])
    setProgress({ done: 0, total: 0 })
    setRunning(false)
    setCancelRequested(false)
    cancelRef.current = false
    setShowSelections(true)
    onClose()
  }

  useEffect(() => {
    if (!open) return
    void (async () => {
      try {
        const list = await api.environments()
        setEnvs(list)
        // default to all configured envs
        setSelected(list.filter((e) => e.configured).map((e) => e.key))
        // default target selection: include all non-PostgreSQL targets
        setSelectedTargets(targets.filter((t) => t.target.toLowerCase() !== 'postgresql').map((t) => t.target))
        // ensure selections are visible when modal opens
        setShowSelections(true)
      } catch (e) {
        notify('error', e instanceof ApiError ? e.message : String(e))
      }
    })()
  }, [open, notify, targets])

  const toggle = (key: string) => {
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]))
  }

  const toggleTarget = (key: string) => {
    setSelectedTargets((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]))
  }

  const run = async () => {
    if (!window.confirm('Run DDL validation across the selected targets and environments?')) return
    if (selectedTargets.length === 0) {
      notify('error', 'No targets selected')
      return
    }
    // clear previous summary/report/results when starting a new run
    setReport(null)
    // hide selections while running
    setShowSelections(false)
    setRunning(true)
    setResults([])
    const agg: any = { generatedAt: new Date().toISOString(), summary: {}, results: {} }

    // Build list of all tables to check so we can show per-mapping progress.
    let tableList: { target: string; table: string }[] = []
    for (const t of selectedTargets) {
      try {
        const tables = await api.s2tTables(t)
        tableList.push(...tables.map((tbl) => ({ target: t, table: tbl.table_name })))
      } catch (e) {
        // record as target-level error
        setResults((r) => [...r, { target: t, error: e instanceof ApiError ? e.message : String(e) }])
      }
    }

    const total = tableList.length
    setProgress({ done: 0, total })

    // Collect results locally so we don't render a line per mapping while running.
    const localResults: any[] = []

    // Prepare per-env summary counters for the canonical and selected envs
    const envSummary: Record<string, { total_tables: number; clean_tables: number; issue_tables: number }> = {}
    for (const e of selected) envSummary[e] = { total_tables: 0, clean_tables: 0, issue_tables: 0 }

    // reset cancel state
    setCancelRequested(false)
    cancelRef.current = false

    for (let i = 0; i < tableList.length; i++) {
      if (cancelRef.current) break
      const { target: t, table } = tableList[i]
      try {
        const res = await api.s2tValidate(t, table)
        // merge per-env results, but only for user-selected envs
        for (const env of selected) {
          if (!res.table_found || !res.table_found[env]) continue
          if (!res.access || res.access[env] !== 'ok') continue
          agg.results[env] = agg.results[env] || []
          const issues: any[] = []
          for (const col of res.columns) {
            const envCell = col.environments[env]
            if (envCell && envCell.matches === false) {
              issues.push({ column_name: col.column_name, live: { data_type: envCell.data_type, not_null: envCell.not_null }, mapped_data_type: col.mapped_data_type, mapped_not_null: col.mapped_not_null })
            }
          }
          if (!envSummary[env]) envSummary[env] = { total_tables: 0, clean_tables: 0, issue_tables: 0 }
          envSummary[env].total_tables += 1
          if (issues.length) {
            agg.results[env].push({ table, target: t, issues })
            envSummary[env].issue_tables += 1
          } else {
            envSummary[env].clean_tables += 1
          }
        }
        localResults.push({ target: t, table, status: 'ok' })
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : String(e)
        localResults.push({ target: t, table, error: msg })
        for (const env of selected) {
          agg.results[env] = agg.results[env] || []
          agg.results[env].push({ table, target: t, error: msg })
          if (!envSummary[env]) envSummary[env] = { total_tables: 0, clean_tables: 0, issue_tables: 0 }
          // Count errored tables as issue_tables
          envSummary[env].total_tables += 1
          envSummary[env].issue_tables += 1
        }
      }
      setProgress({ done: i + 1, total })
    }
    // Attach the computed summary into the report
    agg.summary = envSummary
    // Now expose the collected results at once.
    setResults(localResults)
    setReport(agg)
    setRunning(false)
    if (cancelRef.current) notify('error', 'DDL validation cancelled')
    else notify('success', 'DDL validation completed')
  }

  const download = () => {
    if (!report) return
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const now = new Date().toISOString().replace(/[:.]/g, '-')

    // Determine filename per rules:
    // - If all envs and all layers selected: full-platform
    // - If single env and single layer selected: {env}-{layer}
    // - Otherwise: partial
    // Canonical full-platform sets: these are the environments and layers
    // that count as the "full" selection. Use a fixed env list so a system
    // with only one configured env doesn't accidentally become "full-platform".
    const canonicalEnvs = ['dev', 'qa', 'uat', 'prd']
    const canonicalLayers = ['Silver', 'Gold']
    const allEnvsSelected = selected.length > 0 && canonicalEnvs.every((e) => selected.includes(e))
    const allLayersSelected = selectedTargets.length > 0 && canonicalLayers.every((l) => selectedTargets.includes(l))
    let prefix = 'partial'
    if (allEnvsSelected && allLayersSelected) prefix = 'full-platform'
    else if (selected.length === 1 && selectedTargets.length === 1) prefix = `${selected[0]}-${selectedTargets[0]}`

    a.download = `${prefix}-schema-check-report_${now}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    notify('success', 'DDL report downloaded')
    // Clear and close modal after download
    handleClose()
  }

  const anySelected = selected.length > 0

  if (!open) return null

  return (
    <div className="modal">
      <div className="modal-body panel">
        <div className="panel-head">
          <h3>DDL check across targets</h3>
          <div className="panel-actions">
            <button onClick={handleClose} className="dismiss">×</button>
          </div>
        </div>

        <div className="panel-body">
          <p className="muted">Select which environments to include and run the validation. Progress updates appear below.</p>

          {!running && showSelections && (
            <div style={{ display: 'flex', gap: 16 }}>
              <div style={{ minWidth: 220 }}>
                <label style={{ fontWeight: 600 }}>Environments</label>
                <div style={{ marginTop: 8 }}>
                  {envs.map((e) => (
                    <div key={e.key}>
                      <label>
                        <input type="checkbox" checked={selected.includes(e.key)} onChange={() => toggle(e.key)} />{' '}
                        {e.label} {e.configured ? '' : '(not configured)'}
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ flex: 1 }}>
                <label style={{ fontWeight: 600 }}>Targets (medallion layers)</label>
                <div style={{ marginTop: 8, maxHeight: 220, overflow: 'auto' }}>
                  {targets.length ? (
                    targets
                      .filter((t) => t.target.toLowerCase() !== 'postgresql')
                      .map((t) => (
                        <div key={t.target} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <label style={{ cursor: 'pointer' }}>
                            <input type="checkbox" checked={selectedTargets.includes(t.target)} onChange={() => toggleTarget(t.target)} />{' '}
                            {t.target}
                          </label>
                          <div className="muted">{t.mappings} mappings</div>
                        </div>
                      ))
                  ) : (
                    <div className="muted">No targets available</div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            {!running ? (
              <>
                <button className="primary" onClick={run} disabled={!anySelected || targets.length === 0}>
                  Run checks
                </button>{' '}
                <button onClick={handleClose}>Close</button>{' '}
                {!showSelections && report && (
                  <button onClick={() => setShowSelections(true)}>Edit selections</button>
                )}
              </>
            ) : (
              <>
                <button className="danger" onClick={() => { setCancelRequested(true); cancelRef.current = true }}>
                  {cancelRequested ? 'Cancelling…' : 'Cancel run'}
                </button>{' '}
                <button disabled>{`Running (${progress.done}/${progress.total})`}</button>{' '}
              </>
            )}
            <button onClick={download} disabled={!report}>Download JSON</button>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600 }}>Progress</div>
            <div style={{ marginTop: 8 }}>
              {/* Progress bar */}
              <div style={{ height: 14, background: '#f0f0f0', borderRadius: 6, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : '0%',
                    background: '#2b8aef',
                    transition: 'width 200ms linear',
                  }}
                />
              </div>
              <div style={{ marginTop: 6, fontSize: 12 }}>
                {running ? (
                  <span>{progress.done}/{progress.total} mappings checked</span>
                ) : progress.done === 0 ? (
                  <span className="muted">No runs yet</span>
                ) : (
                  <span>{progress.done}/{progress.total} mappings checked</span>
                )}
              </div>

              <div style={{ marginTop: 8 }}>
                {report && report.summary ? (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>Summary</div>
                    <table className="grid" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th>Environment</th>
                          <th style={{ textAlign: 'right' }}>Total</th>
                          <th style={{ textAlign: 'right' }}>Clean</th>
                          <th style={{ textAlign: 'right' }}>Issues</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(report.summary).map(([env, s]: any) => (
                          <tr key={env}>
                            <td>{env}</td>
                            <td style={{ textAlign: 'right' }}>{s.total_tables ?? 0}</td>
                            <td style={{ textAlign: 'right' }}>{s.clean_tables ?? 0}</td>
                            <td style={{ textAlign: 'right' }}>{s.issue_tables ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : results.length ? (
                  <div className="muted">No summary available</div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
