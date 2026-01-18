import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import {
  recordLatencyMetric,
  getLatencyEstimate,
  getAllLatencyCache,
  aggregateLatencyMetrics,
} from '../lib/supabaseClient.js';
import type { AuthenticatedRequest, TTSProvider } from '../types/index.js';
import { ValidationError } from '../types/index.js';

// ============================================================================
// Async Handler Wrapper
// ============================================================================

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as AuthenticatedRequest, res, next)).catch(next);
  };
}

// ============================================================================
// Router
// ============================================================================

export const latencyRouter = Router();

// ============================================================================
// POST /latency/report - Record a latency metric from iOS client
// ============================================================================

const reportSchema = z.object({
  text_length: z.number().int().positive(),
  latency_ms: z.number().int().positive(),
  provider: z.enum(['selfhosted', 'mock']).default('selfhosted'),
  voice_id: z.string().max(100).optional(),
});

latencyRouter.post('/report', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const parseResult = reportSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { text_length, latency_ms, provider, voice_id } = parseResult.data;
  const userId = req.user?.id ?? null;

  await recordLatencyMetric({
    user_id: userId,
    text_length,
    latency_ms,
    provider: provider as TTSProvider,
    voice_id: voice_id ?? null,
  });

  res.json({ success: true });
}));

// ============================================================================
// GET /latency/estimate - Get estimated processing time for a text length
// ============================================================================

const estimateSchema = z.object({
  text_length: z.coerce.number().int().positive(),
});

latencyRouter.get('/estimate', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const parseResult = estimateSchema.safeParse(req.query);
  if (!parseResult.success) {
    throw new ValidationError('text_length query param required');
  }

  const { text_length } = parseResult.data;
  const estimate = await getLatencyEstimate(text_length);

  res.json(estimate);
}));

// ============================================================================
// GET /latency/cache - Get all cached latency data (for debugging)
// ============================================================================

latencyRouter.get('/cache', asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
  const cache = await getAllLatencyCache();
  res.json({ buckets: cache });
}));

// ============================================================================
// POST /latency/aggregate - Trigger manual aggregation (admin only)
// ============================================================================

latencyRouter.post('/aggregate', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  // Simple admin check - in production you'd want proper admin auth
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_API_KEY && process.env.NODE_ENV === 'production') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  await aggregateLatencyMetrics();
  res.json({ success: true, message: 'Aggregation completed' });
}));
