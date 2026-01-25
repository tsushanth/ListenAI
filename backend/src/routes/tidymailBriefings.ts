/**
 * TidyMail Email Briefings Route
 * Generates two-host podcast-style briefings from email content
 */

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { config, CHARS_PER_SECOND } from '../lib/config.js';
import {
  canSynthesizeV2,
  createTTSJob,
  getTTSJob,
  uploadAudioToCache,
  getSignedAudioUrl,
  getCachedAudio,
  logTTSUsage,
} from '../lib/supabaseClient.js';
import { computeCacheKey } from '../lib/cacheKey.js';
import { callTTSProvider } from '../lib/ttsProviderClient.js';
import type { AuthenticatedRequest } from '../types/index.js';
import OpenAI from 'openai';

const briefingsLogger = logger.child({ module: 'tidymail-briefings' });

// ============================================================================
// Helper Functions
// ============================================================================

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as AuthenticatedRequest, res)).catch(next);
  };
}

// ============================================================================
// Two-Host Podcast Prompt (adapted from AI-Radio)
// ============================================================================

const BRIEFING_SYSTEM_PROMPT = `You are a professional podcast script writer specializing in email briefings. Create an engaging, natural conversation between two hosts about the user's emails.

HOST PERSONALITIES:
- Host 1 (Alex): Upbeat, energetic, and enthusiastic. Uses casual language and brings excitement to the conversation.
- Host 2 (Jordan): More analytical and thoughtful. Provides context and deeper insights. Balances Alex's energy with calm, clear explanations.

CONVERSATION GUIDELINES:
1. Natural Banter: The hosts should interact naturally, with back-and-forth dialogue
2. Concise Summaries: Summarize key points conversationally, don't read entire emails
3. Engaging Transitions: Use smooth transitions between topics
4. Personal Touch: Address the listener directly occasionally
5. Target Duration: Aim for approximately 2-3 minutes (~350-500 words total)

CONTENT STRUCTURE:
1. INTRO (10-15 seconds): Warm greeting, brief overview of what's coming
2. EMAIL HIGHLIGHTS (90-120 seconds): Summarize important emails, group by theme
3. OUTRO (10-15 seconds): Quick recap or motivational note, warm sign-off

FORMAT YOUR RESPONSE as a JSON array of segments:
[
  {
    "speaker": "host1",
    "text": "Hey there! Let's catch you up on your inbox...",
    "type": "intro"
  },
  {
    "speaker": "host2",
    "text": "Good idea! You've got some interesting stuff today...",
    "type": "intro"
  },
  ...
]

Valid "type" values: "intro", "email", "outro"
Each segment should be 1-3 sentences.`;

function generateBriefingPrompt(
  emails: Array<{ from: string; subject: string; summary: string; isImportant?: boolean }>,
  userName?: string,
  timeOfDay?: string
): string {
  const greeting = timeOfDay === 'morning' ? 'morning' : timeOfDay === 'evening' ? 'evening' : 'afternoon';

  let prompt = `Create a ${greeting} email briefing podcast for ${userName || 'the listener'}.

EMAILS TO COVER (${emails.length} total):
`;

  emails.forEach((email, i) => {
    const important = email.isImportant ? '[IMPORTANT] ' : '';
    prompt += `${i + 1}. ${important}From: ${email.from}
   Subject: ${email.subject}
   Summary: ${email.summary}
`;
  });

  prompt += `
Create an engaging conversation between Alex (energetic) and Jordan (analytical). Keep it natural, concise, and around 2-3 minutes total. Return ONLY valid JSON.`;

  return prompt;
}

// ============================================================================
// Request Schemas
// ============================================================================

const generateBriefingSchema = z.object({
  emails: z.array(z.object({
    from: z.string(),
    subject: z.string(),
    summary: z.string(),
    isImportant: z.boolean().optional(),
  })).min(1).max(20),
  user_name: z.string().optional(),
  time_of_day: z.enum(['morning', 'afternoon', 'evening']).optional(),
  voice_host1: z.string().optional().default('nova'),  // Energetic voice
  voice_host2: z.string().optional().default('onyx'),  // Calm voice
});

