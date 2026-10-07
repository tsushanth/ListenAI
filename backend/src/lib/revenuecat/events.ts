// Pure RevenueCat webhook event interpretation. No I/O. Doc basis (fetched 2026-10-06):
//   https://www.revenuecat.com/docs/integrations/webhooks                      (auth header, retries, at-least-once, event id)
//   https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields (types + fields)
// Items marked UNVERIFIED are not stated by those pages and should be checked against a real sandbox event.
export type PlanId = 'free' | 'basic' | 'pro' | 'unlimited';
const PLAN_IDS: readonly string[] = ['free', 'basic', 'pro', 'unlimited'];

export interface RcEvent {
  id?: unknown; type?: unknown; app_user_id?: unknown; event_timestamp_ms?: unknown; expiration_at_ms?: unknown;
  product_id?: unknown; new_product_id?: unknown; entitlement_ids?: unknown; entitlement_id?: unknown;
  environment?: unknown; store?: unknown; cancel_reason?: unknown; transferred_from?: unknown; transferred_to?: unknown;
}

export interface ApplyRecord {
  eventId: string; eventType: string; userId: string; eventTsMs: number;
  status: 'active' | 'expired'; planId: PlanId; productId: string | null; store: string | null;
  expiresAtMs: number | null; canceledAtMs: number | null; cancelReason: string | null;
}

export type Decision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'apply'; records: ApplyRecord[] };

export interface MapConfig { map: Record<string, PlanId>; acceptSandbox: boolean }

/** REVENUECAT_PRODUCT_PLAN_MAP: JSON object { "<product_id or entitlement_id>": "basic|pro|unlimited|free" }. Invalid -> empty. */
export function parsePlanMap(raw: string | undefined): Record<string, PlanId> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out: Record<string, PlanId> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && PLAN_IDS.includes(v)) out[k] = v as PlanId;
    return out;
  } catch { return {}; }
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): MapConfig {
  return { map: parsePlanMap(env.REVENUECAT_PRODUCT_PLAN_MAP), acceptSandbox: env.REVENUECAT_ACCEPT_SANDBOX === '1' };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUserUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

const GRANT_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'BILLING_ISSUE', 'SUBSCRIPTION_EXTENDED', 'REFUND_REVERSED']);

/** Product ids on Play can look like "sub_id:base_plan"; try the full id, then the part before ':'. */
function lookup(map: Record<string, PlanId>, id: string): PlanId | undefined {
  return map[id] ?? map[id.split(':')[0]!];
}

/** null = this subscription is not entitled (no entitlement ids and no mapped product). Default plan: 'basic'. */
export function resolvePlan(productId: string | null, entitlementIds: string[], map: Record<string, PlanId>): PlanId | null {
  if (productId) { const p = lookup(map, productId); if (p) return p; }
  for (const e of entitlementIds) { const p = map[e]; if (p) return p; }
  return entitlementIds.length > 0 ? 'basic' : null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function interpretEvent(ev: RcEvent, cfg: MapConfig): Decision {
  const id = str(ev.id), type = str(ev.type), ts = num(ev.event_timestamp_ms);
  if (!id || !type || ts === null) return { kind: 'ignore', reason: 'missing id/type/event_timestamp_ms' };
  if (type === 'TEST') return { kind: 'ignore', reason: 'test event' };
  if (ev.environment === 'SANDBOX' && !cfg.acceptSandbox) return { kind: 'ignore', reason: 'sandbox event (REVENUECAT_ACCEPT_SANDBOX not set)' };

  if (type === 'TRANSFER') {
    // Doc: sent to the destination user only; carries transferred_from/transferred_to arrays (field names from the
    // docs' TRANSFER description: UNVERIFIED shape). We cannot know the destination's expiry from this event, so we
    // only revoke the SOURCE users (they lost the entitlement). The destination is granted by its next
    // RENEWAL/INITIAL_PURCHASE/UNCANCELLATION event or after the app re-syncs.
    const from = Array.isArray(ev.transferred_from) ? ev.transferred_from.filter(isUserUuid) : [];
    if (from.length === 0) return { kind: 'ignore', reason: 'transfer with no UUID source users' };
    return { kind: 'apply', records: from.map((u) => ({
      eventId: `${id}:${u}`, eventType: type, userId: u, eventTsMs: ts, status: 'expired' as const, planId: 'basic' as const,
      productId: null, store: str(ev.store), expiresAtMs: ts, canceledAtMs: null, cancelReason: 'TRANSFER',
    })) };
  }

  const granting = GRANT_TYPES.has(type);
  if (!granting && type !== 'CANCELLATION' && type !== 'EXPIRATION') {
    // NON_RENEWING_PURCHASE: no expiry, not a subscription -> never grants cloning. SUBSCRIPTION_PAUSED: doc says do
    // NOT revoke on it (revoke only on EXPIRATION with reason SUBSCRIPTION_PAUSED). Everything else is irrelevant.
    return { kind: 'ignore', reason: `event type ${type} does not change entitlement` };
  }

  const uid = ev.app_user_id;
  if (typeof uid === 'string' && uid.startsWith('$RCAnonymousID:')) return { kind: 'ignore', reason: 'anonymous app_user_id' };
  if (!isUserUuid(uid)) return { kind: 'ignore', reason: 'app_user_id is not a Supabase user UUID' };
  const userId = uid.toLowerCase();

  const productId = type === 'PRODUCT_CHANGE' ? (str(ev.new_product_id) ?? str(ev.product_id)) : str(ev.product_id);
  const ents = [...(Array.isArray(ev.entitlement_ids) ? ev.entitlement_ids : []), ...(str(ev.entitlement_id) ? [ev.entitlement_id] : [])]
    .filter((e): e is string => typeof e === 'string' && e.length > 0);
  const exp = num(ev.expiration_at_ms);
  const base = { eventId: id, eventType: type, userId, eventTsMs: ts, productId, store: str(ev.store), cancelReason: str(ev.cancel_reason) };

  if (type === 'EXPIRATION') {
    return { kind: 'apply', records: [{ ...base, status: 'expired', planId: resolvePlan(productId, ents, cfg.map) ?? 'basic', expiresAtMs: exp ?? ts, canceledAtMs: null }] };
  }

  const planId = resolvePlan(productId, ents, cfg.map);
  if (!planId || planId === 'free') return { kind: 'ignore', reason: 'no entitlement / product maps to a paid plan' };

  if (type === 'CANCELLATION') {
    // Doc: fires on cancel (still entitled until expiration) AND on refund. A refund (cancel_reason CUSTOMER_SUPPORT)
    // must stop access now: treated as expired. UNVERIFIED that a refund always arrives with that exact reason.
    const refunded = base.cancelReason === 'CUSTOMER_SUPPORT';
    if (!refunded && exp === null) return { kind: 'ignore', reason: 'cancellation without expiration_at_ms' };
    return { kind: 'apply', records: [{ ...base, status: refunded ? 'expired' : 'active', planId, expiresAtMs: refunded ? ts : exp, canceledAtMs: ts }] };
  }

  if (exp === null) return { kind: 'ignore', reason: 'grant event without expiration_at_ms' };
  // BILLING_ISSUE: doc says the subscription has not expired; access follows expiration_at_ms (grace handling UNVERIFIED).
  return { kind: 'apply', records: [{ ...base, status: 'active', planId, expiresAtMs: exp, canceledAtMs: null }] };
}
