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

export async function issueGatewayKey(label: string): Promise<{ id: string; key: string }> {
  const res = await fetch(`${config.TTS_GATEWAY_URL}/admin/keys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireAdminSecret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ label }),
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

export async function drainGatewayUsage(): Promise<Array<{ id: string; chars: number }>> {
  const res = await fetch(`${config.TTS_GATEWAY_URL}/admin/usage/drain`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireAdminSecret()}`,
      'Content-Type': 'application/json',
    },
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
