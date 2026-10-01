'use client'

// The deploy / use / tear down controls shared by every tool that runs on a per-user GPU worker (voice convert, voice
// isolate, sound effects, dubbing). The tool renders this above its form and enables the form only while `onReadyChange`
// reports true. Wording and the countdown come from lib/deploymentView.ts (unit-tested); this file only renders them.
import { useCallback, useEffect, useState } from 'react'
import { deploymentsApi, DeploymentError, IN_PROGRESS, isReady, type Deployment, type DeploymentService } from '@/lib/deploymentsApi'
import { viewOf } from '@/lib/deploymentView'
import { ErrorNotice, Working, useUnmountFlag, type UiError } from './ToolShared'

interface Props {
  service: DeploymentService
  /** What the worker is, in lower case, for sentences: "voice converter". */
  noun: string
  signedIn: boolean
  /** Called whenever the deployment becomes ready or stops being ready. */
  onReadyChange?: (ready: boolean) => void
}

const FAST_REFRESH_MS = 3_000 // while it is starting or stopping
const SLOW_REFRESH_MS = 60_000 // while ready: notices the system stopping it, and activity resetting the idle timer
const TICK_MS = 15_000 // redraws the countdown between refreshes

function toDeployError(e: unknown, fallback: string): UiError {
  if (e instanceof DeploymentError) return { message: e.message, subscription: e.paymentRequired }
  return { message: e instanceof Error ? e.message : fallback, subscription: false }
}

export default function DeploymentPanel({ service, noun, signedIn, onReadyChange }: Props) {
  const cancelled = useUnmountFlag()
  // undefined = still checking, null = none yet
  const [dep, setDep] = useState<Deployment | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [error, setError] = useState<UiError | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    try {
      const d = await deploymentsApi.get(service)
      if (!cancelled()) setDep(d)
    } catch (e) {
      if (!cancelled()) setError(toDeployError(e, 'Could not check your worker.'))
    }
  }, [service, cancelled])

  useEffect(() => {
    if (signedIn) void refresh()
  }, [signedIn, refresh])

  const status = dep?.status
  useEffect(() => {
    if (!signedIn || !status) return
    const every = IN_PROGRESS.has(status) ? FAST_REFRESH_MS : status === 'ready' ? SLOW_REFRESH_MS : 0
    if (!every) return
    const id = setInterval(() => void refresh(), every)
    return () => clearInterval(id)
  }, [signedIn, status, refresh])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const ready = isReady(dep)
  useEffect(() => {
    onReadyChange?.(ready)
  }, [ready, onReadyChange])

  const deploy = async () => {
    setError(null)
    setBusy(true)
    try {
      const d = await deploymentsApi.deploy(service)
      if (!cancelled()) setDep(d)
    } catch (e) {
      if (!cancelled()) setError(toDeployError(e, 'Could not start your worker.'))
    } finally {
      if (!cancelled()) setBusy(false)
    }
  }

  const stop = async () => {
    setError(null)
    setBusy(true)
    setConfirmStop(false)
    try {
      await deploymentsApi.teardown(service)
      await refresh()
    } catch (e) {
      if (!cancelled()) setError(toDeployError(e, 'Could not stop your worker.'))
    } finally {
      if (!cancelled()) setBusy(false)
    }
  }

  const view = viewOf(dep, now)

  return (
    <div className="ra-vs-card" style={{ marginBottom: 20 }}>
      <h3 style={{ marginBottom: 8 }}>Your {noun}</h3>
      <ErrorNotice error={error} />

      {dep === undefined ? (
        <p className="ra-small">Checking…</p>
      ) : view.kind === 'none' ? (
        <>
          {view.note && <p className="ra-small" role="status">{view.note}</p>}
          <p className="ra-lede" style={{ fontSize: '1rem' }}>
            Start a private GPU worker for this tool. It runs on our infrastructure for you alone, stops by itself after a
            period of inactivity, and you can stop it at any time. Your files pass through our servers to reach it.
          </p>
          <div className="ra-cta" style={{ marginTop: 12 }}>
            <button className="ra-btn solid" onClick={deploy} disabled={busy || !signedIn}>
              {busy ? 'Starting…' : `Start ${noun}`}
            </button>
          </div>
          <p className="ra-small" style={{ marginTop: 8 }}>Usage is billed at the rates shown with the tool.</p>
        </>
      ) : view.kind === 'starting' ? (
        <Working title={`Starting your ${noun}`}>This usually takes under a minute.</Working>
      ) : view.kind === 'ready' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="ra-vs-pill ready" style={{ fontSize: '.75rem' }}>Ready</span>
            {view.remaining && (
              <span className="ra-small" role="status">
                Stops automatically in {view.remaining} without use. Using it resets the timer.
              </span>
            )}
            <div style={{ marginLeft: 'auto' }} className="ra-cta">
              {confirmStop ? (
                <>
                  <button className="ra-btn ghost danger" onClick={stop} disabled={busy}>Yes, stop it</button>
                  <button className="ra-btn ghost" onClick={() => setConfirmStop(false)} disabled={busy}>Keep it</button>
                </>
              ) : (
                <button className="ra-btn ghost danger" onClick={() => setConfirmStop(true)} disabled={busy}>
                  Stop {noun}
                </button>
              )}
            </div>
          </div>
          {confirmStop && (
            <p className="ra-small" style={{ marginTop: 8 }}>
              Download any results first: once it stops, results that have not been fetched cannot be retrieved.
            </p>
          )}
        </>
      ) : view.kind === 'stopping' ? (
        <Working title={`Stopping your ${noun}`}>You can start a new one once this finishes.</Working>
      ) : (
        <>
          <p className="ra-vs-notice bad" role="alert">
            Starting your {noun} failed. Try again; if it keeps failing, contact support.
          </p>
          <div className="ra-cta">
            <button className="ra-btn solid" onClick={deploy} disabled={busy}>
              {busy ? 'Starting…' : 'Try again'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
