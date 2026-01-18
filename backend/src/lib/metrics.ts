import { logger } from './logger.js';

// ============================================================================
// Metrics Logger
// ============================================================================

const metricsLogger = logger.child({ module: 'metrics' });

// ============================================================================
// Job Metrics Interface
// ============================================================================

export interface JobMetrics {
  job_id: string;
  user_id: string;
  voice_id: string;
  model_id: string;
  input_chars: number;

  // Timing metrics (in milliseconds)
  queued_at: number;           // Timestamp when job was created
  processing_started_at?: number;  // When worker picked up the job
  partial_ready_at?: number;   // When preview was ready
  ready_at?: number;           // When full audio was ready
  failed_at?: number;          // When job failed

  // Calculated durations
  queued_to_processing_ms?: number;
  queued_to_partial_ready_ms?: number;
  queued_to_ready_ms?: number;
  processing_to_ready_ms?: number;

  // Segment-level metrics
  segments_total?: number;
  segments_completed?: number;
  segment_inference_times_ms?: number[];  // Per-segment inference latency
  avg_segment_inference_ms?: number;

  // Output metrics
  audio_duration_sec?: number;
  preview_duration_sec?: number;
  output_size_bytes?: number;

  // Status
  status: 'queued' | 'processing' | 'partial_ready' | 'ready' | 'failed' | 'canceled';
  error_code?: string;
  error_message?: string;

  // Infrastructure
  used_gpu?: boolean;
  worker_instance?: string;
}

// ============================================================================
// In-Memory Metrics Store (for active jobs)
// ============================================================================

const activeJobMetrics = new Map<string, JobMetrics>();

// ============================================================================
// Metrics Recording Functions
// ============================================================================

/**
 * Initialize metrics for a new job.
 */
export function initJobMetrics(
  jobId: string,
  userId: string,
  voiceId: string,
  modelId: string,
  inputChars: number
): void {
  const metrics: JobMetrics = {
    job_id: jobId,
    user_id: userId,
    voice_id: voiceId,
    model_id: modelId,
    input_chars: inputChars,
    queued_at: Date.now(),
    status: 'queued',
  };

  activeJobMetrics.set(jobId, metrics);

  metricsLogger.info({
    event: 'job_created',
    ...metrics,
  }, 'Job metrics initialized');
}

/**
 * Record when processing starts.
 */
export function recordProcessingStart(jobId: string, workerInstance?: string): void {
  const metrics = activeJobMetrics.get(jobId);
  if (!metrics) {
    // Initialize with minimal data if not found
    metricsLogger.warn({ jobId }, 'Metrics not found for job, creating minimal record');
    return;
  }

  const now = Date.now();
  metrics.processing_started_at = now;
  metrics.status = 'processing';
  metrics.worker_instance = workerInstance;
  metrics.queued_to_processing_ms = now - metrics.queued_at;

  metricsLogger.info({
    event: 'processing_started',
    job_id: jobId,
    queued_to_processing_ms: metrics.queued_to_processing_ms,
    worker_instance: workerInstance,
  }, 'Job processing started');
}

/**
 * Record segment inference latency.
 */
export function recordSegmentInference(
  jobId: string,
  segmentIndex: number,
  inferenceTimeMs: number,
  usedGpu: boolean
): void {
  const metrics = activeJobMetrics.get(jobId);
  if (!metrics) return;

  if (!metrics.segment_inference_times_ms) {
    metrics.segment_inference_times_ms = [];
  }
  metrics.segment_inference_times_ms.push(inferenceTimeMs);
  metrics.used_gpu = usedGpu;

  // Update segments completed
  metrics.segments_completed = (metrics.segments_completed ?? 0) + 1;

  metricsLogger.debug({
    event: 'segment_inference',
    job_id: jobId,
    segment_index: segmentIndex,
    inference_time_ms: inferenceTimeMs,
    used_gpu: usedGpu,
  }, 'Segment inference completed');
}

/**
 * Record when preview (partial) is ready.
 */
export function recordPartialReady(
  jobId: string,
  previewDurationSec: number
): void {
  const metrics = activeJobMetrics.get(jobId);
  if (!metrics) return;

  const now = Date.now();
  metrics.partial_ready_at = now;
  metrics.status = 'partial_ready';
  metrics.preview_duration_sec = previewDurationSec;
  metrics.queued_to_partial_ready_ms = now - metrics.queued_at;

  metricsLogger.info({
    event: 'partial_ready',
    job_id: jobId,
    queued_to_partial_ready_ms: metrics.queued_to_partial_ready_ms,
    preview_duration_sec: previewDurationSec,
  }, 'Job preview ready');
}

