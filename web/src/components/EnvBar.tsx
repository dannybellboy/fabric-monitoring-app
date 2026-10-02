import type { ReactNode } from 'react'

import type { EnvironmentInfo } from '../types'

interface Props {
  envs: EnvironmentInfo[]
  env: string
  onEnvChange: (key: string) => void
  /** Disables the whole bar while a read is in flight. */
  loading?: boolean
  /** Trailing slot, right-aligned -- the Health tab's auto-refresh checkbox. */
  children?: ReactNode
}

/**
 * The environment selector shared by Health, Lineage and Dependency Graph.
 *
 * All three ask the same question -- which environment's own tables am I looking
 * at -- so they ask it with the same control in the same place. It was copied
 * between the first two; the Dependency Graph tab would have been a third copy.
 *
 * Renders nothing for a single environment: a one-button selector is furniture.
 */
export default function EnvBar({ envs, env, onEnvChange, loading, children }: Props) {
  if (envs.length <= 1) return null

  return (
    <div className="env-bar">
      <span className="env-bar-label">Environment</span>
      <div className="segmented">
        {envs.map((option) => (
          <button
            key={option.key}
            className={option.key === env ? 'is-active' : undefined}
            disabled={!option.configured || loading}
            title={
              option.configured
                ? option.promotionColumn
                  ? `Runs only rows with ${option.promotionColumn}`
                  : 'Runs every row — no promotion filter'
                : `${option.label} is not configured yet (workspace id and SQL endpoint missing)`
            }
            onClick={() => option.key !== env && onEnvChange(option.key)}
          >
            {option.label}
            {!option.configured && <span className="env-missing"> · not set up</span>}
          </button>
        ))}
      </div>
      {children}
    </div>
  )
}
