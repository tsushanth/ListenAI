import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabaseClient.js';
import { NotFoundError, ValidationError, AuthorizationError } from '../types/index.js';

// ============================================================================
// Logger
// ============================================================================

const marketplaceLogger = logger.child({ module: 'voice-marketplace' });

// ============================================================================
// Types
// ============================================================================

interface DeviceRequest extends Request {
  deviceId: string;
}

interface SharedVoice {
  id: string;
  display_name: string;
  description: string | null;
  tags: string[];
  preview_audio_url: string | null;
  preview_duration_sec: number | null;
  usage_count: number;
  avg_rating: number;
  rating_count: number;
  owner_user_id: string;
  created_at: string;
}

interface VoiceReport {
  id: string;
  shared_voice_id: string;
  reporter_user_id: string;
  reason: string;
  description: string;
  status: string;
  created_at: string;
}

// ============================================================================
// Async Handler Wrapper
// ============================================================================

function asyncHandler(
  fn: (req: DeviceRequest, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as DeviceRequest, res, next)).catch(next);
  };
}

// ============================================================================
// Router
// ============================================================================

export const voiceMarketplaceRouter = Router();

// ============================================================================
// Device ID Middleware
// ============================================================================

voiceMarketplaceRouter.use((req: Request, res: Response, next: NextFunction) => {
  const deviceId = req.headers['x-device-id'] as string | undefined;

  if (!deviceId || deviceId.trim().length === 0) {
    res.status(400).json({ error: 'X-Device-ID header is required' });
    return;
  }

  (req as DeviceRequest).deviceId = deviceId.trim();
  next();
});

// ============================================================================
// GET /marketplace - Browse shared voices
// ============================================================================

const browseSchema = z.object({
  tags: z.string().optional(), // Comma-separated tags
  search: z.string().optional(),
  sort: z.enum(['popular', 'newest', 'rating']).optional().default('popular'),
  limit: z.coerce.number().min(1).max(50).optional().default(20),
  offset: z.coerce.number().min(0).optional().default(0),
});

voiceMarketplaceRouter.get('/', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const parseResult = browseSchema.safeParse(req.query);
  if (!parseResult.success) {
    throw new ValidationError('Invalid query parameters', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { tags, search, sort, limit, offset } = parseResult.data;

  // Parse tags if provided
  const tagsArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : null;

  marketplaceLogger.debug({ tags: tagsArray, search, sort, limit, offset }, 'Browsing marketplace');

  // Use the database function for efficient querying
  const { data, error } = await supabase.rpc('get_marketplace_voices', {
    p_tags: tagsArray,
    p_search: search || null,
    p_sort_by: sort,
    p_limit: limit,
    p_offset: offset,
  });

  if (error) {
    marketplaceLogger.error({ error }, 'Failed to browse marketplace');
    throw error;
  }

  const voices: SharedVoice[] = (data ?? []).map((v: Record<string, unknown>) => ({
    id: v.id as string,
    display_name: v.display_name as string,
    description: v.description as string | null,
    tags: v.tags as string[],
    preview_audio_url: v.preview_audio_url as string | null,
    preview_duration_sec: v.preview_duration_sec as number | null,
    usage_count: v.usage_count as number,
    avg_rating: Number(v.avg_rating) || 0,
    rating_count: v.rating_count as number,
    owner_user_id: v.owner_user_id as string,
    created_at: v.created_at as string,
    is_own: v.owner_user_id === req.deviceId,
  }));

  res.json({ voices, limit, offset });
}));

// ============================================================================
// GET /marketplace/:id - Get single shared voice details
// ============================================================================

voiceMarketplaceRouter.get('/:id', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const voiceId = req.params.id;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(voiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  const { data, error } = await supabase
    .from('shared_voices')
    .select(`
      *,
      cloned_voices (
        name,
        audio_path
      )
    `)
    .eq('id', voiceId)
    .eq('status', 'active')
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      throw new NotFoundError('Shared voice');
    }
    throw error;
  }

  res.json({
    id: data.id,
    display_name: data.display_name,
    description: data.description,
    tags: data.tags,
    preview_audio_url: data.preview_audio_url,
    preview_duration_sec: data.preview_duration_sec,
    usage_count: data.usage_count,
    avg_rating: data.rating_count > 0 ? data.rating_sum / data.rating_count : 0,
    rating_count: data.rating_count,
    owner_user_id: data.owner_user_id,
    created_at: data.created_at,
    is_own: data.owner_user_id === req.deviceId,
    cloned_voice_id: data.cloned_voice_id,
  });
}));

