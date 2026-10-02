import { useEffect } from 'react'

/** One pending change, already described in the caller's terms. */
export interface CrossEnvChange {
  /** What is being done: 'Add', 'Update', 'Remove', 'Set readyForUAT', … */
  action: string
  /** The edge it applies to, e.g. 'LoadFact → LoadDim'. */
  edge: string
  /** Field-level detail, pre-formatted, e.g. 'isGold: off → on'. */
  details?: string[]
}

interface Props {
  /** The environment being written to, e.g. 'UAT'. */
  envLabel: string
  changes: CrossEnvChange[]
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation for a dependency-graph write outside DEV.
 *
 * DEV saves are not confirmed and should not be -- it is a staging table people
 * edit all day. QA and UAT are deployed environments whose orchestrator reads
 * this table on its next run, and nothing else in dg_tool has ever written to
 * them, so the change is spelled out field by field first rather than confirmed
 * with a count. Anyone who reaches this dialog is doing something that used to
 * require a hand-written UPDATE.
 */
export default function CrossEnvConfirm({
  envLabel,
  changes,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={`Confirm changes to ${envLabel}`}
      >
        <header>
          <h2>Apply {changes.length === 1 ? 'this change' : 'these changes'} to {envLabel}?</h2>
        </header>

        <div className="body">
          <div className="notice warning">
            <span>
              <strong>This writes straight to {envLabel}</strong>
              {envLabel}'s dependency graph is the table its orchestrator reads to
              decide what to run, and this change takes effect on its next run.
              DEV is not touched.
            </span>
          </div>

          <ul className="issues">
            {changes.map((change, index) => (
              <li key={index}>
                <span className="level warning">{change.action}</span>
                <span>
                  <span className="mono">{change.edge}</span>
                  {change.details && change.details.length > 0 && (
                    <ul className="muted" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {change.details.map((detail) => (
                        <li key={detail} className="mono">
                          {detail}
                        </li>
                      ))}
                    </ul>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="danger" onClick={onConfirm} autoFocus>
            Apply to {envLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
