import { Router, Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { processJobById } from '../workers/ttsJobWorker.js';

// ============================================================================
// Pub/Sub Push Endpoint
//
// Pub/Sub delivers jobs via HTTP POST to this endpoint instead of the
// service maintaining a long-running pull subscription. This allows
// minScale=0 — the service only runs when there are actual jobs to process.
//
// Auth: token query param checked against PUBSUB_PUSH_SECRET env var.
// The push subscription URL is configured with ?token=<secret>.
//
// Pub/Sub push message format:
// {
//   message: {
//     data: "<base64-encoded TTSJobMessage JSON>",
//     messageId: "...",
//     publishTime: "...",
//     attributes: { attempt: "1", backoffSeconds: "0" }
//   },
//   subscription: "projects/.../subscriptions/..."
// }
//
// Return 200 to ack (job done or already complete).
// Return 5xx to nack (Pub/Sub will retry with backoff).
// ============================================================================

const pushLogger = logger.child({ module: 'worker-push' });

const PUSH_SECRET = process.env.PUBSUB_PUSH_SECRET;

export const workerPushRouter = Router();

workerPushRouter.post('/worker/push', async (req: Request, res: Response): Promise<void> => {
  // Verify shared secret
  if (!PUSH_SECRET || req.query.token !== PUSH_SECRET) {
    pushLogger.warn({ ip: req.ip }, 'Unauthorized push request');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Parse Pub/Sub envelope
  const body = req.body as {
    message?: {
      data?: string;
      messageId?: string;
      attributes?: Record<string, string>;
    };
    subscription?: string;
  };

  if (!body?.message?.data) {
    pushLogger.warn({ body }, 'Malformed Pub/Sub push message — acking to avoid infinite retry');
    res.status(200).json({ status: 'ignored', reason: 'malformed message' });
    return;
  }

  // Decode base64 message data
  let jobMessage: { jobId: string; attempt: number; publishedAt: string };
  try {
    const decoded = Buffer.from(body.message.data, 'base64').toString('utf-8');
    jobMessage = JSON.parse(decoded);
  } catch (err) {
    pushLogger.warn({ err, data: body.message.data }, 'Failed to decode message — acking');
    res.status(200).json({ status: 'ignored', reason: 'decode error' });
    return;
  }

  const { jobId, attempt } = jobMessage;

  if (!jobId) {
    pushLogger.warn({ jobMessage }, 'Missing jobId — acking');
    res.status(200).json({ status: 'ignored', reason: 'missing jobId' });
    return;
  }

  pushLogger.info({ jobId, attempt, messageId: body.message.messageId }, 'Processing pushed job');

  try {
    await processJobById(jobId);
    pushLogger.info({ jobId, attempt }, 'Job processed successfully');
    res.status(200).json({ status: 'ok', jobId });
  } catch (err) {
    pushLogger.error({ err, jobId, attempt }, 'Job processing failed — nacking for retry');
    // Return 500 so Pub/Sub retries this message
    res.status(500).json({ error: 'Processing failed', jobId });
  }
});
