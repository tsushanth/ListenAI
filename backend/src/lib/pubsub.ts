import { PubSub, Message, Subscription } from '@google-cloud/pubsub';
import { logger } from './logger.js';

// ============================================================================
// Pub/Sub Client for TTS Job Queue
// ============================================================================

const pubsubLogger = logger.child({ module: 'pubsub' });

// Configuration
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'summarizerproxy';
const TOPIC_NAME = process.env.PUBSUB_TOPIC || 'tts-jobs';
const SUBSCRIPTION_NAME = process.env.PUBSUB_SUBSCRIPTION || 'tts-jobs-worker';

// Initialize Pub/Sub client
const pubsub = new PubSub({ projectId: PROJECT_ID });

// ============================================================================
// Retry Configuration
// ============================================================================

const MAX_PUBLISH_RETRIES = 3;
const PUBLISH_BASE_DELAY_MS = 1000;

const RETRYABLE_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
];

function isRetryablePublishError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message || '';
    for (const code of RETRYABLE_ERROR_CODES) {
      if (message.includes(code)) return true;
    }
  }
  return false;
}

/**
 * Retry wrapper for Pub/Sub publish operations.
 */
async function withPublishRetry<T>(
  operation: () => Promise<T>,
  context: string
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_PUBLISH_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (!isRetryablePublishError(error)) {
        throw error;
      }

      if (attempt >= MAX_PUBLISH_RETRIES) {
        pubsubLogger.error(
          { error, attempt: attempt + 1, context },
          `Pub/Sub publish failed after ${MAX_PUBLISH_RETRIES + 1} attempts`
        );
        throw error;
      }

      const delay = PUBLISH_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
      pubsubLogger.warn(
        { error: lastError.message, attempt: attempt + 1, delayMs: Math.round(delay), context },
        'Pub/Sub publish failed, retrying...'
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Job message payload
export interface TTSJobMessage {
  jobId: string;
  attempt: number;  // 1-based attempt number
  publishedAt: string;
}

/**
 * Publish a TTS job to the queue.
 * Called by the API when a new job is created.
 */
export async function publishTTSJob(jobId: string): Promise<string> {
  const topic = pubsub.topic(TOPIC_NAME);

  const message: TTSJobMessage = {
    jobId,
    attempt: 1,
    publishedAt: new Date().toISOString(),
  };

  const messageBuffer = Buffer.from(JSON.stringify(message));

  try {
    const messageId = await withPublishRetry(
      () => topic.publishMessage({ data: messageBuffer }),
      `publishTTSJob(${jobId})`
    );
    pubsubLogger.info({ jobId, messageId }, 'Published TTS job to queue');
    return messageId;
  } catch (error) {
    pubsubLogger.error({ error, jobId }, 'Failed to publish TTS job');
    throw error;
  }
}

/**
 * Republish a job for retry with incremented attempt count.
 * Uses exponential backoff via Pub/Sub message scheduling.
 */
export async function republishForRetry(
  jobId: string,
  currentAttempt: number,
  maxRetries: number = 3
): Promise<boolean> {
  if (currentAttempt >= maxRetries) {
    pubsubLogger.warn({ jobId, attempt: currentAttempt, maxRetries }, 'Max retries reached, not republishing');
    return false;
  }

  const topic = pubsub.topic(TOPIC_NAME);
  const nextAttempt = currentAttempt + 1;

  // Exponential backoff: 10s, 30s, 90s
  const backoffSeconds = Math.pow(3, currentAttempt) * 10;

  const message: TTSJobMessage = {
    jobId,
    attempt: nextAttempt,
    publishedAt: new Date().toISOString(),
  };

  const messageBuffer = Buffer.from(JSON.stringify(message));

  try {
    // Pub/Sub doesn't natively support delayed messages,
    // but we can use Cloud Scheduler or implement delay in worker
    // For now, we'll republish immediately and let worker handle backoff
    const messageId = await withPublishRetry(
      () => topic.publishMessage({
        data: messageBuffer,
        attributes: {
          attempt: String(nextAttempt),
          backoffSeconds: String(backoffSeconds),
        }
      }),
      `republishForRetry(${jobId}, attempt=${nextAttempt})`
    );

    pubsubLogger.info({
      jobId,
      messageId,
      attempt: nextAttempt,
      backoffSeconds
    }, 'Republished TTS job for retry');

    return true;
  } catch (error) {
    pubsubLogger.error({ error, jobId }, 'Failed to republish TTS job for retry');
    return false;
  }
}

/**
 * Message handler type for the worker.
 */
export type MessageHandler = (message: TTSJobMessage) => Promise<void>;

/**
 * Start consuming messages from the subscription.
 * Returns a function to stop the subscription.
 */
export function startSubscription(handler: MessageHandler): () => void {
  const subscription = pubsub.subscription(SUBSCRIPTION_NAME);

  pubsubLogger.info({ subscription: SUBSCRIPTION_NAME }, 'Starting Pub/Sub subscription');

  const messageHandler = async (message: Message) => {
    const startTime = Date.now();
    let jobMessage: TTSJobMessage;

    try {
      jobMessage = JSON.parse(message.data.toString()) as TTSJobMessage;
    } catch (error) {
      pubsubLogger.error({ error, messageId: message.id }, 'Failed to parse message');
      message.ack();  // Ack malformed messages to avoid infinite retries
      return;
    }

    const { jobId, attempt } = jobMessage;
    const backoffSeconds = message.attributes?.backoffSeconds
      ? parseInt(message.attributes.backoffSeconds, 10)
      : 0;

    pubsubLogger.info({ jobId, attempt, messageId: message.id, backoffSeconds }, 'Processing message');

    // If this is a retry with backoff, wait before processing
    if (backoffSeconds > 0 && attempt > 1) {
      pubsubLogger.info({ jobId, backoffSeconds }, 'Applying backoff delay');
      await new Promise(resolve => setTimeout(resolve, backoffSeconds * 1000));
    }

    try {
      await handler(jobMessage);
      message.ack();

      const processingTime = Date.now() - startTime;
      pubsubLogger.info({ jobId, attempt, processingTime }, 'Message processed successfully');

    } catch (error) {
      pubsubLogger.error({ error, jobId, attempt }, 'Message handler failed');

      // Nack the message to trigger Pub/Sub's built-in retry
      // Or we handle retry ourselves with republish
      message.ack();  // Ack anyway - we'll handle retry via republish
    }
  };

  subscription.on('message', messageHandler);

  subscription.on('error', (error: Error) => {
    pubsubLogger.error({ error }, 'Subscription error');
  });

  // Return stop function
  return () => {
    subscription.removeListener('message', messageHandler);
    pubsubLogger.info('Pub/Sub subscription stopped');
  };
}

/**
 * Check if Pub/Sub is configured and available.
 */
export async function checkPubSubHealth(): Promise<boolean> {
  try {
    const topic = pubsub.topic(TOPIC_NAME);
    const [exists] = await topic.exists();
    return exists;
  } catch {
    return false;
  }
}

export { pubsub, TOPIC_NAME, SUBSCRIPTION_NAME };
