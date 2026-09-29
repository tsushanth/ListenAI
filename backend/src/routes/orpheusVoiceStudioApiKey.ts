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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

function serviceUrl(): string {
  return process.env.ORPHEUS_CLONE_SERVICE_URL || '';
}

function serviceSecret(): string {
  return process.env.ORPHEUS_CLONE_SECRET || '';
}

/** Forward the Modal response's status/body straight through to our caller (the gateway). */
async function relayResponse(res: Response, upstream: globalThis.Response) {
  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type') || 'application/json';
  res.status(upstream.status).set('content-type', contentType).send(text);
}

router.post('/', async (req: Request, res: Response) => {
  if (!authenticate(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceSecret()}`,
      },
      body: JSON.stringify(req.body ?? {}),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.put('/:vid/dataset', express.raw({ type: '*/*', limit: RAW_ZIP_LIMIT }), async (req: Request, res: Response) => {
  if (!authenticate(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${req.params.vid}/dataset`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/zip',
        authorization: `Bearer ${serviceSecret()}`,
      },
      body: req.body,
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.post('/:vid/dataset/commit', async (req: Request, res: Response) => {
  if (!authenticate(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${req.params.vid}/dataset/commit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceSecret()}`,
      },
      body: JSON.stringify(req.body ?? {}),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.get('/:vid', async (req: Request, res: Response) => {
  if (!authenticate(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${req.params.vid}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${serviceSecret()}` },
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.delete('/:vid', async (req: Request, res: Response) => {
  if (!authenticate(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${req.params.vid}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${serviceSecret()}` },
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

export const orpheusVoiceStudioApiKeyRouter = router;
