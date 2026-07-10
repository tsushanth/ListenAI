import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { ValidationError, AuthorizationError } from '../types/index.js';

// ============================================================================
// Anthropic Client
// ============================================================================

const anthropic = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;
const LLM_MODEL = 'claude-sonnet-4-6';

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

export const aiRouter = Router();

// ============================================================================
// Request Validation
// ============================================================================

const summarizeRequestSchema = z.object({
  text: z.string().min(1).max(100_000),
  action: z.enum(['summarize', 'key_points', 'explain', 'custom']),
  title: z.string().max(500).optional(),
  custom_prompt: z.string().max(500).optional(),
});

// ============================================================================
// POST /ai/summarize - Generate AI summary of article text
// ============================================================================

aiRouter.post(
  '/summarize',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!anthropic) {
      throw new AuthorizationError('AI features are not configured');
    }

    const userId = req.user.id;

    // Validate request
    const parseResult = summarizeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError('Invalid request body', {
        errors: parseResult.error.flatten().fieldErrors,
      });
    }

    const { text, action, title, custom_prompt } = parseResult.data;

    logger.info(
      { userId, action, textLength: text.length },
      'AI summarize request received'
    );

    // Build system prompt based on action
    let systemPrompt: string;
    let userPrompt: string;

    switch (action) {
      case 'summarize':
        systemPrompt = `You are a helpful assistant that summarizes articles concisely.
Provide a clear, engaging summary that captures the main points in 2-3 paragraphs.
Focus on the key information and insights without unnecessary details.`;
        userPrompt = title
          ? `Please summarize this article titled "${title}":\n\n${text}`
          : `Please summarize this article:\n\n${text}`;
        break;

      case 'key_points':
        systemPrompt = `You are a helpful assistant that extracts key points from articles.
Provide 5-7 bullet points that capture the most important information.
Each point should be concise but informative.`;
        userPrompt = title
          ? `Extract the key points from this article titled "${title}":\n\n${text}`
          : `Extract the key points from this article:\n\n${text}`;
        break;

      case 'explain':
        systemPrompt = `You are a helpful assistant that explains articles in simple terms.
Explain the article as if you're explaining it to someone unfamiliar with the topic.
Use clear, accessible language and provide context where helpful.`;
        userPrompt = title
          ? `Please explain this article titled "${title}" in simple terms:\n\n${text}`
          : `Please explain this article in simple terms:\n\n${text}`;
        break;

      case 'custom':
        systemPrompt = `You are a helpful assistant that answers questions about articles.
Provide clear, accurate answers based on the article content.`;
        userPrompt = custom_prompt
          ? `Based on this article${title ? ` titled "${title}"` : ''}:\n\n${text}\n\nQuestion: ${custom_prompt}`
          : `Please analyze this article:\n\n${text}`;
        break;

      default:
        systemPrompt = 'You are a helpful assistant.';
        userPrompt = text;
    }

    // Truncate text if too long for context window (leave room for response)
    const maxInputChars = 30_000; // Conservative limit for GPT-4 context
    const truncatedText =
      text.length > maxInputChars
        ? text.slice(0, maxInputChars) + '\n\n[Article truncated due to length...]'
        : text;

    // Update userPrompt with truncated text
    userPrompt = userPrompt.replace(text, truncatedText);

    try {
      const startTime = Date.now();

      const completion = await anthropic.messages.create({
        model: LLM_MODEL,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 1000,
        temperature: 0.7,
      });

      const responseTime = Date.now() - startTime;
      const firstBlock = completion.content[0];
      const aiResponse =
        firstBlock && firstBlock.type === 'text' ? firstBlock.text : 'Unable to generate response.';

      logger.info(
        {
          userId,
          action,
          responseTimeMs: responseTime,
          inputTokens: completion.usage?.input_tokens,
          outputTokens: completion.usage?.output_tokens,
        },
        'AI summarize completed'
      );

      res.json({
        success: true,
        response: aiResponse,
        action,
        metadata: {
          model: LLM_MODEL,
          response_time_ms: responseTime,
          input_length: truncatedText.length,
          was_truncated: text.length > maxInputChars,
        },
      });
    } catch (error) {
      logger.error({ error, userId, action }, 'AI summarize failed');
      throw error;
    }
  })
);

// ============================================================================
// GET /ai/status - Check if AI features are available
// ============================================================================

aiRouter.get('/status', (_req: Request, res: Response) => {
  res.json({
    available: anthropic !== null,
    features: ['summarize', 'key_points', 'explain', 'custom'],
  });
});
