import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { voicesLogger } from '../lib/logger.js';
import { getVoices, getVoice, getUserTier } from '../lib/supabaseClient.js';
import { hasRequiredTier } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import type {
  AuthenticatedRequest,
  VoicesResponse,
  VoiceInfo,
  VoiceDetailResponse,
  VoiceListItem,
  SubscriptionTier,
} from '../types/index.js';
import { NotFoundError, ValidationError } from '../types/index.js';

// ============================================================================
// Async Handler Wrappers
// ============================================================================

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as AuthenticatedRequest, res, next)).catch(next);
  };
}

function publicAsyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ============================================================================
// Router
// ============================================================================

export const voicesRouter = Router();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a voice is available to a user based on their tier.
 */
function isVoiceAvailable(voiceTier: SubscriptionTier, userTier: SubscriptionTier): boolean {
  return hasRequiredTier(userTier, voiceTier);
}

// ============================================================================
// GET /voices - List all available voices (PUBLIC - no auth required)
// ============================================================================

voicesRouter.get('/', publicAsyncHandler(async (_req: Request, res: Response) => {
  voicesLogger.debug('Fetching voices (public)');

  // Get all active voices from database
  const voices = await getVoices();

  // Map to simplified response format
  const voiceList: VoiceListItem[] = voices.map((voice) => ({
    id: voice.id,
    name: voice.name,
    is_premium: voice.is_premium,
    hint: voice.style, // Use style as the hint (e.g., "Santa Storyteller")
  }));

  res.json({
    voices: voiceList,
  });
}));

// ============================================================================
// GET /voices/full - List all voices with full details (requires auth)
// ============================================================================

const listVoicesQuerySchema = z.object({
  category: z.string().optional(),
  tier: z.enum(['free', 'basic', 'pro', 'unlimited']).optional(),
});

voicesRouter.get('/full', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  // Validate query params
  const parseResult = listVoicesQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    throw new ValidationError('Invalid query parameters');
  }

  const { category, tier } = parseResult.data;

  voicesLogger.debug({ userId, category, tier }, 'Fetching voices (full)');

  // Get user's tier
  const userTier = await getUserTier(userId);

  // Get voices with optional filters
  const voices = await getVoices({ category, tier });

  // Map to response format
  const voiceInfos: VoiceInfo[] = voices.map((voice) => ({
    id: voice.id,
    name: voice.name,
    description: voice.description,
    provider: voice.provider,
    category: voice.category,
    style: voice.style,
    language: voice.language,
    gender: voice.gender,
    tier_required: voice.tier_required,
    is_premium: voice.is_premium,
    sample_audio_url: voice.sample_audio_url,
    is_available: isVoiceAvailable(voice.tier_required, userTier),
  }));

  const response: VoicesResponse = {
    voices: voiceInfos,
    user_tier: userTier,
  };

  res.json(response);
}));

// ============================================================================
// GET /voices/categories - List all voice categories
// ============================================================================

voicesRouter.get('/categories', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  voicesLogger.debug({ userId: req.user.id }, 'Fetching voice categories');

  // Get all voices to extract unique categories
  const voices = await getVoices();

  const categoryMap = new Map<string, { count: number; hasFreeTier: boolean }>();

  for (const voice of voices) {
    const existing = categoryMap.get(voice.category);
    if (existing) {
      existing.count++;
      if (voice.tier_required === 'free') {
        existing.hasFreeTier = true;
      }
    } else {
      categoryMap.set(voice.category, {
        count: 1,
        hasFreeTier: voice.tier_required === 'free',
      });
    }
  }

  const categories = Array.from(categoryMap.entries()).map(([name, data]) => ({
    name,
    display_name: name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' '),
    voice_count: data.count,
    has_free_voices: data.hasFreeTier,
  }));

  res.json({ categories });
}));

// ============================================================================
// GET /voices/:id - Get details for a specific voice
// ============================================================================

voicesRouter.get('/:id', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const voiceId = req.params.id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(voiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  voicesLogger.debug({ userId, voiceId }, 'Fetching voice details');

  const voice = await getVoice(voiceId!);
  if (!voice) {
    throw new NotFoundError('Voice');
  }

  const userTier = await getUserTier(userId);

  const response: VoiceDetailResponse = {
    id: voice.id,
    name: voice.name,
    description: voice.description,
    provider: voice.provider,
    provider_voice_id: voice.provider_voice_id,
    provider_model_id: voice.provider_model_id,
    category: voice.category,
    style: voice.style,
    language: voice.language,
    gender: voice.gender,
    tier_required: voice.tier_required,
    is_premium: voice.is_premium,
    sample_audio_url: voice.sample_audio_url,
    sample_text: voice.sample_text,
    is_available: isVoiceAvailable(voice.tier_required, userTier),
    supported_languages: [voice.language], // Could be expanded in DB
    settings: voice.settings,
  };

  res.json(response);
}));

// ============================================================================
// GET /voices/recommended - Get recommended voices for user
// ============================================================================

voicesRouter.get('/recommended', requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  voicesLogger.debug({ userId }, 'Fetching recommended voices');

  const userTier = await getUserTier(userId);
  const allVoices = await getVoices();

  // Simple recommendation logic:
  // 1. Prioritize voices available to the user
  // 2. Prioritize by sort_order
  // 3. Include a mix of categories
  const available = allVoices.filter((v) => isVoiceAvailable(v.tier_required, userTier));
  const unavailable = allVoices.filter((v) => !isVoiceAvailable(v.tier_required, userTier));

  // Get one from each category if available
  const seenCategories = new Set<string>();
  const recommended: VoiceInfo[] = [];

  for (const voice of [...available, ...unavailable]) {
    if (!seenCategories.has(voice.category) && recommended.length < 6) {
      seenCategories.add(voice.category);
      recommended.push({
        id: voice.id,
        name: voice.name,
        description: voice.description,
        provider: voice.provider,
        category: voice.category,
        style: voice.style,
        language: voice.language,
        gender: voice.gender,
        tier_required: voice.tier_required,
        is_premium: voice.is_premium,
        sample_audio_url: voice.sample_audio_url,
        is_available: isVoiceAvailable(voice.tier_required, userTier),
      });
    }
  }

  res.json({
    recommended,
    user_tier: userTier,
  });
}));
