/**
 * Standalone TTS Job Worker Script
 *
 * Run with: npx tsx src/runWorker.ts
 *
 * This worker processes queued TTS jobs:
 * 1. Claims a queued job from the database
 * 2. Retrieves the text from temporary storage
 * 3. Synthesizes audio using the TTS service
 * 4. Converts WAV to MP3 (64kbps CBR for seekability)
 * 5. Uploads MP3 to Supabase Storage
 * 6. Updates job status to ready with audio URL
 *
 * Requirements:
 * - ffmpeg must be installed and in PATH
 * - Environment variables must be set (see .env.example)
 */

import { startWorker, stopWorker, isWorkerRunning } from './workers/ttsJobWorker.js';
import { logger } from './lib/logger.js';

const workerLogger = logger.child({ script: 'runWorker' });

// Graceful shutdown handling
process.on('SIGINT', () => {
  workerLogger.info('Received SIGINT, shutting down...');
  stopWorker();
  process.exit(0);
});

process.on('SIGTERM', () => {
  workerLogger.info('Received SIGTERM, shutting down...');
  stopWorker();
  process.exit(0);
});

// Start the worker
workerLogger.info('Starting TTS job worker...');
startWorker({
  maxRetries: parseInt(process.env.WORKER_MAX_RETRIES ?? '3', 10),
  enabled: true,
});

workerLogger.info('TTS job worker is running. Press Ctrl+C to stop.');

// Keep the process alive
setInterval(() => {
  if (!isWorkerRunning()) {
    workerLogger.warn('Worker stopped unexpectedly, restarting...');
    startWorker();
  }
}, 10000);
