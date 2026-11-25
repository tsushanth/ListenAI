// Pull side of the RevenueCat entitlement check: asks RevenueCat whether this account has a subscription that gives
// access right now. It covers subscribers who bought before the webhook existed (no event until their next renewal) and
// TRANSFER destinations. Read-only (API v2, permission customer_information:subscriptions:read); writes nothing.
//
// The app calls Purchases.logIn(<account id>) at sign-in, which attaches an anonymous purchase to the account, so the
// account id is the RevenueCat customer to ask about.
//
// Env (off unless both are set): REVENUECAT_API_KEY (secret v2 key), REVENUECAT_PROJECT_ID.
// REVENUECAT_ACCEPT_SANDBOX=1 also counts sandbox (test) purchases.
import { isUserUuid } from './events.js';
import { signalProviderFailureFromStatus } from '../failureSignals.js';

const BASE = 'https://api.revenuecat.com/v2';
const TIMEOUT_MS = 5_000;
export const POSITIVE_TTL_MS = 10 * 60_000;
export const NEGATIVE_TTL_MS = 60_000;
const MAX_CACHED = 5_000;

export interface LookupConfig { apiKey: string; projectId: string; acceptSandbox: boolean }

export function lookupConfigFromEnv(env: Record<string, string | undefined> = process.env): LookupConfig | null {
  const apiKey = (env.REVENUECAT_API_KEY ?? '').trim();
  const projectId = (env.REVENUECAT_PROJECT_ID ?? '').trim();
  return apiKey && projectId ? { apiKey, projectId, acceptSandbox: env.REVENUECAT_ACCEPT_SANDBOX === '1' } : null;
}

interface Subscription { gives_access?: unknown; environment?: unknown }

export interface LookupDeps {
  config?: () => LookupConfig | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  report?: (status: number) => void;
}

export function createLiveLookup(deps: LookupDeps = {}) {
  const config = deps.config ?? (() => lookupConfigFromEnv());
  const now = deps.now ?? Date.now;
  const report = deps.report ?? ((status: number) => signalProviderFailureFromStatus('revenuecat', status));
  const cache = new Map<string, { value: boolean; until: number }>();

  /** True / false from RevenueCat; throws when RevenueCat cannot be asked (never cached). */
  return async function hasLiveSubscription(userId: string): Promise<boolean> {
    const cfg = config();
    if (!cfg || !isUserUuid(userId)) return false;
    const id = userId.toLowerCase();
    const hit = cache.get(id);
    if (hit && hit.until > now()) return hit.value;

    const res = await (deps.fetchImpl ?? fetch)(
      `${BASE}/projects/${encodeURIComponent(cfg.projectId)}/customers/${encodeURIComponent(id)}/subscriptions?limit=50`,
      { headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    let value = false;
    if (res.status !== 404) { // 404: RevenueCat has never seen this account, so it has bought nothing under it
      if (!res.ok) { report(res.status); throw new Error(`revenuecat lookup failed: HTTP ${res.status}`); }
      const body = (await res.json()) as { items?: Subscription[] };
      value = (body.items ?? []).some((s) => s.gives_access === true && (s.environment === 'production' || cfg.acceptSandbox));
    }
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(id, { value, until: now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    return value;
  };
}

export const hasLiveSubscription = createLiveLookup();
