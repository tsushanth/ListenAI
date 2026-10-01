// What to show for a tool's deployment. Pure functions, so the wording and the countdown are unit-tested; the component
// (components/ra/DeploymentPanel.tsx) only renders what these return.
import type { Deployment } from './deploymentsApi.ts'

export type DeploymentViewKind = 'none' | 'starting' | 'ready' | 'stopping' | 'failed'

export interface DeploymentView {
  kind: DeploymentViewKind
  /** Why the previous deployment ended, when that is worth telling the user (idle timeout, age limit). */
  note?: string
  /** "27 min" until the system stops it. Only when ready. */
  remaining?: string
}

/** "under a minute", "27 min", "1 h 5 min". */
export function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  if (s < 60) return 'under a minute'
  const minutes = Math.ceil(s / 60)
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** A short explanation of why the last deployment ended, only for endings the user did not cause. */
export function endedNote(reason: string | null | undefined): string | undefined {
  switch (reason) {
    case 'idle':
      return 'Your last worker stopped after a period of inactivity.'
    case 'max_age':
      return 'Your last worker reached its maximum running time and stopped.'
    case 'deploy_timeout':
      return 'Your last worker did not finish starting and was cancelled.'
    case 'teardown_failed':
      return 'We could not confirm your last worker stopped. Please contact support so it is not left running.'
    default:
      return undefined
  }
}

/** Seconds until auto-teardown, counted from the browser clock so the display ticks between refreshes. */
export function secondsUntilTeardown(d: Deployment, nowMs: number): number | null {
  if (d.auto_teardown_at) {
    const t = Date.parse(d.auto_teardown_at)
    if (Number.isFinite(t)) return Math.max(0, Math.round((t - nowMs) / 1000))
  }
  return d.seconds_until_auto_teardown
}

export function viewOf(d: Deployment | null | undefined, nowMs: number): DeploymentView {
  if (!d) return { kind: 'none' }
  switch (d.status) {
    case 'requested':
    case 'deploying':
      return { kind: 'starting' }
    case 'ready': {
      const secs = secondsUntilTeardown(d, nowMs)
      return { kind: 'ready', remaining: secs === null ? undefined : formatRemaining(secs) }
    }
    case 'stopping':
      return { kind: 'stopping' }
    case 'failed':
      return { kind: 'failed' }
    case 'stopped':
    default:
      return { kind: 'none', note: endedNote(d.stop_reason) }
  }
}
