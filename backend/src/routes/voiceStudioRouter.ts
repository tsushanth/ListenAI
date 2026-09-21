// Voice studio: signed-in customers create a custom TTS voice from their own recordings.
// Consent -> chunked upload -> automatic training -> preview -> deploy -> use -> delete.
//
// This router is the ONLY authority on which user may touch which voice: the intake API (Modal) trusts a
// shared secret, so every /:id route first loads the voice from intake and requires
// owner_user_id === the authenticated user, answering 404 (never 403) otherwise so ids can't be probed.
// Dependencies are injected (wired in voiceStudio.ts) so the rules are unit-testable with a mocked intake.
//
// Upload design: the browser slices the customer's zip into 8 MB parts and PUTs them one by one; each part
// is forwarded to intake immediately, then a commit call joins them. Why: a single big request (a) hits
// Cloud Run's 32 MiB HTTP/1 request limit, (b) over a slow home uplink outlives Modal's ~150 s web request
// limit (303 redirect the client must follow) and (c) can't resume. Small parts are stateless on this
// backend (nothing buffered on local disk, any instance can take any part) and resumable.
import express, { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { IntakeClient, IntakeError, IntakeVoiceStatus } from '../lib/voiceIntakeClient.js';

export const CONSENT_TEXT_VERSION = '2026-09-v1';
// Verbatim text an API caller (no UI, no click) must echo back in `consent_statement` to prove it was
// actually read, not just a version number typed in blind. The web flow doesn't need this: a human clicked
// "I attest..." next to the rendered text, which the version number alone already evidences.
export const CONSENT_STATEMENT =
  'I am authorized to consent on behalf of the speaker named in this request, and that speaker has agreed ' +
  'to have their voice cloned and used to synthesize new speech through this service.';
export const PART_BYTES_MAX = 12 * 1024 * 1024; // browser sends 8 MB parts; headroom, far below Cloud Run's 32 MiB limit
export const MAX_PARTS = 64; // matches intake.py
export const VOICE_ID_RE = /^v-[0-9a-f]{10}$/;

export interface VoiceStudioDeps {
  /** Returns the verified Supabase user id, or null (no/invalid token). */
  authenticate(req: Request): Promise<string | null>;
  intake: IntakeClient;
  /** Comma separated user ids, or "*" for everyone. Empty = feature off (everything 404s). */
  enabledUsers: () => string;
  maxVoicesPerUser: number;
  maxZipBytes: number;
  /** Sets the owner on the user's older gateway keys so their session tokens carry uid. Non-fatal. */
  backfillKeyOwners(userId: string): Promise<void>;
  log?: { warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
  rateLimits?: { create?: number; preview?: number; parts?: number };
  /** Identity checked against enabledUsers()'s allowlist. Defaults to the authenticated uid itself (web
   * flow: Supabase user id). The API-key flow passes the *key id* here instead, since decision #5 gates
   * the feature per-key, not per-uid (a key may have no bound uid, or share a uid with other keys). */
  featureFlagId?: (req: Request) => string;
  /** When true, POST / additionally requires body.consent_statement === CONSENT_STATEMENT verbatim (see
   * that constant's comment). Used by the API-key path, which has no UI click to stand in for it. */
  requireConsentStatement?: boolean;
  /** Gateway key ids that should ALSO own the voice at the serving layer (Piper owner.json's `key_ids`),
   * in addition to `owner_user_id` (`user_ids`). Needed because Piper's registry matches `user_ids`
   * against a session token's `uid` claim only (worker-piper-fly/server.py's `by_user` check) - a bare
   * API key with no bound Supabase uid has no `uid` on its tokens, so a voice whose owner.json only got
   * `user_ids: [<that key's id>]` would deploy successfully but be unusable by the very key that made it
   * ("unknown voice" on every synthesize call). The web flow doesn't need this (its identity is always a
   * real uid); the API-key flow returns `[keyId]` here whenever the resolved identity has no bound uid,
   * found and fixed by an end-to-end live test rather than code review. See intake.py's deploy handler
   * for how both fields end up in owner.json. */
  ownerKeyIdsFor?: (req: Request) => string[] | undefined;
}

type Authed = Request & { studioUserId?: string };
type Handler = (req: Authed, res: Response) => Promise<void>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req as Authed, res).catch(next);
};

const CTRL = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(CTRL, ' ').trim().slice(0, max) : '');

