/**
 * Safety net for 5xx responses nobody reported: many handlers catch their own error and answer 5xx directly (STT 502,
 * Stripe webhook 500, ...) instead of calling next(err), so the central errorHandler never sees them.
 * The errorHandler marks res.locals.failureReported; anything else that finishes >= 500 is reported here once, with a
 * route TEMPLATE (never the concrete path: ids, tokens) so the hourly dedupe collapses a burst into one email.
 */
import type { Request, Response, NextFunction } from 'express';
import { reportFailure } from './failureReporter.js';
import { classError, type ReportFn } from './jobFailureSignal.js';

const SKIP = /^\/(health|api\/health)/; // probed from outside already

export function routeLabel(req: Pick<Request, 'method' | 'baseUrl' | 'route' | 'path'>): string {
  const tpl = (req.route && typeof req.route.path === 'string') ? req.route.path : '';
  return `${req.method} ${(req.baseUrl ?? '') + tpl || 'unmatched'}`;
}

export function serverErrorNet(report: ReportFn = reportFailure) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      try {
        if (res.statusCode < 500 || res.locals?.failureReported) return;
        if (SKIP.test(req.originalUrl ?? req.url ?? '')) return;
        res.locals.failureReported = true;
        report('http_5xx', classError(`HTTP_${res.statusCode}`), { route: routeLabel(req), status: String(res.statusCode) });
      } catch { /* never break a response */ }
    });
    next();
  };
}
