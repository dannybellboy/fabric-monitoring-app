import { useCallback, useEffect, useState } from 'react'

import { api } from '../api'
import type { AuthStatus, PreflightReport } from '../types'

interface Props {
  status: AuthStatus
  /** Called once sign-in succeeds, so the app can load its data. */
  onSignedIn: () => void
  /**
   * Called right after sign-in starts, with a fresh /api/auth read. The parent
   * only polls for completion while its own `signIn.state` is "pending" -- and
   * nothing sets that until this fires, so without it the app would never
   * notice the browser tab finished until someone manually reloaded the page.
   */
  onAuthChange: (status: AuthStatus) => void
}

/**
 * Shown instead of the app until there is a usable Azure token.
 *
 * Sign-in happens in the system browser, so a teammate needs no terminal and no
 * `az login`. The device-code flow is kept as a visible fallback because the
 * loopback-redirect browser flow can be blocked by device management, and when that
 * happens the person needs a way forward rather than a dead end.
 */
export default function SignInGate({ status, onSignedIn, onAuthChange }: Props) {
  const [preflight, setPreflight] = useState<PreflightReport | null>(null)
  const [starting, setStarting] = useState(false)
  const [copied, setCopied] = useState(false)

  const signIn = status.signIn
  const pending = signIn?.state === 'pending'

  const loadPreflight = useCallback(() => {
    api.preflight().then(setPreflight).catch(() => setPreflight(null))
  }, [])

  useEffect(loadPreflight, [loadPreflight])

  // Re-run the checks once signed in, so a fixed problem stops being reported.
  useEffect(() => {
    if (signIn?.state === 'ok') {
      loadPreflight()
      onSignedIn()
    }
  }, [signIn?.state, loadPreflight, onSignedIn])

  const start = async (method: 'browser' | 'device') => {
    setStarting(true)
    try {
      await api.signIn(method)
      // The server marks itself "pending" synchronously, before the interactive
      // flow even opens a browser tab -- so this one read is enough to flip the
      // parent's state and kick off its poll loop.
      onAuthChange(await api.auth())
    } finally {
      setStarting(false)
    }
  }

  const code = signIn?.deviceCode
  const blocking = preflight?.checks.filter((c) => c.status === 'fail') ?? []
  // A missing ODBC driver cannot be fixed by signing in, so say so up front.
  const driverBroken = blocking.some((c) => c.name === 'ODBC driver')

  return (
    <div className="gate">
      <div className="gate-card panel">
        <img className="gate-logo" src="/logo.png" alt="" aria-hidden="true" />
        <h1>HDX Management Tool</h1>
        <p className="gate-sub">
          Source-to-target spec, orchestrator dependency graph, and process health for
          Hanger Data Engineering.
        </p>

        {driverBroken ? (
          <div className="notice error">
            <span>
              <strong>Missing a Windows component</strong>
              Signing in will not help until this is installed:
              <ul>
                {blocking
                  .filter((c) => c.name === 'ODBC driver')
                  .map((c) => (
                    <li key={c.name}>
                      {c.detail}
                      {c.fix && (
                        <>
                          <br />
                          {c.fix}
                        </>
                      )}
                    </li>
                  ))}
              </ul>
              <button onClick={loadPreflight} style={{ marginTop: 10 }}>
                Re-check
              </button>
            </span>
          </div>
        ) : (
          <>
            {!pending && (
              <>
                <button
                  className="primary gate-button"
                  disabled={starting}
                  onClick={() => void start('browser')}
                >
                  Sign in with your Hanger account
                </button>
                <p className="gate-hint">
                  Opens your browser. Nothing to install, and you only do this once on
                  this machine.
                </p>
                <button className="link" disabled={starting} onClick={() => void start('device')}>
                  Browser sign-in blocked? Use a device code instead
                </button>
              </>
            )}

            {pending && !code && (
              <div className="notice info">
                <span>
                  <strong>Waiting for you to finish in the browser</strong>
                  A browser tab should have opened. Sign in there and this page will
                  continue automatically. If no tab appeared, use the device-code option.
                </span>
              </div>
            )}

            {pending && code && (
              <div className="notice info">
                <span>
                  <strong>Enter this code to sign in</strong>
                  <ol className="gate-steps">
                    <li>
                      Open{' '}
                      <a href={code.url} target="_blank" rel="noreferrer">
                        {code.url}
                      </a>
                    </li>
                    <li>
                      Enter code{' '}
                      <code className="devicecode">{code.code}</code>{' '}
                      <button
                        onClick={() => {
                          void navigator.clipboard?.writeText(code.code).then(() => {
                            setCopied(true)
                            window.setTimeout(() => setCopied(false), 1800)
                          })
                        }}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </li>
                    <li>Sign in with your Hanger account</li>
                  </ol>
                  This page continues automatically once you are done.
                </span>
              </div>
            )}

            {signIn?.state === 'failed' && (
              <div className="notice error">
                <span>
                  <strong>Sign-in did not complete</strong>
                  {signIn.error}
                  <br />
                  Try again, or use the device-code option.
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