// ============================================================================
// POST /marketplace/share - Share a cloned voice to marketplace
// ============================================================================

const shareVoiceSchema = z.object({
  cloned_voice_id: z.string().uuid(),
  display_name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().max(30)).max(10).optional().default([]),
  owner_attestation: z.string().min(10).max(500),
  terms_accepted: z.boolean().refine(val => val === true, {
    message: 'You must accept the terms to share your voice',
  }),
});

voiceMarketplaceRouter.post('/share', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;

  const parseResult = shareVoiceSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { cloned_voice_id, display_name, description, tags, owner_attestation } = parseResult.data;

  // Verify the cloned voice belongs to this user
  const { data: clonedVoice, error: voiceError } = await supabase
    .from('cloned_voices')
    .select('id, audio_path, duration_sec')
    .eq('id', cloned_voice_id)
    .eq('user_id', userId)
    .eq('is_active', true)
    .single();

  if (voiceError || !clonedVoice) {
    throw new NotFoundError('Cloned voice');
  }

  // Check if already shared
  const { data: existingShare } = await supabase
    .from('shared_voices')
    .select('id, status')
    .eq('cloned_voice_id', cloned_voice_id)
    .in('status', ['active', 'pending_review'])
    .single();

  if (existingShare) {
    throw new ValidationError('This voice is already shared to the marketplace');
  }

  // Create preview audio URL from the cloned voice audio
  const { data: previewUrl } = await supabase.storage
    .from('cloned-voices')
    .createSignedUrl(clonedVoice.audio_path, 86400 * 365); // 1 year

  // Create the shared voice record
  const { data: sharedVoice, error: insertError } = await supabase
    .from('shared_voices')
    .insert({
      owner_user_id: userId,
      cloned_voice_id,
      display_name,
      description,
      tags,
      preview_audio_path: clonedVoice.audio_path,
      preview_audio_url: previewUrl?.signedUrl,
      preview_duration_sec: clonedVoice.duration_sec,
      terms_accepted_at: new Date().toISOString(),
      owner_attestation,
      status: 'active', // Can be 'pending_review' if moderation is needed
    })
    .select()
    .single();

  if (insertError) {
    marketplaceLogger.error({ error: insertError, userId, cloned_voice_id }, 'Failed to share voice');
    throw insertError;
  }

  marketplaceLogger.info({ sharedVoiceId: sharedVoice.id, userId, display_name }, 'Voice shared to marketplace');

  res.status(201).json({
    id: sharedVoice.id,
    display_name: sharedVoice.display_name,
    status: sharedVoice.status,
    created_at: sharedVoice.created_at,
  });
}));

// ============================================================================
// DELETE /marketplace/:id - Revoke (unshare) a voice from marketplace
// ============================================================================

voiceMarketplaceRouter.delete('/:id', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;
  const sharedVoiceId = req.params.id;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sharedVoiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  // Verify ownership
  const { data: sharedVoice } = await supabase
    .from('shared_voices')
    .select('id, owner_user_id, status')
    .eq('id', sharedVoiceId)
    .single();

  if (!sharedVoice) {
    throw new NotFoundError('Shared voice');
  }

  if (sharedVoice.owner_user_id !== userId) {
    throw new AuthorizationError('You can only revoke your own shared voices');
  }

  if (sharedVoice.status === 'revoked') {
    throw new ValidationError('Voice is already revoked');
  }

  // Revoke using the database function
  const { data: success, error } = await supabase.rpc('revoke_shared_voice', {
    p_shared_voice_id: sharedVoiceId,
    p_reason: 'Owner revoked',
    p_revoked_by: 'owner',
  });

  if (error) {
    marketplaceLogger.error({ error, sharedVoiceId }, 'Failed to revoke voice');
    throw error;
  }

  marketplaceLogger.info({ sharedVoiceId, userId }, 'Voice revoked from marketplace');

  res.status(204).send();
}));

// ============================================================================
// POST /marketplace/:id/report - Report a shared voice
// ============================================================================

const reportVoiceSchema = z.object({
  reason: z.enum(['not_their_voice', 'celebrity', 'public_figure', 'offensive', 'copyright', 'other']),
  description: z.string().min(10).max(1000),
  evidence_urls: z.array(z.string().url()).max(5).optional().default([]),
});

