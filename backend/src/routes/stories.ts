import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';
import { ValidationError, AuthorizationError } from '../types/index.js';

const storiesLogger = logger.child({ module: 'stories' });

const anthropic = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

// Sonnet is overkill for ~400-word bedtime stories; Haiku is faster + cheaper
// and the calm-cadence prompt below leaves little room for the larger model to
// pay off. Bump back to Sonnet if quality suffers.
const STORY_MODEL = 'claude-haiku-4-5-20251001';

interface DeviceRequest extends Request {
  deviceId: string;
}

function asyncHandler(
  fn: (req: DeviceRequest, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as DeviceRequest, res, next)).catch(next);
  };
}

export const storiesRouter = Router();

// Device ID required — same pattern as cloned-voices. Lets us rate-limit per
// device + attribute usage later without a full auth setup.
storiesRouter.use((req: Request, res: Response, next: NextFunction) => {
  const deviceId = req.headers['x-device-id'] as string | undefined;
  if (!deviceId || deviceId.trim().length === 0) {
    res.status(400).json({ error: 'X-Device-ID header is required' });
    return;
  }
  (req as DeviceRequest).deviceId = deviceId.trim();
  next();
});

// Story generation hits Anthropic, so it costs real money on every request.
// One per 30s per device is plenty — synth on the Hetzner CPU box takes
// 8-15 min anyway, so a tighter generation cadence would just queue stories
// the user can't hear yet.
const storyGenerationRateLimit = rateLimit({
  windowMs: 30 * 1000,
  max: 2,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => (req.headers['x-device-id'] as string) || req.ip || 'anon',
  message: { error: 'Generating stories too quickly — please wait a moment.' },
});

const lengthEnum = z.enum(['short', 'medium', 'long']);
type LengthChoice = z.infer<typeof lengthEnum>;

const generateStorySchema = z.object({
  theme: z.string().min(2).max(200),
  length: lengthEnum.default('medium'),
});

function targetWords(length: LengthChoice): { min: number; max: number; minutes: number } {
  // Spoken word rate at the calm Chatterbox cadence we use is ~110 wpm.
  switch (length) {
    case 'short':
      return { min: 220, max: 320, minutes: 3 };
    case 'medium':
      return { min: 380, max: 520, minutes: 5 };
    case 'long':
      return { min: 600, max: 780, minutes: 7 };
  }
}

storiesRouter.post(
  '/generate',
  storyGenerationRateLimit,
  asyncHandler(async (req: DeviceRequest, res: Response) => {
    if (!anthropic) {
      throw new AuthorizationError('Story generation is not configured');
    }

    const parse = generateStorySchema.safeParse(req.body);
    if (!parse.success) {
      throw new ValidationError('Invalid request body', {
        errors: parse.error.flatten().fieldErrors,
      });
    }

    const { theme, length } = parse.data;
    const { min, max, minutes } = targetWords(length);
    const deviceId = req.deviceId;

    const systemPrompt = `You write original bedtime stories for children ages 3-8.

Hard rules:
- Calm, gentle cadence. Short sentences. Soft imagery (moon, blanket, warm light, sleepy animals).
- No conflict, danger, or loud action. No villains. No fear.
- Always end on a clear sleep-direction line that quietly cues the listener to drift off (e.g. "Goodnight, little dreamer." or "Close your eyes. The stars are watching.").
- Stay between ${min} and ${max} words in the body text. Do not count yourself in the output.
- Body is a single block of prose. No headings, no chapter breaks, no stage directions, no bracketed asides.
- Respond with valid JSON only, no markdown fences, no commentary. Schema:
  {"title": string (max 60 chars), "summary": string (1 sentence, max 120 chars), "body": string}`;

    const userPrompt = `Theme: ${theme}\n\nTarget length: about ${minutes} minutes of reading aloud (${min}-${max} words).`;

    const startedAt = Date.now();
    let completion;
    try {
      completion = await anthropic.messages.create({
        model: STORY_MODEL,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 1600,
        temperature: 0.8,
      });
    } catch (err) {
      storiesLogger.error({ err, deviceId, theme, length }, 'Anthropic call failed');
      throw err;
    }
    const elapsedMs = Date.now() - startedAt;

    const firstBlock = completion.content[0];
    const rawText = firstBlock && firstBlock.type === 'text' ? firstBlock.text.trim() : '';
    if (!rawText) {
      storiesLogger.warn({ deviceId, theme, length }, 'Empty Claude response');
      res.status(502).json({ error: 'Story generator returned an empty response' });
      return;
    }

    // Claude occasionally wraps JSON in ```json fences despite the prompt. Strip
    // them defensively before parsing so a stray fence doesn't bubble up as a 502.
    const stripped = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    let parsed: { title?: string; summary?: string; body?: string };
    try {
      parsed = JSON.parse(stripped);
    } catch (err) {
      storiesLogger.error({ deviceId, theme, length, rawText: stripped.slice(0, 500) }, 'Story JSON parse failed');
      res.status(502).json({ error: 'Story generator returned invalid JSON' });
      return;
    }

    const title = (parsed.title || '').trim();
    const summary = (parsed.summary || '').trim();
    const body = (parsed.body || '').trim();
    if (!title || !body) {
      res.status(502).json({ error: 'Story generator response missing required fields' });
      return;
    }

    const wordCount = body.split(/\s+/).filter(Boolean).length;
    // Recompute estimated minutes from actual word count rather than the request
    // — Claude sometimes overshoots, and the UI banner will be wrong if we lie
    // about the duration.
    const estimatedMinutes = Math.max(2, Math.round(wordCount / 110));

    const storyId = randomUUID();

    storiesLogger.info(
      {
        deviceId,
        theme,
        length,
        storyId,
        elapsedMs,
        wordCount,
        inputTokens: completion.usage?.input_tokens,
        outputTokens: completion.usage?.output_tokens,
      },
      'Story generated',
    );

    res.json({
      storyId,
      title,
      summary,
      body,
      estimatedMinutes,
      wordCount,
      metadata: {
        model: STORY_MODEL,
        length,
        generationMs: elapsedMs,
      },
    });
  }),
);
