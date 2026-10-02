import type { Issue } from '../types'

interface Props {
  issues: Issue[]
}

/**
 * Surfaced permanently rather than on demand: blocking graph problems. Cycles
 * and missing warehouses are invisible in a flat table and only show up at
 * run time as a stalled orchestration.
 *
 * Non-blocking graph warnings are shown on the Dependency Graph tab instead,
 * next to the rows they describe.
 */
export default function HealthPanel({ issues }: Props) {
  const errors = issues.filter((i) => i.level === 'error')

  return (
    <>
      {errors.length > 0 && (
        <div className="notice error">
          <span>
            <strong>
              {errors.length} problem{errors.length === 1 ? '' : 's'} in the graph
            </strong>
            <ul>
              {errors.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </span>
        </div>
      )}
    </>
  )
}