const synthesizeEmailSchema = z.object({
  thread_id: z.string(),
  account_id: z.string(),
  text: z.string().min(1).max(100000),
  voice_id: z.string().optional().default('nova'),
  speed: z.number().min(0.5).max(2.0).optional().default(1.0),
});

// ============================================================================
// Router
// ============================================================================

export const tidymailBriefingsRouter = Router();

/**
 * POST /api/tidymail/briefing/generate
 * Generate a two-host podcast briefing from emails
 */
tidymailBriefingsRouter.post(
  '/briefing/generate',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.id;
    const validation = generateBriefingSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: validation.error.flatten(),
      });
      return;
    }

    const { emails, user_name, time_of_day, voice_host1, voice_host2 } = validation.data;

    briefingsLogger.info({ userId, emailCount: emails.length }, 'Generating email briefing');

    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
    });

    if (!config.OPENAI_API_KEY) {
      res.status(503).json({
        error: 'SERVICE_UNAVAILABLE',
        message: 'OpenAI API not configured',
      });
      return;
    }

    try {
      // Step 1: Generate script with GPT-4
      const userPrompt = generateBriefingPrompt(emails, user_name, time_of_day);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [
          { role: 'system', content: BRIEFING_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2000,
        temperature: 0.7,
        response_format: { type: 'json_object' },
      });

      const responseText = completion.choices[0]?.message?.content || '[]';
      let segments: Array<{ speaker: string; text: string; type: string }>;

      try {
        const parsed = JSON.parse(responseText);
        segments = Array.isArray(parsed) ? parsed : parsed.segments || parsed.script || [];
      } catch {
        briefingsLogger.error({ responseText }, 'Failed to parse GPT response');
        res.status(500).json({
          error: 'SCRIPT_GENERATION_FAILED',
          message: 'Failed to generate briefing script',
        });
        return;
      }

      // Normalize speaker names
      segments = segments.map(seg => ({
        ...seg,
        speaker: seg.speaker === 'Alex' || seg.speaker === 'host1' ? 'host1' : 'host2',
      }));

      // Step 2: Estimate total text for quota check
      const totalText = segments.map(s => s.text).join(' ');
      const totalChars = totalText.length;
      const estimatedSeconds = Math.ceil(totalChars / CHARS_PER_SECOND);

      // Check quota
      const quotaResult = await canSynthesizeV2(userId, totalChars, estimatedSeconds);
      if (!quotaResult.allowed) {
        res.status(429).json({
          error: 'QUOTA_EXCEEDED',
          message: quotaResult.reason,
          script: segments, // Return script even if can't synthesize
        });
        return;
      }

      // Step 3: Synthesize audio for each segment
      const audioBuffers: Buffer[] = [];
      let totalDuration = 0;

      for (const segment of segments) {
        const voice = segment.speaker === 'host1' ? voice_host1 : voice_host2;

        try {
          const result = await callTTSProvider({
            text: segment.text,
            voiceId: voice,
            speed: 1.0,
            format: 'mp3',
          });

          audioBuffers.push(result.audioBuffer);
          totalDuration += result.durationMs / 1000;
        } catch (error) {
          briefingsLogger.error({ error, segment: segment.text.slice(0, 50) }, 'TTS failed for segment');
          // Continue with other segments
        }
      }

      if (audioBuffers.length === 0) {
        res.status(500).json({
          error: 'TTS_FAILED',
          message: 'Failed to synthesize any audio segments',
          script: segments,
        });
        return;
      }

      // Step 4: Concatenate audio buffers
      const combinedAudio = Buffer.concat(audioBuffers);

      // Step 5: Upload to storage
      const audioPath = `tidymail/briefings/${userId}/${Date.now()}.mp3`;
      await uploadAudioToCache(audioPath, combinedAudio, 'mp3');
      const audioUrl = await getSignedAudioUrl(audioPath);

      // Step 6: Log usage
      await logTTSUsage({
        userId,
        voiceId: `${voice_host1}+${voice_host2}`,
        modelId: 'openai-tts',
        inputCharCount: totalChars,
        outputDurationMs: Math.round(totalDuration * 1000),
        cached: false,
        source: 'tidymail-briefing',
      });

      briefingsLogger.info(
        { userId, segments: segments.length, duration: totalDuration },
        'Email briefing generated successfully'
      );

      res.json({
        audio_url: audioUrl,
        duration_seconds: Math.round(totalDuration),
        script: segments,
        email_count: emails.length,
      });
    } catch (error) {
      briefingsLogger.error({ error, userId }, 'Failed to generate briefing');
      res.status(500).json({
        error: 'GENERATION_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * POST /api/tidymail/email/synthesize
 * Synthesize a single email thread to audio (read aloud)
 */
tidymailBriefingsRouter.post(
  '/email/synthesize',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.id;
    const validation = synthesizeEmailSchema.safeParse(req.body);

    if (!validation.success) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request body',
        details: validation.error.flatten(),
      });
      return;
    }

    const { thread_id, account_id, text, voice_id, speed } = validation.data;
    const characters = text.length;
    const estimatedSeconds = Math.ceil(characters / CHARS_PER_SECOND);

    briefingsLogger.info(
      { userId, threadId: thread_id, chars: characters },
      'Synthesizing email to audio'
    );

    // Check cache first
    const cacheKey = computeCacheKey(text, voice_id, speed, 'mp3');
    const cached = await getCachedAudio(cacheKey);

    if (cached) {
      briefingsLogger.info({ userId, threadId: thread_id }, 'Cache hit for email audio');
      res.json({
        audio_url: cached.audioUrl,
        duration_seconds: cached.durationSeconds,
        cached: true,
      });
      return;
    }

    // Check quota
    const quotaResult = await canSynthesizeV2(userId, characters, estimatedSeconds);
    if (!quotaResult.allowed) {
      res.status(429).json({
        error: 'QUOTA_EXCEEDED',
        message: quotaResult.reason,
      });
      return;
    }

    try {
      // Synthesize audio
      const result = await callTTSProvider({
        text,
        voiceId: voice_id,
        speed,
        format: 'mp3',
      });

      // Upload to storage with cache key path
      const audioPath = `tidymail/emails/${account_id}/${thread_id}/${cacheKey}.mp3`;
      await uploadAudioToCache(audioPath, result.audioBuffer, 'mp3');
      const audioUrl = await getSignedAudioUrl(audioPath);

      // Log usage
      await logTTSUsage({
        userId,
        voiceId: voice_id,
        modelId: 'openai-tts',
        inputCharCount: characters,
        outputDurationMs: result.durationMs,
        cached: false,
        source: 'tidymail-email',
      });

      const durationSeconds = Math.round(result.durationMs / 1000);

      briefingsLogger.info(
        { userId, threadId: thread_id, duration: durationSeconds },
        'Email synthesized successfully'
      );

      res.json({
        audio_url: audioUrl,
        duration_seconds: durationSeconds,
        cached: false,
      });
    } catch (error) {
      briefingsLogger.error({ error, userId, threadId: thread_id }, 'Failed to synthesize email');
      res.status(500).json({
        error: 'SYNTHESIS_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

/**
 * GET /api/tidymail/voices
 * List available voices for TidyMail
 */
tidymailBriefingsRouter.get(
  '/voices',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response) => {
    // OpenAI TTS voices
    const voices = [
      { id: 'alloy', name: 'Alloy', gender: 'neutral', description: 'Warm and conversational' },
      { id: 'echo', name: 'Echo', gender: 'male', description: 'Clear and professional' },
      { id: 'fable', name: 'Fable', gender: 'female', description: 'Expressive storyteller' },
      { id: 'onyx', name: 'Onyx', gender: 'male', description: 'Deep and authoritative' },
      { id: 'nova', name: 'Nova', gender: 'female', description: 'Friendly and energetic' },
      { id: 'shimmer', name: 'Shimmer', gender: 'female', description: 'Warm and soothing' },
    ];

    res.json({
      voices,
      defaults: {
        briefing_host1: 'nova',
        briefing_host2: 'onyx',
        email_read: 'alloy',
      },
    });
  })
);