/**
 * Record when job is fully ready.
 */
export function recordJobReady(
  jobId: string,
  audioDurationSec: number,
  outputSizeBytes: number,
  segmentsTotal?: number
): void {
  const metrics = activeJobMetrics.get(jobId);
  if (!metrics) return;

  const now = Date.now();
  metrics.ready_at = now;
  metrics.status = 'ready';
  metrics.audio_duration_sec = audioDurationSec;
  metrics.output_size_bytes = outputSizeBytes;
  metrics.segments_total = segmentsTotal;
  metrics.queued_to_ready_ms = now - metrics.queued_at;

  if (metrics.processing_started_at) {
    metrics.processing_to_ready_ms = now - metrics.processing_started_at;
  }

  // Calculate average segment inference time
  if (metrics.segment_inference_times_ms && metrics.segment_inference_times_ms.length > 0) {
    const sum = metrics.segment_inference_times_ms.reduce((a, b) => a + b, 0);
    metrics.avg_segment_inference_ms = Math.round(sum / metrics.segment_inference_times_ms.length);
  }

  // Log comprehensive metrics
  metricsLogger.info({
    event: 'job_ready',
    job_id: jobId,
    voice_id: metrics.voice_id,
    model_id: metrics.model_id,
    input_chars: metrics.input_chars,
    audio_duration_sec: audioDurationSec,
    output_size_bytes: outputSizeBytes,
    queued_to_ready_ms: metrics.queued_to_ready_ms,
    queued_to_partial_ready_ms: metrics.queued_to_partial_ready_ms,
    processing_to_ready_ms: metrics.processing_to_ready_ms,
    segments_total: segmentsTotal,
    avg_segment_inference_ms: metrics.avg_segment_inference_ms,
    used_gpu: metrics.used_gpu,
  }, 'Job completed successfully');

  // Clean up after logging
  activeJobMetrics.delete(jobId);
}

/**
 * Record job failure.
 */
export function recordJobFailure(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  voiceId?: string,
  modelId?: string
): void {
  const metrics = activeJobMetrics.get(jobId);
  const now = Date.now();

  const failureData = {
    event: 'job_failed',
    job_id: jobId,
    voice_id: voiceId ?? metrics?.voice_id ?? 'unknown',
    model_id: modelId ?? metrics?.model_id ?? 'unknown',
    error_code: errorCode,
    error_message: errorMessage,
    queued_to_failure_ms: metrics ? now - metrics.queued_at : undefined,
    processing_duration_ms: metrics?.processing_started_at
      ? now - metrics.processing_started_at
      : undefined,
    segments_completed: metrics?.segments_completed ?? 0,
    used_gpu: metrics?.used_gpu,
  };

  metricsLogger.error(failureData, 'Job failed');

  // Clean up
  if (metrics) {
    activeJobMetrics.delete(jobId);
  }
}

// ============================================================================
// Failure Rate Tracking
// ============================================================================

interface FailureStats {
  total: number;
  failures: number;
  lastFailures: { timestamp: number; error: string }[];
}

const failureRateByVoice = new Map<string, FailureStats>();
const failureRateByModel = new Map<string, FailureStats>();

const MAX_FAILURE_HISTORY = 100;
const FAILURE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Track success/failure for voice and model.
 */
export function trackJobResult(
  voiceId: string,
  modelId: string,
  success: boolean,
  errorMessage?: string
): void {
  // Track by voice
  if (!failureRateByVoice.has(voiceId)) {
    failureRateByVoice.set(voiceId, { total: 0, failures: 0, lastFailures: [] });
  }
  const voiceStats = failureRateByVoice.get(voiceId)!;
  voiceStats.total++;
  if (!success) {
    voiceStats.failures++;
    voiceStats.lastFailures.push({ timestamp: Date.now(), error: errorMessage ?? 'unknown' });
    if (voiceStats.lastFailures.length > MAX_FAILURE_HISTORY) {
      voiceStats.lastFailures.shift();
    }
  }

  // Track by model
  if (!failureRateByModel.has(modelId)) {
    failureRateByModel.set(modelId, { total: 0, failures: 0, lastFailures: [] });
  }
  const modelStats = failureRateByModel.get(modelId)!;
  modelStats.total++;
  if (!success) {
    modelStats.failures++;
    modelStats.lastFailures.push({ timestamp: Date.now(), error: errorMessage ?? 'unknown' });
    if (modelStats.lastFailures.length > MAX_FAILURE_HISTORY) {
      modelStats.lastFailures.shift();
    }
  }
}

/**
 * Get failure rate for a voice (percentage).
 */
