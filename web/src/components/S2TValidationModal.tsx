import { useEffect } from 'react'

import type { S2TEnvColumn, S2TValidation } from '../types'

interface Props {
  table: string
  target: string
  validation: S2TValidation
  onClose: () => void
}

const ENV_LABELS: Record<string, string> = {
  dev: 'DEV',
  qa: 'QA',
  uat: 'UAT',
  prd: 'PRD',
}

function envLabel(key: string): string {
  return ENV_LABELS[key] ?? key.toUpperCase()
}

function nullability(notNull: boolean | null): string | null {
  if (notNull === null) return null
  return notNull ? 'NOT NULL' : 'NULL'
}

function EnvCell({ tableFound, cell }: { tableFound: boolean; cell: S2TEnvColumn | undefined }) {
  if (cell?.access === 'unavailable') {
    return <span className="ddl-cell ddl-cell--no-access">Not configured</span>
  }
  if (cell?.access === 'no_access') {
    return <span className="ddl-cell ddl-cell--no-access">No read access</span>
  }
  if (!tableFound) {
    return <span className="ddl-cell ddl-cell--unknown">table not found</span>
  }
  if (!cell || !cell.present) {
    return <span className="ddl-cell ddl-cell--mismatch">missing</span>
  }
  const label = [cell.data_type, nullability(cell.not_null)].filter(Boolean).join(' · ')
  return (
    <span className={`ddl-cell ${cell.matches ? 'ddl-cell--match' : 'ddl-cell--mismatch'}`}>
      {label || '—'}
    </span>
  )
}

export default function S2TValidationModal({ table, target, validation, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const noAccessEnvs = validation.environments.filter((env) => validation.access[env] === 'no_access')
  const unavailableEnvs = validation.environments.filter(
    (env) => validation.access[env] === 'unavailable',
  )
  const missingTables = validation.environments.filter(
    (env) => validation.access[env] === 'ok' && !validation.table_found[env],
  )

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-label={`DDL validation for ${table}`}
      >
        <header>
          <div className="focus-head">
            <div>
              <h2>{table}</h2>
              <p>
                {target} · {validation.matches ? 'Matches live DDL in every environment' : 'Differs from live DDL'}
              </p>
            </div>
            <div className="focus-actions">
              <button onClick={onClose}>Close</button>
            </div>
          </div>
        </header>

        <div className="body">
          {noAccessEnvs.length > 0 && (
            <div className="notice info">
              <span>
                <strong>No read access</strong>
                You don't have read access to {noAccessEnvs.map(envLabel).join(', ')} — those
                column(s) are greyed out below rather than compared.
              </span>
            </div>
          )}

          {unavailableEnvs.length > 0 && (
            <div className="notice info">
              <span>
                <strong>Not configured</strong>
                {unavailableEnvs.map(envLabel).join(', ')} {unavailableEnvs.length === 1 ? "isn't" : "aren't"}{' '}
                set up in dg_tool yet, so there's nothing to compare against there.
              </span>
            </div>
          )}

          {missingTables.length > 0 && (
            <div className="notice warning">
              <span>
                <strong>Table not found</strong>
                {table} does not exist yet in: {missingTables.map(envLabel).join(', ')}.
              </span>
            </div>
          )}

          <div className="table-scroll">
            <table className="gridtable">
              <thead>
                <tr>
                  <th style={{ minWidth: 180 }}>Column</th>
                  <th style={{ minWidth: 160 }}>Mapping</th>
                  {validation.environments.map((env) => (
                        <th
                          key={env}
                          style={{ minWidth: 160 }}
                          className={(() => {
                            const anyMapped = validation.columns.some(
                              (c) => c.mapped_data_type || c.mapped_not_null !== null,
                            )
                            if (!anyMapped) return validation.access[env] !== 'ok' ? 'muted' : undefined

                            if (validation.access[env] !== 'ok') return 'muted'

                            if (!validation.table_found[env]) return 'muted'

                            const compared = validation.columns.filter(
                              (c) => c.mapped_data_type || c.mapped_not_null !== null,
                            )
                            if (compared.length === 0) return undefined

                            const hasMismatch = compared.some((col) => {
                              const cell = col.environments[env]
                              return !cell || !cell.present || !cell.matches
                            })
                            return hasMismatch ? 'env--mismatch' : 'env--match'
                          })()}
                        >
                          {envLabel(env)}
                        </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {validation.columns.map((col) => {
                  const mappingLabel = [col.mapped_data_type, nullability(col.mapped_not_null)]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <tr key={col.column_name}>
                      <td className="mono">{col.column_name}</td>
                      <td>
                        {col.mapped_data_type || col.mapped_not_null !== null ? (
                          mappingLabel || '—'
                        ) : (
                          <span className="muted">not mapped</span>
                        )}
                      </td>
                      {validation.environments.map((env) => (
                        <td key={env}>
                          <EnvCell
                            tableFound={validation.table_found[env]}
                            cell={col.environments[env]}
                          />
                        </td>
                      ))}
                    </tr>
                  )
                })}
                {validation.columns.length === 0 && (
                  <tr>
                    <td colSpan={2 + validation.environments.length} className="empty">
                      No columns to compare.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
