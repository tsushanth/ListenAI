import type { Request, Response, NextFunction } from 'express';
import { requestLanguage, resolveErrorCode } from '../lib/errorCodes.js';

/**
 * Safety net so EVERY client-facing 4xx/5xx JSON body carries a stable `code`, including the many
 * handlers that answer with res.status(n).json({ error: '...' }) themselves instead of calling next(err).
 * Bodies that already have a `code` (the central errorHandler sets one) are left alone. The English
 * `error` / `message` stay exactly as they were for old clients. The language the client asked for (Accept-Language)
 * is parsed once into res.locals.lang so handlers and logs can use it.
 */
export function errorCodeNet() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const lang = requestLanguage(req);
    res.locals.lang = lang;
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
        const b = body as Record<string, unknown>;
        if (typeof b.code !== 'string') {
          const text = typeof b.message === 'string' ? b.message : b.error;
          body = { ...b, code: resolveErrorCode(res.statusCode, text) };
        }
        // The text is English; a client that wants its own language translates `code`.
        if (!res.getHeader('Content-Language')) res.setHeader('Content-Language', 'en');
      }
      return json(body);
    }) as Response['json'];
    next();
  };
}
