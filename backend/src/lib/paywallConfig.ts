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
