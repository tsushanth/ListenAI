/**
 * Paywall mode configuration.
 * "soft"       - show paywall only on first app open; no re-show after dismiss; no winback.
 *                Use this during App Store review to satisfy guideline 5.6.
 * "aggressive" - current behaviour (3rd/7th open, every 10th after 17th; winback enabled).
 *                Switch to this after review approval via the admin endpoint.
 */

export type PaywallMode = 'soft' | 'aggressive';

let currentMode: PaywallMode =
  (process.env.PAYWALL_MODE as PaywallMode | undefined) === 'aggressive'
    ? 'aggressive'
    : 'soft'; // default to soft for safety

export function getPaywallMode(): PaywallMode {
  return currentMode;
}

export function setPaywallMode(mode: PaywallMode): void {
  currentMode = mode;
}

/**
 * Tuning for the Android paywall policy (see PaywallPolicy in the Android app). The app reads
 * this from GET /api/config in the background and applies it from its next start. Each value
 * falls back to the app's built-in default when unset here.
 */
export interface PaywallTuning {
  minOpensAfterFirstListen: number
  openLimitWithoutListen: number
  cooldownHours: number
}

function intFromEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) ? n : fallback
}

export function getPaywallTuning(): PaywallTuning {
  return {
    minOpensAfterFirstListen: intFromEnv('PAYWALL_MIN_OPENS_AFTER_FIRST_LISTEN', 2),
    openLimitWithoutListen: intFromEnv('PAYWALL_OPEN_LIMIT_WITHOUT_LISTEN', 3),
    cooldownHours: intFromEnv('PAYWALL_COOLDOWN_HOURS', 24),
  }
}
