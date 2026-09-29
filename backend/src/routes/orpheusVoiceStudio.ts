// Web-session-authenticated front door for Orpheus streaming voice cloning, mounted at
// /api/orpheus-voice-studio. Unlike orpheusVoiceStudioApiKey.ts (which trusts a shared secret forwarded
// by realtime-tts-gateway on behalf of an API key caller), this route authenticates a real logged-in
// customer via their Supabase session bearer token — the same mechanism routes/voiceStudio.ts uses for
// the Piper cloning UI (verifyAuthTokenRemote on the bearer token).
//
// This is a SEPARATE file from orpheusVoiceStudioApiKey.ts by design: that file's trust model (gateway
// shared secret, identity from X-Gateway-Uid/X-Gateway-Key-Id headers) must not change. The security
// fixes it already has — voice-id regex validation before any path use, Buffer.from(await
// upstream.arrayBuffer()) for binary-safe relay (never .text(), which would corrupt non-UTF8 audio
// bytes), AbortSignal.timeout() on every upstream fetch, and auth-before-body-parsing — are duplicated
// here rather than factored into a shared helper module. Reasoning: the two routers' auth middlewares are
// genuinely different (shared secret + forwarded header identity vs. Supabase JWT verification) and the
// only shared logic is a handful of small, stable functions (~10 lines each: a regex test, a relay
// helper, two env getters). Extracting a shared module would require touching
// orpheusVoiceStudioApiKey.ts's imports, which the task explicitly says not to disturb, in exchange for
// avoiding a small, low-risk amount of duplication. Duplication was judged the safer trade here.
import express, { Router, Request, Response, NextFunction } from 'express';
import { verifyAuthTokenRemote, extractBearerToken } from '../lib/auth.js';

const router = Router();

// Matches orpheusVoiceStudioApiKey.ts's RAW_ZIP_LIMIT.
const RAW_ZIP_LIMIT = 32 * 1024 * 1024;

// Same voice-id shape enforced by the API-key route and the Piper voiceStudioRouter.
const VOICE_ID_RE = /^v-[0-9a-f]{10}$/;

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const TTS_UPSTREAM_TIMEOUT_MS = 60_000;

function serviceUrl(): string {
  return process.env.ORPHEUS_CLONE_SERVICE_URL || '';
}

function serviceSecret(): string {
  return process.env.ORPHEUS_CLONE_SECRET || '';
}

/** Forward the Modal response's status/body straight through to our caller (the browser). Binary-safe:
 * arrayBuffer() + Buffer.from(), never .text(), so audio bytes are never corrupted by UTF-8 decoding. */
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

type Authed = Request & { orpheusOwner?: string };

/** Verifies the caller's Supabase session before any body parsing happens (same ordering rationale as
 * orpheusVoiceStudioApiKey.ts's requireGatewayAuth: reject unauthenticated requests before buffering
 * potentially large bodies). The resolved Supabase user id becomes X-Owner on the upstream Modal call,
 * exactly how the API-key route uses the gateway-resolved identity — scoping every operation to the
 * authenticated user. */
async function requireSupabaseAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    const { userId } = await verifyAuthTokenRemote(token);
    if (!userId) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    (req as Authed).orpheusOwner = userId;
    next();
  } catch {
    res.status(401).json({ error: 'Sign in required.' });
  }
}

router.post('/', requireSupabaseAuth, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as Authed).orpheusOwner!,
      },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.put('/:vid/dataset', requireSupabaseAuth, express.raw({ type: '*/*', limit: RAW_ZIP_LIMIT }), async (req: Request, res: Response) => {
  const vid = validateVid(req, res);
  if (!vid) return;
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${vid}/dataset`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/zip',
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as Authed).orpheusOwner!,
      },
      body: req.body,
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.post('/:vid/dataset/commit', requireSupabaseAuth, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
  const vid = validateVid(req, res);
  if (!vid) return;
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${vid}/dataset/commit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as Authed).orpheusOwner!,
      },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.get('/:vid', requireSupabaseAuth, async (req: Request, res: Response) => {
  const vid = validateVid(req, res);
  if (!vid) return;
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${vid}`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as Authed).orpheusOwner!,
      },
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.delete('/:vid', requireSupabaseAuth, async (req: Request, res: Response) => {
  const vid = validateVid(req, res);
  if (!vid) return;
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-voices/${vid}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as Authed).orpheusOwner!,
      },
      signal: AbortSignal.timeout(DEFAULT_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

router.post('/tts', requireSupabaseAuth, express.json({ limit: '16kb' }), async (req: Request, res: Response) => {
  try {
    const upstream = await fetch(`${serviceUrl()}/v1/orpheus-tts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceSecret()}`,
        'x-owner': (req as Authed).orpheusOwner!,
      },
      body: JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(TTS_UPSTREAM_TIMEOUT_MS),
    });
    await relayResponse(res, upstream);
  } catch {
    res.status(502).json({ error: 'orpheus clone service unavailable' });
  }
});

export const orpheusVoiceStudioRouter = router;