voiceMarketplaceRouter.post('/:id/report', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;
  const sharedVoiceId = req.params.id;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sharedVoiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  const parseResult = reportVoiceSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { reason, description, evidence_urls } = parseResult.data;

  // Verify the shared voice exists and is active
  const { data: sharedVoice } = await supabase
    .from('shared_voices')
    .select('id, owner_user_id, status')
    .eq('id', sharedVoiceId)
    .eq('status', 'active')
    .single();

  if (!sharedVoice) {
    throw new NotFoundError('Shared voice');
  }

  // Can't report your own voice
  if (sharedVoice.owner_user_id === userId) {
    throw new ValidationError('You cannot report your own voice');
  }

  // Check for existing pending report from this user
  const { data: existingReport } = await supabase
    .from('voice_reports')
    .select('id')
    .eq('shared_voice_id', sharedVoiceId)
    .eq('reporter_user_id', userId)
    .in('status', ['pending', 'ai_reviewed'])
    .single();

  if (existingReport) {
    throw new ValidationError('You have already reported this voice');
  }

  // Create the report
  const { data: report, error: insertError } = await supabase
    .from('voice_reports')
    .insert({
      shared_voice_id: sharedVoiceId,
      reporter_user_id: userId,
      reason,
      description,
      evidence_urls,
      status: 'pending',
    })
    .select()
    .single();

  if (insertError) {
    marketplaceLogger.error({ error: insertError, sharedVoiceId, userId }, 'Failed to create report');
    throw insertError;
  }

  marketplaceLogger.info({ reportId: report.id, sharedVoiceId, userId, reason }, 'Voice report created');

  // TODO: Trigger AI analysis asynchronously
  // This could be done via a Pub/Sub message or a background job
  // For now, we'll leave it as pending for manual review or batch AI processing

  res.status(201).json({
    id: report.id,
    status: report.status,
    message: 'Report submitted successfully. We will review it shortly.',
  });
}));

// ============================================================================
// POST /marketplace/:id/rate - Rate a shared voice
// ============================================================================

const rateVoiceSchema = z.object({
  rating: z.number().int().min(1).max(5),
  review: z.string().max(500).optional(),
});

voiceMarketplaceRouter.post('/:id/rate', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;
  const sharedVoiceId = req.params.id;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sharedVoiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  const parseResult = rateVoiceSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { rating, review } = parseResult.data;

  // Verify the shared voice exists and is active
  const { data: sharedVoice } = await supabase
    .from('shared_voices')
    .select('id, owner_user_id, status')
    .eq('id', sharedVoiceId)
    .eq('status', 'active')
    .single();

  if (!sharedVoice) {
    throw new NotFoundError('Shared voice');
  }

  // Can't rate your own voice
  if (sharedVoice.owner_user_id === userId) {
    throw new ValidationError('You cannot rate your own voice');
  }

  // Upsert the rating (update if exists, insert if not)
  const { data: ratingRecord, error: upsertError } = await supabase
    .from('voice_ratings')
    .upsert({
      shared_voice_id: sharedVoiceId,
      user_id: userId,
      rating,
      review,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'shared_voice_id,user_id',
    })
    .select()
    .single();

  if (upsertError) {
    marketplaceLogger.error({ error: upsertError, sharedVoiceId, userId }, 'Failed to rate voice');
    throw upsertError;
  }

  marketplaceLogger.info({ sharedVoiceId, userId, rating }, 'Voice rated');

  res.json({
    id: ratingRecord.id,
    rating: ratingRecord.rating,
    review: ratingRecord.review,
    created_at: ratingRecord.created_at,
  });
}));

// ============================================================================
// GET /marketplace/my-shares - Get user's shared voices
// ============================================================================

voiceMarketplaceRouter.get('/my/shares', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;

  const { data, error } = await supabase
    .from('shared_voices')
    .select('*')
    .eq('owner_user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    marketplaceLogger.error({ error, userId }, 'Failed to get user shares');
    throw error;
  }

  const shares = (data ?? []).map(v => ({
    id: v.id,
    display_name: v.display_name,
    description: v.description,
    tags: v.tags,
    status: v.status,
    usage_count: v.usage_count,
    avg_rating: v.rating_count > 0 ? v.rating_sum / v.rating_count : 0,
    rating_count: v.rating_count,
    created_at: v.created_at,
    revoked_at: v.revoked_at,
    revoked_reason: v.revoked_reason,
  }));

  res.json({ shares });
}));

