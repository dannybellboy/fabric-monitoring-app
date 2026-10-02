import { useEffect, useState } from 'react'

import { ApiError, api } from '../api'

/**
 * The embed token Datadog issues is single-use and expires in 30 minutes, so a
 * fresh one is fetched every time this tab is opened rather than cached. Once the
 * iframe redeems it, Datadog grants the browser its own 30-day session, so the
 * short expiry here only matters for how long the tab can sit unopened before use.
 */
export default function MonitoringView() {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    setError(null)
    api
      .datadogEmbedUrl()
      .then((res) => setUrl(res.url))
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="muted">Loading dashboard…</p>

  if (error) {
    return (
      <div className="notice warning">
        <span>{error}</span>
      </div>
    )
  }

  return (
    <iframe
      title="Datadog dashboard"
      src={url ?? undefined}
      style={{ width: '100%', height: 'calc(100vh - 140px)', border: 'none' }}
    />
  )
}
