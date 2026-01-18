import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  uploadAudio,
  getAudioDownloadURL,
  audioExists,
  deleteAudio,
} from '../lib/supabaseClient.js';

// ============================================================================
// Audio Storage Router
// ============================================================================

export const audioRouter = Router();

/**
 * POST /api/audio/upload
 * Upload synthesized audio for an article.
 * Body: multipart/form-data with audio file and articleId
 */
audioRouter.post('/upload', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user.id;
    const { articleId } = req.body;

    if (!articleId) {
      res.status(400).json({ error: 'articleId is required' });
      return;
    }

    // Get audio data from request body (base64 encoded)
    const { audioData, mimeType } = req.body;

    if (!audioData) {
      res.status(400).json({ error: 'audioData is required' });
      return;
    }

    const audioBuffer = Buffer.from(audioData, 'base64');
    const filePath = await uploadAudio(userId, articleId, audioBuffer, mimeType || 'audio/mpeg');

    logger.info({ userId, articleId, filePath }, 'Audio uploaded');

    res.json({
      success: true,
      filePath,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to upload audio');
    res.status(500).json({ error: 'Failed to upload audio' });
  }
});

/**
 * GET /api/audio/:articleId
 * Get a download URL for an article's audio.
 */
audioRouter.get('/:articleId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user.id;
    const articleId = req.params.articleId;

    if (!articleId) {
      res.status(400).json({ error: 'articleId is required' });
      return;
    }

    // Check if audio exists and get extension
    const result = await audioExists(userId, articleId);

    if (!result.exists || !result.extension) {
      res.status(404).json({ error: 'Audio not found' });
      return;
    }

    // Get signed download URL
    const downloadURL = await getAudioDownloadURL(userId, articleId, result.extension);

    if (!downloadURL) {
      res.status(404).json({ error: 'Failed to generate download URL' });
      return;
    }

    res.json({
      downloadURL,
      extension: result.extension,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get audio download URL');
    res.status(500).json({ error: 'Failed to get audio URL' });
  }
});

/**
 * GET /api/audio/:articleId/exists
 * Check if audio exists in storage for an article.
 */
audioRouter.get('/:articleId/exists', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user.id;
    const articleId = req.params.articleId;

    if (!articleId) {
      res.status(400).json({ error: 'articleId is required' });
      return;
    }

    const result = await audioExists(userId, articleId);

    res.json({ exists: result.exists, extension: result.extension });
  } catch (error) {
    logger.error({ error }, 'Failed to check audio existence');
    res.status(500).json({ error: 'Failed to check audio' });
  }
});

/**
 * DELETE /api/audio/:articleId
 * Delete audio for an article.
 */
audioRouter.delete('/:articleId', requireAuth, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user.id;
    const articleId = req.params.articleId;

    if (!articleId) {
      res.status(400).json({ error: 'articleId is required' });
      return;
    }

    await deleteAudio(userId, articleId);

    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to delete audio');
    res.status(500).json({ error: 'Failed to delete audio' });
  }
});
