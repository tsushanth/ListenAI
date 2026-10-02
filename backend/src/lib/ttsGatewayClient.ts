// Client for realtime-tts-gateway's admin API (separate Fly app/repo,
// github.com/tsushanth/realtime-tts). Used only by ttsApiKeys.ts to issue/revoke
// keys on behalf of a signed-in ReadAloud user — never called from client code.
import { config } from './config.js';
import { logger } from './logger.js';

const gatewayLogger = logger.child({ module: 'ttsGatewayClient' });

function requireAdminSecret(): string {
  if (!config.TTS_GATEWAY_ADMIN_SECRET) {
    throw new Error('TTS_GATEWAY_ADMIN_SECRET is not configured');
  }
  return config.TTS_GATEWAY_ADMIN_SECRET;
}

// `owner` (the Supabase user id) is embedded by the gateway in this key's session tokens as `uid`, which is
// how per-user resources such as custom voices follow the user across keys.
// `freeChars` (optional) is the user's remaining free credits: the gateway clamps it and uses it to LOWER the
// owner's shared free pool (it can never raise it), so the gateway never grants more than the credit ledger
// says. Omit it for billing-active users. An older gateway ignores the field.
export async function issueGatewayKey(label: string, owner?: string, freeChars?: number): Promise<{ id: string; key: string }> {
  const res = await fetch(`${config.TTS_GATEWAY_URL}/admin/keys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireAdminSecret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ label, ...(owner ? { owner } : {}), ...(owner && freeChars !== undefined ? { freeChars: Math.max(0, Math.floor(freeChars)) } : {}) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    gatewayLogger.error({ status: res.status, body }, 'Failed to issue gateway key');
    throw new Error(`gateway key issuance failed: ${res.status}`);
  }
  return res.json();
}

export async function setGatewayKeyBilling(id: string, enabled: boolean): Promise<boolean> {
  const res = await fetch(`${config.TTS_GATEWAY_URL}/admin/keys/billing`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireAdminSecret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id, enabled }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    gatewayLogger.error({ status: res.status, body, id }, 'Failed to set gateway key billing status');
    return false;
  }
  return true;
}

// One entry per key with usage since the last drain. `chars` is the TOTAL across engines (Piper included),
// `piperChars` its Piper subset, `audioSeconds` batch speech-to-text audio (separate from chars).
// audioSeconds is optional so an older gateway that predates STT still type-checks.
export interface GatewayUsageEntry {
  id: string;
  chars: number;
  piperChars?: number;
  audioSeconds?: number;
}

// Free-tier characters consumed by one OWNER (all their non-billing keys share one pool) since the last drain.
export interface GatewayFreeUsage {
  owner: string;
  chars: number;
}

// New gateways answer an `includeFree` drain with this object; older ones with the bare entries array.
export interface GatewayDrainResult {
  usage: GatewayUsageEntry[];
  freeChars: GatewayFreeUsage[];
}

/** Accepts either gateway shape (legacy array, or { usage, freeChars }) and returns the object form. */
export function normalizeGatewayDrain(raw: GatewayUsageEntry[] | Partial<GatewayDrainResult> | null | undefined): GatewayDrainResult {
  if (Array.isArray(raw)) return { usage: raw, freeChars: [] };
  return {
    usage: Array.isArray(raw?.usage) ? raw.usage : [],
    freeChars: Array.isArray(raw?.freeChars) ? raw.freeChars : [],
  };
}

// Drains paid usage (per key) AND, from a gateway that supports it, free-tier usage per owner. Returns the
// legacy array when the gateway is older (it ignores `includeFree`), so callers must normalizeGatewayDrain().
export async function drainGatewayUsage(): Promise<GatewayUsageEntry[] | GatewayDrainResult> {
  const res = await fetch(`${config.TTS_GATEWAY_URL}/admin/usage/drain`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireAdminSecret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ includeFree: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    gatewayLogger.error({ status: res.status, body }, 'Failed to drain gateway usage');
    return [];
  }
  return res.json();
}

export async function revokeGatewayKey(id: string): Promise<boolean> {
  const res = await fetch(`${config.TTS_GATEWAY_URL}/admin/keys`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${requireAdminSecret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id }),
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    gatewayLogger.error({ status: res.status, body, id }, 'Failed to revoke gateway key');
    throw new Error(`gateway key revocation failed: ${res.status}`);
  }
  return true;
}

// Backfill for keys issued before owners existed: sets the owner only if the key has none.
// true = owner is now (or already was) this user; false = unknown key, conflicting owner or error.
export async function setGatewayKeyOwner(id: string, owner: string): Promise<boolean> {
  const res = await fetch(`${config.TTS_GATEWAY_URL}/admin/keys/owner`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireAdminSecret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ id, owner }),
  });
  if (!res.ok) {
    gatewayLogger.warn({ status: res.status, id }, 'Could not set gateway key owner');
    return false;
  }
  return true;
}
