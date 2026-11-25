// POST /api/gateway/request-log: batch ingest of per-request API log events from the realtime-tts gateway.
//
// Trust model: same as the other gateway-to-backend routes (voiceStudioApiKey, voiceCloneApiKey): the gateway proves
// itself with `x-gateway-admin-secret` == GATEWAY_FORWARD_SECRET, compared in constant time (lib/sharedSecret.ts).
// Everything else (flag off, wrong or missing secret, wrong method) is a plain 404 "Not found", so the route does not
// exist for anyone who is not the gateway and nothing about it can be probed.
//
// Dark by default: REQUEST_LOG_INGEST_ENABLED must be set (after migration 037 is applied) or the route 404s.
// Mounted in index.ts BEFORE the global 1 MB express.json and before standardRateLimit (the gateway is one IP and
// would trip a per-IP limiter); this router parses its own body with a 256 KB cap, after the secret check.
//
// Metadata only: the validator (lib/requestLog.ts) refuses any event carrying a field outside the contract, so text,
// audio and raw keys cannot be stored even if the emitter sends them by mistake.
import express, { Router, type ErrorRequestHandler, type Request, type Response, type NextFunction } from 'express';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { secretMatches } from '../lib/sharedSecret.js';
import {
  MAX_BODY_BYTES, insertRequestLog, requestLogIngestEnabled, validateBatch, type RequestLogInsert,
} from '../lib/requestLog.js';

const log = logger.child({ module: 'request-log-ingest' });

export interface RequestLogIngestOpts {
  enabled?: () => boolean;
  secret?: () => string | undefined;
  insert?: RequestLogInsert;
  now?: () => Date;
  /** Only `error` is used; injectable so tests can see exactly what gets logged. */
  logger?: { error: (obj: Record<string, unknown>, msg: string) => void };
}

export function createRequestLogIngestRouter(opts: RequestLogIngestOpts = {}): Router {
  const enabled = opts.enabled ?? (() => requestLogIngestEnabled());
  const secret = opts.secret ?? (() => config.GATEWAY_FORWARD_SECRET);
  const insert = opts.insert ?? insertRequestLog;
  const now = opts.now ?? (() => new Date());
  const out = opts.logger ?? log;
  const router = Router();

  const notFound = (res: Response) => res.status(404).type('text/plain').send('Not found');

  // 1. Gate: flag, then secret, before any body is read. Every failure looks identical.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!enabled() || !secretMatches(req.headers['x-gateway-admin-secret'], secret())) { notFound(res); return; }
    next();
  });

  // 2. Ingest: own tight body limit (the gateway sends <= 200 small events per batch).
  router.post('/', express.json({ limit: MAX_BODY_BYTES }), async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const batch = validateBatch(req.body, now());
    if (!batch.ok) {
      res.status(batch.status).json({ error: batch.status === 413 ? 'too many events' : 'malformed body' });
      return;
    }
    try {
      await insert(batch.rows);
    } catch (err) {
      // Cause is logged (message only, never the rows) and never returned to the caller.
      out.error({ err: err instanceof Error ? err.message : String(err), events: batch.rows.length }, 'request log insert failed');
      res.status(500).json({ error: 'ingest failed' });
      return;
    }
    res.status(202).json({ accepted: batch.rows.length, rejected: batch.rejected });
  });

  // 3. Body-parser failures: oversize is 413, anything else malformed is 400. No detail echoed.
  const bodyErrors: ErrorRequestHandler = (err, _req, res, _next) => {
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.too.large') res.status(413).json({ error: 'payload too large' });
    else res.status(400).json({ error: 'malformed body' });
  };
  router.use(bodyErrors);

  // Anything but POST / (after the gate) also looks like nothing is here.
  router.all('*', (_req, res) => notFound(res));
  return router;
}

export const requestLogIngestRouter = createRequestLogIngestRouter();