/** The only fields of intake's records the browser needs. Never forwards owner ids or paths. */
function publicVoice(v: IntakeVoiceStatus | Record<string, unknown>) {
  const s = v as IntakeVoiceStatus;
  const m = (s.manifest ?? {}) as Record<string, unknown>;
  return {
    id: s.voice_id,
    status: s.status,
    speaker_name: s.speaker_name ?? null,
    created_at: s.created_at ?? null,
    warnings: (m.warnings as unknown[]) ?? [],
    stats: s.manifest ? { minutes: m.minutes, clips: m.clips } : undefined,
    error: s.error ? { code: s.error.code ?? 'rejected', reason: s.error.reason ?? 'The recordings could not be used.' } : undefined,
    voice: s.voice,
  };
}

export function createVoiceStudioRouter(deps: VoiceStudioDeps): Router {
  const r = Router();
  const lim = { create: 20, preview: 40, parts: 400, ...deps.rateLimits };
  const limiter = (max: number) =>
    rateLimit({
      windowMs: 3600_000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `voice-studio:${(req as Authed).studioUserId ?? 'anon'}`,
      validate: false,
      message: { error: 'Too many requests, please try again later.' },
    });

  // Dark by default: with no allowlist nothing exists (404), authenticated or not.
  r.use((_req, res, next) => {
    if (!deps.enabledUsers().trim()) { res.status(404).json({ error: 'Not found' }); return; }
    next();
  });
  r.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = await deps.authenticate(req).catch(() => null);
      if (!uid) { res.status(401).json({ error: 'Sign in required.' }); return; }
      const flagId = deps.featureFlagId ? deps.featureFlagId(req) : uid;
      const allow = deps.enabledUsers().split(',').map((s) => s.trim()).filter(Boolean);
      if (!allow.includes('*') && !allow.includes(flagId)) { res.status(404).json({ error: 'Not found' }); return; }
      (req as Authed).studioUserId = uid;
      next();
    } catch (e) { next(e); }
  });

  /** Loads the voice and enforces ownership. Unknown id, malformed id and someone else's voice look identical. */
  async function owned(req: Authed, res: Response, id: string): Promise<IntakeVoiceStatus | null> {
    const miss = () => { res.status(404).json({ error: 'Voice not found.' }); return null; };
    if (!VOICE_ID_RE.test(id)) return miss();
    try {
      const v = await deps.intake.get(id);
      if (!v.owner_user_id || v.owner_user_id !== req.studioUserId) return miss();
      return v;
    } catch (e) {
      if (e instanceof IntakeError && (e.status === 404 || e.status === 400)) return miss();
      throw e;
    }
  }

  r.get('/enabled', (_req, res) => {
    res.json({
      enabled: true,
      consent_text_version: CONSENT_TEXT_VERSION,
      ...(deps.requireConsentStatement ? { consent_statement: CONSENT_STATEMENT } : {}),
      max_zip_bytes: deps.maxZipBytes,
      part_bytes: 8 * 1024 * 1024,
      max_voices: deps.maxVoicesPerUser,
    });
  });

  r.get('/', wrap(async (req, res) => {
    const { voices } = await deps.intake.list(req.studioUserId!);
    res.json({ voices: voices.map(publicVoice) });
  }));

  r.post('/', limiter(lim.create), express.json({ limit: '16kb' }), wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const speaker = clean(b.speaker_name, 100);
    const attestedBy = clean(b.attested_by, 100);
    if (speaker.length < 2 || attestedBy.length < 2) { res.status(400).json({ error: "Enter the speaker's full name and the name of the person confirming." }); return; }
    if (b.consent !== true) { res.status(400).json({ error: 'Consent must be confirmed.' }); return; }
    if (b.consent_text_version !== CONSENT_TEXT_VERSION) { res.status(400).json({ error: 'The consent wording was updated. Reload the page and confirm again.' }); return; }
    if (deps.requireConsentStatement && b.consent_statement !== CONSENT_STATEMENT) {
      res.status(400).json({ error: 'consent_statement must echo the exact consent text from GET /enabled.' });
      return;
    }
    const mine = await deps.intake.list(req.studioUserId!);
    const active = mine.voices.filter((v) => (v as { status?: string }).status !== 'rejected').length;
    if (active >= deps.maxVoicesPerUser) {
      res.status(429).json({ error: `You already have ${active} custom voices (limit ${deps.maxVoicesPerUser}). Delete one to create another.` });
      return;
    }
    const ip = clean(String(req.headers['x-forwarded-for'] ?? '').split(',')[0] || req.ip || '', 64);
    const ownerKeyIds = deps.ownerKeyIdsFor?.(req);
    const out = await deps.intake.create({
      owner_user_id: req.studioUserId,
      ...(ownerKeyIds && ownerKeyIds.length > 0 ? { owner_key_ids: ownerKeyIds } : {}),
      speaker_name: speaker,
      attested_by: attestedBy,
      consent: true,
      consent_text_version: CONSENT_TEXT_VERSION,
      client_ip: ip,
    });
    await deps.backfillKeyOwners(req.studioUserId!).catch((e) => deps.log?.warn({ e }, 'key owner backfill failed'));
    res.status(201).json({ id: out.voice_id });
  }));

  r.get('/:id', wrap(async (req, res) => {
    const v = await owned(req, res, req.params.id!);
    if (v) res.json(publicVoice(v));
  }));

  r.put('/:id/dataset/parts/:n', limiter(lim.parts), express.raw({ type: '*/*', limit: PART_BYTES_MAX }), wrap(async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTS) { res.status(400).json({ error: 'Bad part number.' }); return; }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) { res.status(400).json({ error: 'Empty part.' }); return; }
    const v = await owned(req, res, req.params.id!);
    if (!v) return;
    if (v.status !== 'created') { res.status(409).json({ error: 'Recordings were already uploaded for this voice.' }); return; }
    res.json(await deps.intake.putPart(req.params.id!, n, body));
  }));

  r.get('/:id/dataset/parts', wrap(async (req, res) => {
    if (!(await owned(req, res, req.params.id!))) return;
    res.json(await deps.intake.listParts(req.params.id!));
  }));

  r.post('/:id/dataset/commit', express.json({ limit: '4kb' }), wrap(async (req, res) => {
    const v = await owned(req, res, req.params.id!);
    if (!v) return;
    if (v.status !== 'created') { res.status(409).json({ error: 'Recordings were already uploaded for this voice.' }); return; }
    const parts = Number(req.body?.parts);
    if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) { res.status(400).json({ error: 'Bad part count.' }); return; }
    const have = (await deps.intake.listParts(req.params.id!)).parts;
    const total = have.filter((p) => p.part < parts).reduce((a, p) => a + p.bytes, 0);
    if (total > deps.maxZipBytes) { res.status(413).json({ error: `That upload is too large (limit ${Math.round(deps.maxZipBytes / 1048576)} MB). Use FLAC or MP3 files, or fewer recordings.` }); return; }
    const out = await deps.intake.commit(req.params.id!, parts, total);
    res.status(202).json({ id: out.voice_id, status: out.status, clips: out.clips });
  }));

  r.get('/:id/samples/:n', wrap(async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n > 4) { res.status(404).json({ error: 'No such sample.' }); return; }
    const v = await owned(req, res, req.params.id!);
    if (!v) return;
    if (v.status !== 'ready' && v.status !== 'deployed') { res.status(409).json({ error: 'The voice is not trained yet.' }); return; }
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(await deps.intake.sample(req.params.id!, n));
  }));

  r.post('/:id/preview', limiter(lim.preview), express.json({ limit: '4kb' }), wrap(async (req, res) => {
    const text = clean(req.body?.text, 400);
    if (!text || text.length > 300) { res.status(400).json({ error: 'Enter between 1 and 300 characters.' }); return; }
    const v = await owned(req, res, req.params.id!);
    if (!v) return;
    if (v.status !== 'ready' && v.status !== 'deployed') { res.status(409).json({ error: 'The voice is not trained yet.' }); return; }
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).send(await deps.intake.preview(req.params.id!, text));
  }));

  r.post('/:id/deploy', wrap(async (req, res) => {
    const v = await owned(req, res, req.params.id!);
    if (!v) return;
    if (v.status !== 'ready' && v.status !== 'deployed') { res.status(409).json({ error: 'The voice is not ready to go live yet.' }); return; }
    await deps.backfillKeyOwners(req.studioUserId!).catch((e) => deps.log?.warn({ e }, 'key owner backfill failed'));
    const out = await deps.intake.deploy(req.params.id!);
    res.json({ id: out.voice_id, voice: out.voice });
  }));

  r.delete('/:id', wrap(async (req, res) => {
    if (!(await owned(req, res, req.params.id!))) return;
    await deps.intake.remove(req.params.id!);
    res.json({ deleted: true });
  }));

  // Errors: never leak intake internals; pass through the few that are user-actionable.
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof IntakeError) {
      if ([400, 409, 413].includes(err.status)) { res.status(err.status).json({ error: err.detail }); return; }
      deps.log?.error({ status: err.status, detail: err.detail }, 'voice intake error');
      res.status(502).json({ error: 'The voice service is temporarily unavailable. Please try again.' });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') { res.status(413).json({ error: 'That part is too large.' }); return; }
    deps.log?.error({ err }, 'voice studio error');
    res.status(500).json({ error: 'Something went wrong.' });
  });
  return r;
}
