import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import {
  createClonedVoice,
  confirmClonedVoiceUpload,
  getUserClonedVoices,
  getClonedVoice,
  getClonedVoiceAudioUrl,
  updateClonedVoice,
  deleteClonedVoice,
} from '../lib/supabaseClient.js';
import type {
  ClonedVoiceInfo,
} from '../types/index.js';
import { NotFoundError, ValidationError } from '../types/index.js';

// ============================================================================
// Logger
// ============================================================================

const clonedVoicesLogger = logger.child({ module: 'cloned-voices' });

// ============================================================================
// Types
// ============================================================================

interface DeviceRequest extends Request {
  deviceId: string;
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

export const clonedVoicesRouter = Router();

// ============================================================================
// Device ID Middleware
// ============================================================================

// Extract device ID from header - required for all cloned voice operations
clonedVoicesRouter.use((req: Request, res: Response, next: NextFunction) => {
  const deviceId = req.headers['x-device-id'] as string | undefined;

  if (!deviceId || deviceId.trim().length === 0) {
    res.status(400).json({ error: 'X-Device-ID header is required' });
    return;
  }

  // Store device ID on request
  (req as DeviceRequest).deviceId = deviceId.trim();
  next();
});

// ============================================================================
// POST /cloned-voices - Create a new cloned voice
// ============================================================================

const createVoiceSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  exaggeration: z.number().min(0).max(1).optional(),
});

clonedVoicesRouter.post('/', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;

  // Validate request body
  const parseResult = createVoiceSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { name, description, exaggeration } = parseResult.data;

  clonedVoicesLogger.info({ userId, name }, 'Creating cloned voice');

  // Create the voice and get upload URL
  const { voice, uploadUrl, expiresAt } = await createClonedVoice({
    userId,
    name,
    description,
    exaggeration,
  });

  res.status(201).json({
    id: voice.id,
    name: voice.name,
    upload_url: uploadUrl,
    expires_at: expiresAt.toISOString(),
  });
}));

// ============================================================================
// POST /cloned-voices/:id/confirm - Confirm audio upload
// ============================================================================

const confirmUploadSchema = z.object({
  duration_sec: z.number().positive(),
  file_size_bytes: z.number().positive().int(),
});

clonedVoicesRouter.post('/:id/confirm', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;
  const voiceId = req.params.id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(voiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  // Validate request body
  const parseResult = confirmUploadSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { duration_sec, file_size_bytes } = parseResult.data;

  clonedVoicesLogger.info({ userId, voiceId, duration_sec }, 'Confirming voice upload');

  const voice = await confirmClonedVoiceUpload({
    voiceId: voiceId!,
    userId,
    durationSec: duration_sec,
    fileSizeBytes: file_size_bytes,
  });

  // Get a signed URL for the audio
  const audioUrl = await getClonedVoiceAudioUrl(voice.audio_path);

  const voiceInfo: ClonedVoiceInfo = {
    id: voice.id,
    name: voice.name,
    description: voice.description,
    duration_sec: voice.duration_sec,
    exaggeration: voice.exaggeration,
    is_default: voice.is_default,
    usage_count: voice.usage_count,
    created_at: voice.created_at,
    audio_url: audioUrl ?? undefined,
  };

  res.json(voiceInfo);
}));

// ============================================================================
// GET /cloned-voices - List user's cloned voices
// ============================================================================

clonedVoicesRouter.get('/', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;
  const includeAudioUrls = req.query.include_audio_urls === 'true';

  clonedVoicesLogger.debug({ userId, includeAudioUrls }, 'Fetching cloned voices');

  const voices = await getUserClonedVoices(userId);

  // Map to response format
  const voiceInfos: ClonedVoiceInfo[] = await Promise.all(
    voices.map(async (voice) => {
      const info: ClonedVoiceInfo = {
        id: voice.id,
        name: voice.name,
        description: voice.description,
        duration_sec: voice.duration_sec,
        exaggeration: voice.exaggeration,
        is_default: voice.is_default,
        usage_count: voice.usage_count,
        created_at: voice.created_at,
      };

      if (includeAudioUrls) {
        info.audio_url = (await getClonedVoiceAudioUrl(voice.audio_path)) ?? undefined;
      }

      return info;
    })
  );

  res.json({ voices: voiceInfos });
}));

// ============================================================================
// GET /cloned-voices/:id - Get a specific cloned voice
// ============================================================================

clonedVoicesRouter.get('/:id', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;
  const voiceId = req.params.id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(voiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  clonedVoicesLogger.debug({ userId, voiceId }, 'Fetching cloned voice');

  const voice = await getClonedVoice(voiceId!, userId);
  if (!voice) {
    throw new NotFoundError('Cloned voice');
  }

  // Get a signed URL for the audio
  const audioUrl = await getClonedVoiceAudioUrl(voice.audio_path);

  const voiceInfo: ClonedVoiceInfo = {
    id: voice.id,
    name: voice.name,
    description: voice.description,
    duration_sec: voice.duration_sec,
    exaggeration: voice.exaggeration,
    is_default: voice.is_default,
    usage_count: voice.usage_count,
    created_at: voice.created_at,
    audio_url: audioUrl ?? undefined,
  };

  res.json(voiceInfo);
}));

// ============================================================================
// PATCH /cloned-voices/:id - Update a cloned voice
// ============================================================================

const updateVoiceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  exaggeration: z.number().min(0).max(1).optional(),
  is_default: z.boolean().optional(),
});

clonedVoicesRouter.patch('/:id', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;
  const voiceId = req.params.id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(voiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  // Validate request body
  const parseResult = updateVoiceSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const updates = parseResult.data;

  if (Object.keys(updates).length === 0) {
    throw new ValidationError('No updates provided');
  }

  clonedVoicesLogger.info({ userId, voiceId, updates }, 'Updating cloned voice');

  const voice = await updateClonedVoice(voiceId!, userId, updates);

  // Get a signed URL for the audio
  const audioUrl = await getClonedVoiceAudioUrl(voice.audio_path);

  const voiceInfo: ClonedVoiceInfo = {
    id: voice.id,
    name: voice.name,
    description: voice.description,
    duration_sec: voice.duration_sec,
    exaggeration: voice.exaggeration,
    is_default: voice.is_default,
    usage_count: voice.usage_count,
    created_at: voice.created_at,
    audio_url: audioUrl ?? undefined,
  };

  res.json(voiceInfo);
}));

// ============================================================================
// DELETE /cloned-voices/:id - Delete a cloned voice
// ============================================================================

clonedVoicesRouter.delete('/:id', asyncHandler(async (req: DeviceRequest, res: Response) => {
  const userId = req.deviceId;
  const voiceId = req.params.id;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(voiceId ?? '')) {
    throw new ValidationError('Invalid voice ID format');
  }

  clonedVoicesLogger.info({ userId, voiceId }, 'Deleting cloned voice');

  // Check if voice exists
  const voice = await getClonedVoice(voiceId!, userId);
  if (!voice) {
    throw new NotFoundError('Cloned voice');
  }

  await deleteClonedVoice(voiceId!, userId);

  res.status(204).send();
}));