export function getVoiceFailureRate(voiceId: string): number {
  const stats = failureRateByVoice.get(voiceId);
  if (!stats || stats.total === 0) return 0;
  return (stats.failures / stats.total) * 100;
}

/**
 * Get failure rate for a model (percentage).
 */
export function getModelFailureRate(modelId: string): number {
  const stats = failureRateByModel.get(modelId);
  if (!stats || stats.total === 0) return 0;
  return (stats.failures / stats.total) * 100;
}

/**
 * Get all failure statistics.
 */
export function getFailureStats(): {
  byVoice: Record<string, { total: number; failures: number; rate: number }>;
  byModel: Record<string, { total: number; failures: number; rate: number }>;
} {
  const byVoice: Record<string, { total: number; failures: number; rate: number }> = {};
  const byModel: Record<string, { total: number; failures: number; rate: number }> = {};

  for (const [voiceId, stats] of failureRateByVoice) {
    byVoice[voiceId] = {
      total: stats.total,
      failures: stats.failures,
      rate: stats.total > 0 ? (stats.failures / stats.total) * 100 : 0,
    };
  }

  for (const [modelId, stats] of failureRateByModel) {
    byModel[modelId] = {
      total: stats.total,
      failures: stats.failures,
      rate: stats.total > 0 ? (stats.failures / stats.total) * 100 : 0,
    };
  }

  return { byVoice, byModel };
}

// ============================================================================
// Inference Latency Tracking
// ============================================================================

interface LatencyBucket {
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number[];  // Keep last N samples for percentile calculation
  p99: number[];
}

const inferenceLatencyByModel = new Map<string, LatencyBucket>();
const MAX_LATENCY_SAMPLES = 1000;

/**
 * Record worker inference latency for a segment.
 */
export function recordInferenceLatency(
  modelId: string,
  latencyMs: number,
  usedGpu: boolean
): void {
  const key = `${modelId}:${usedGpu ? 'gpu' : 'cpu'}`;

  if (!inferenceLatencyByModel.has(key)) {
    inferenceLatencyByModel.set(key, {
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      p50: [],
      p99: [],
    });
  }

  const bucket = inferenceLatencyByModel.get(key)!;
  bucket.count++;
  bucket.sum += latencyMs;
  bucket.min = Math.min(bucket.min, latencyMs);
  bucket.max = Math.max(bucket.max, latencyMs);

  // Keep samples for percentile calculation
  bucket.p50.push(latencyMs);
  bucket.p99.push(latencyMs);

  if (bucket.p50.length > MAX_LATENCY_SAMPLES) {
    bucket.p50.shift();
  }
  if (bucket.p99.length > MAX_LATENCY_SAMPLES) {
    bucket.p99.shift();
  }
}

/**
 * Get inference latency statistics.
 */
export function getInferenceLatencyStats(): Record<string, {
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p99: number;
}> {
  const stats: Record<string, {
    count: number;
    avg: number;
    min: number;
    max: number;
    p50: number;
    p99: number;
  }> = {};

  for (const [key, bucket] of inferenceLatencyByModel) {
    const sorted = [...bucket.p50].sort((a, b) => a - b);
    const p50Index = Math.floor(sorted.length * 0.5);
    const p99Index = Math.floor(sorted.length * 0.99);

    stats[key] = {
      count: bucket.count,
      avg: bucket.count > 0 ? Math.round(bucket.sum / bucket.count) : 0,
      min: bucket.min === Infinity ? 0 : Math.round(bucket.min),
      max: bucket.max === -Infinity ? 0 : Math.round(bucket.max),
      p50: sorted.length > 0 ? Math.round(sorted[p50Index] ?? 0) : 0,
      p99: sorted.length > 0 ? Math.round(sorted[p99Index] ?? 0) : 0,
    };
  }

  return stats;
}

// ============================================================================
// Periodic Metrics Summary
// ============================================================================

let metricsInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic metrics logging.
 */
export function startMetricsReporting(intervalMs: number = 60_000): void {
  if (metricsInterval) return;

  metricsInterval = setInterval(() => {
    const failureStats = getFailureStats();
    const latencyStats = getInferenceLatencyStats();

    metricsLogger.info({
      event: 'metrics_summary',
      active_jobs: activeJobMetrics.size,
      failure_stats: failureStats,
      latency_stats: latencyStats,
    }, 'Periodic metrics summary');
  }, intervalMs);

  metricsLogger.info({ intervalMs }, 'Started metrics reporting');
}

/**
 * Stop periodic metrics logging.
 */
export function stopMetricsReporting(): void {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}
