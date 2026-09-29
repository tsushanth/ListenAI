// Internal, gateway-trusted front door for Orpheus streaming voice cloning, mounted at
// /internal/orpheus-clone-api (not directly customer facing — reachable only from realtime-tts-gateway,
// which has already validated the caller's API key and billing status the same way it validates
// /tts/authorize, then forwards the request here with a shared secret plus the resolved identity as
// headers; see gateway/orpheusApiProxy.js).
//
// Unlike voiceStudioApiKey.ts, there is no existing web UI for Orpheus cloning to share business logic
// with, so this is a plain, direct Express router (no createVoiceStudioRouter factory abstraction) that
// simply proxies to the Modal training/serving service using its own bearer secret (ORPHEUS_CLONE_SECRET,
// distinct from GATEWAY_FORWARD_SECRET, which is only the gateway<->backend hop's secret).
import express, { Router, Request, Response } from 'express';

const router = Router();

// Single-shot zip dataset upload: needs the raw bytes, not JSON-parsed body. 32MB matches the gateway's
// single-shot upload cap (orpheusApiProxy.js MAX_BODY_BYTES).
const RAW_ZIP_LIMIT = 32 * 1024 * 1024;

// Real voice ids look like "v-" + 10 hex chars. Enforced on every route that takes :vid so a crafted
// segment (e.g. "..%2F..%2Fadmin" or "v-1%3Fx%3D1", which Express URL-decodes before we see req.params.vid)
// can't redirect the outbound Modal fetch — which carries our real bearer secret — to an arbitrary path
// or inject a query string.
const VOICE_ID_RE = /^v-[0-9a-f]{10}$/;

// Default timeout for the JSON/control-plane routes; a hung Modal cold start shouldn't hold the
// connection open indefinitely. The /tts synthesis route gets a longer budget since real generation
// time is involved.
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const TTS_UPSTREAM_TIMEOUT_MS = 60_000;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Resolves the caller's identity (from the gateway-forwarded headers) after validating the shared
 * secret. Returns null if the secret is missing/wrong or no identity header was forwarded. */
function authenticate(req: any): string | null {
  const secret = process.env.GATEWAY_FORWARD_SECRET || '';
  const got = String(req.headers['x-gateway-admin-secret'] ?? '');
  if (!secret || !got || !timingSafeEqual(got, secret)) return null;
  const uid = String(req.headers['x-gateway-uid'] ?? '').trim();
  const keyId = String(req.headers['x-gateway-key-id'] ?? '').trim();
  const identity = uid || keyId;
  if (!identity || identity.length > 128) return null;
  return identity;
}

/** Middleware that checks authentication before any body parsing happens, and attaches the resolved
 * identity to the request for handlers to forward as X-Owner. Reject unauthenticated requests early to
 * prevent resource exhaustion from buffering large bodies. */
function requireGatewayAuth(req: Request, res: Response, next: () => void) {
  const owner = authenticate(req);
  if (!owner) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  (req as any).gatewayOwner = owner;
  next();
}

function serviceUrl(): string {
  return process.env.ORPHEUS_CLONE_SERVICE_URL || '';
}

function serviceSecret(): string {
  return process.env.ORPHEUS_CLONE_SECRET || '';
}

/** Forward the Modal response's status/body straight through to our caller (the gateway). */
async function relayResponse(res: Response, upstream: globalThis.Response) {
  const buf = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get('content-type') || 'application/json';
  res.status(upstream.status).set('content-type', contentType).send(buf);
}

function validateVid(req: Request, res: Response): string | null {
  const vid = String(req.params.vid ?? '');
  if (!VOICE_ID_RE.test(vid)) {
    res.status(400).json({ error: 'invalid voice id' });
    return null;
  }
  return vid;
}

router.post('/', requireGatewayAuth, async (req: Request, res: Response) => {
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as any).gatewayOwner,
      },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.put('/:vid/dataset', requireGatewayAuth, express.raw({ type: '*/*', limit: RAW_ZIP_LIMIT }), async (req: Request, res: Response) => {
  const vid = validateVid(req, res);
  if (!vid) return;
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${vid}/dataset`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/zip',
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as any).gatewayOwner,
      },
      body: req.body,
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.post('/:vid/dataset/commit', requireGatewayAuth, async (req: Request, res: Response) => {
  const vid = validateVid(req, res);
  if (!vid) return;
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${vid}/dataset/commit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as any).gatewayOwner,
      },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.get('/:vid', requireGatewayAuth, async (req: Request, res: Response) => {
  const vid = validateVid(req, res);
  if (!vid) return;
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${vid}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as any).gatewayOwner,
      },
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.delete('/:vid', requireGatewayAuth, async (req: Request, res: Response) => {
  const vid = validateVid(req, res);
  if (!vid) return;
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${vid}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as any).gatewayOwner,
      },
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.post('/tts', requireGatewayAuth, async (req: Request, res: Response) => {
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-tts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as any).gatewayOwner,
      },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(TTS_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

export const orpheusVoiceStudioApiKeyRouter = router;