// ============================================================================
// GET /marketplace/my/rewards - Get user's pending and total rewards
// ============================================================================

voiceMarketplaceRouter.get('/my/rewards', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;

  // Get pending rewards
  const { data: pending, error: pendingError } = await supabase.rpc('get_pending_rewards', {
    p_user_id: userId,
  });

  if (pendingError) {
    marketplaceLogger.error({ error: pendingError, userId }, 'Failed to get pending rewards');
    throw pendingError;
  }

  const pendingResult = Array.isArray(pending) ? pending[0] : pending;

  // Get total credited rewards
  const { data: credited, error: creditedError } = await supabase
    .from('voice_creator_rewards')
    .select('reward_minutes')
    .eq('owner_user_id', userId)
    .eq('credited', true);

  if (creditedError) {
    marketplaceLogger.error({ error: creditedError, userId }, 'Failed to get credited rewards');
    throw creditedError;
  }

  const totalCredited = (credited ?? []).reduce((sum, r) => sum + Number(r.reward_minutes), 0);

  res.json({
    pending: {
      minutes: Number(pendingResult?.total_pending_minutes ?? 0),
      count: Number(pendingResult?.reward_count ?? 0),
    },
    credited: {
      total_minutes: totalCredited,
    },
  });
}));

// ============================================================================
// POST /marketplace/my/rewards/credit - Credit pending rewards to user
// ============================================================================

voiceMarketplaceRouter.post('/my/rewards/credit', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;

  const { data: creditedMinutes, error } = await supabase.rpc('credit_pending_rewards', {
    p_user_id: userId,
  });

  if (error) {
    marketplaceLogger.error({ error, userId }, 'Failed to credit rewards');
    throw error;
  }

  const minutes = Number(creditedMinutes ?? 0);

  marketplaceLogger.info({ userId, creditedMinutes: minutes }, 'Rewards credited');

  res.json({
    credited_minutes: minutes,
    message: minutes > 0
      ? `${minutes.toFixed(2)} minutes credited to your account`
      : 'No pending rewards to credit',
  });
}));

// ============================================================================
// GET /marketplace/my/rewards/history - Get reward history
// ============================================================================

voiceMarketplaceRouter.get('/my/rewards/history', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Number(req.query.offset) || 0;

  const { data, error } = await supabase
    .from('voice_creator_rewards')
    .select(`
      id,
      shared_voice_id,
      used_by_user_id,
      characters_generated,
      seconds_generated,
      reward_minutes,
      credited,
      credited_at,
      created_at,
      shared_voices (
        display_name
      )
    `)
    .eq('owner_user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    marketplaceLogger.error({ error, userId }, 'Failed to get reward history');
    throw error;
  }

  const history = (data ?? []).map(r => ({
    id: r.id,
    shared_voice_id: r.shared_voice_id,
    voice_name: (r.shared_voices as unknown as { display_name: string } | null)?.display_name ?? 'Unknown',
    characters_generated: r.characters_generated,
    seconds_generated: r.seconds_generated,
    reward_minutes: r.reward_minutes,
    credited: r.credited,
    credited_at: r.credited_at,
    created_at: r.created_at,
  }));

  res.json({ history, limit, offset });
}));

// ============================================================================
// POST /marketplace/:id/use - Record usage of a shared voice (internal)
// Called by the TTS service when a shared voice is used
// ============================================================================

const recordUsageSchema = z.object({
  user_id: z.string().min(1), // User who is using the voice
  characters: z.number().int().positive(),
  seconds: z.number().positive(),
  job_id: z.string().uuid().optional(),
});

voiceMarketplaceRouter.post('/:id/use', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const sharedVoiceId = req.params.id;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sharedVoiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  const parseResult = recordUsageSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { user_id, characters, seconds, job_id } = parseResult.data;

  // Record the usage and create reward
  const { data: rewardId, error } = await supabase.rpc('record_shared_voice_usage', {
    p_shared_voice_id: sharedVoiceId,
    p_used_by_user_id: user_id,
    p_characters: characters,
    p_seconds: seconds,
    p_job_id: job_id ?? null,
  });

  if (error) {
    marketplaceLogger.error({ error, sharedVoiceId, user_id }, 'Failed to record usage');
    throw error;
  }

  marketplaceLogger.info({ sharedVoiceId, user_id, characters, seconds, rewardId }, 'Usage recorded');

  res.json({
    success: true,
    reward_created: rewardId !== null,
  });
}));
