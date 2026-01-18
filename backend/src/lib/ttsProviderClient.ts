import axios, { AxiosInstance, AxiosError } from 'axios';
import * as readline from 'readline';
import * as http from 'http';
import * as https from 'https';
import { Readable } from 'stream';
import { config } from './config.js';
import { ttsLogger } from './logger.js';
import type {
  TTSProvider,
  TTSProviderRequest,
  TTSProviderResponse,
  DBVoice,
} from '../types/index.js';
import { TTSProviderError } from '../types/index.js';

// ============================================================================
// Connection Pool Configuration
// ============================================================================

/**
 * HTTP Agent with connection pooling and keep-alive.
 * This reduces ECONNRESET errors by reusing connections and providing
 * better connection management.
 */
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,       // Keep connections alive for 30s
  maxSockets: 10,              // Max concurrent connections per host
  maxFreeSockets: 5,           // Max idle connections to keep
  timeout: 60000,              // Socket timeout 60s
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,       // Keep connections alive for 30s
  maxSockets: 10,              // Max concurrent connections per host
  maxFreeSockets: 5,           // Max idle connections to keep
  timeout: 60000,              // Socket timeout 60s
  rejectUnauthorized: true,    // Verify SSL certificates
});

// ============================================================================
// Circuit Breaker Pattern
// ============================================================================

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerConfig {
  failureThreshold: number;    // Number of failures before opening circuit
  successThreshold: number;    // Number of successes in half-open before closing
  resetTimeoutMs: number;      // Time before trying again when open
  monitorWindowMs: number;     // Time window for counting failures
}

const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,         // Open circuit after 5 failures
  successThreshold: 2,         // Close circuit after 2 successes in half-open
  resetTimeoutMs: 30000,       // Try again after 30 seconds
  monitorWindowMs: 60000,      // Count failures in 60-second window
};

/**
 * Circuit Breaker implementation for TTS service.
 * Prevents cascading failures by stopping requests when the service is unhealthy.
 */
class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures: number[] = [];  // Timestamps of failures
  private successes: number = 0;    // Successes in half-open state
  private lastFailureTime: number = 0;
  private config: CircuitBreakerConfig;
  private name: string;

  constructor(name: string, config: CircuitBreakerConfig = DEFAULT_CIRCUIT_CONFIG) {
    this.name = name;
    this.config = config;
  }

  /**
   * Check if the circuit allows requests.
   */
  canExecute(): boolean {
    this.cleanOldFailures();

    switch (this.state) {
      case 'closed':
        return true;

      case 'open':
        // Check if reset timeout has passed
        if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
          this.state = 'half-open';
          this.successes = 0;
          ttsLogger.info(
            { circuit: this.name },
            'Circuit breaker transitioning to half-open state'
          );
          return true;
        }
        return false;

      case 'half-open':
        return true;

      default:
        return true;
    }
  }

  /**
   * Record a successful operation.
   */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        this.state = 'closed';
        this.failures = [];
        ttsLogger.info(
          { circuit: this.name },
          'Circuit breaker closed - service recovered'
        );
      }
    } else if (this.state === 'closed') {
      // In closed state, clear old failures on success
      this.cleanOldFailures();
    }
  }

  /**
   * Record a failed operation.
   */
  recordFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    this.lastFailureTime = now;

    this.cleanOldFailures();

    if (this.state === 'half-open') {
      // Any failure in half-open immediately opens the circuit
      this.state = 'open';
      ttsLogger.warn(
        { circuit: this.name },
        'Circuit breaker opened - failure in half-open state'
      );
    } else if (this.state === 'closed' && this.failures.length >= this.config.failureThreshold) {
      this.state = 'open';
      ttsLogger.warn(
        { circuit: this.name, failures: this.failures.length },
        'Circuit breaker opened - failure threshold exceeded'
      );
    }
  }

  /**
   * Remove failures outside the monitoring window.
   */
  private cleanOldFailures(): void {
    const cutoff = Date.now() - this.config.monitorWindowMs;
    this.failures = this.failures.filter(t => t > cutoff);
  }

  /**
   * Get current circuit state for monitoring.
   */
  getState(): { state: CircuitState; failures: number; lastFailure: number | null } {
    this.cleanOldFailures();
    return {
      state: this.state,
      failures: this.failures.length,
      lastFailure: this.lastFailureTime || null,
    };
  }

  /**
   * Force reset the circuit (e.g., for manual recovery).
   */
  reset(): void {
    this.state = 'closed';
    this.failures = [];
    this.successes = 0;
    this.lastFailureTime = 0;
    ttsLogger.info(
      { circuit: this.name },
      'Circuit breaker manually reset'
    );
  }
}

// Global circuit breaker for GPU TTS service
const gpuCircuitBreaker = new CircuitBreaker('gpu-tts');

// Global circuit breaker for CPU TTS service
const cpuCircuitBreaker = new CircuitBreaker('cpu-tts');

// ============================================================================
// Retry Configuration
// ============================================================================

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors: string[];
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,      // Start with 1 second
  maxDelayMs: 10000,      // Cap at 10 seconds
  retryableErrors: [
    'ECONNRESET',         // Connection reset by peer
    'ECONNREFUSED',       // Connection refused (service down)
    'ETIMEDOUT',          // Connection timed out
    'ENOTFOUND',          // DNS lookup failed
    'EAI_AGAIN',          // DNS temporary failure
    'EPIPE',              // Broken pipe
    'ENETUNREACH',        // Network unreachable
    'EHOSTUNREACH',       // Host unreachable
    'ECONNABORTED',       // Connection aborted
  ],
};

/**
 * Calculate delay with exponential backoff and jitter.
 * Formula: min(maxDelay, baseDelay * 2^attempt + random_jitter)
 */
function calculateBackoffDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 500; // 0-500ms jitter
  return Math.min(config.maxDelayMs, exponentialDelay + jitter);
}

/**
 * Check if an error is retryable (network/transient errors).
 */
function isRetryableError(error: unknown, config: RetryConfig): boolean {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;

    // Check for retryable error codes
    if (axiosError.code && config.retryableErrors.includes(axiosError.code)) {
      return true;
    }

    // Retry on 502, 503, 504 (gateway/service unavailable errors)
    const status = axiosError.response?.status;
    if (status && [502, 503, 504].includes(status)) {
      return true;
    }
  }

  return false;
}

/**
 * Execute a function with exponential backoff retry.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Don't retry if it's not a retryable error
      if (!isRetryableError(error, config)) {
        throw error;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= config.maxRetries) {
        ttsLogger.error(
          {
            error,
            attempt: attempt + 1,
            maxRetries: config.maxRetries,
            operation: operationName
          },
          `${operationName} failed after ${config.maxRetries + 1} attempts`
        );
        throw error;
      }

      // Calculate backoff delay
      const delay = calculateBackoffDelay(attempt, config);

      const errorCode = axios.isAxiosError(error) ? error.code : 'UNKNOWN';
      ttsLogger.warn(
        {
          error: errorCode,
          attempt: attempt + 1,
          maxRetries: config.maxRetries,
          delayMs: Math.round(delay),
          operation: operationName
        },
        `${operationName} failed with ${errorCode}, retrying in ${Math.round(delay)}ms...`
      );

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError;
}

// Streaming chunk response from TTS service
export interface TTSStreamChunk {
  index: number;
  total: number;
  audio: string;  // base64-encoded WAV
  duration_ms: number;
  synthesis_time_ms?: number;
  final: boolean;
  error?: string;
}

// ============================================================================
// Provider Clients
// ============================================================================

interface ProviderClient {
  synthesize(request: TTSProviderRequest): Promise<TTSProviderResponse>;
}

// Self-Hosted TTS Client (Kokoro)
class SelfHostedClient implements ProviderClient {
  private client: AxiosInstance;
  private circuitBreaker: CircuitBreaker;
  private name: string;

  // Threshold for using chunked synthesis (characters)
  // Above this, use /synthesize-long endpoint for better reliability
  private static readonly CHUNK_THRESHOLD = 1000;

  constructor(baseUrl: string, apiKey?: string, circuitBreaker?: CircuitBreaker, name: string = 'unknown') {
    this.name = name;
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker(name);

    const headers: Record<string, string> = {
      'Accept': 'audio/wav',
    };
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    // Determine if the URL is HTTPS or HTTP
    const isHttps = baseUrl.startsWith('https://');

    this.client = axios.create({
      baseURL: baseUrl,
      headers,
      responseType: 'arraybuffer',
      timeout: 300000, // 5 minute timeout for long synthesis
      // Use connection pooling with keep-alive to reduce ECONNRESET errors
      httpAgent: httpAgent,
      httpsAgent: httpsAgent,
    });

    ttsLogger.info(
      { baseUrl, useHttps: isHttps, keepAlive: true, client: name },
      'SelfHostedClient initialized with connection pooling'
    );
  }

  async synthesize(request: TTSProviderRequest): Promise<TTSProviderResponse> {
    // Check circuit breaker before making request
    if (!this.circuitBreaker.canExecute()) {
      const state = this.circuitBreaker.getState();
      ttsLogger.warn(
        { client: this.name, circuitState: state.state, failures: state.failures },
        'Circuit breaker is open - rejecting request'
      );
      throw new TTSProviderError('SelfHosted', `TTS service temporarily unavailable (circuit open after ${state.failures} failures)`);
    }

    const textLength = request.text.length;

    try {
      let result: TTSProviderResponse;

      // Use chunked synthesis for long texts
      if (textLength > SelfHostedClient.CHUNK_THRESHOLD) {
        result = await this.synthesizeLong(request);
      } else {
        result = await this.synthesizeShort(request);
      }

      // Record success
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      // Record failure for retryable errors
      if (isRetryableError(error, DEFAULT_RETRY_CONFIG)) {
        this.circuitBreaker.recordFailure();
      }
      throw error;
    }
  }

  /**
   * Get circuit breaker state for monitoring.
   */
  getCircuitState(): { state: CircuitState; failures: number; lastFailure: number | null } {
    return this.circuitBreaker.getState();
  }

  /**
   * Reset circuit breaker (for manual recovery).
   */
  resetCircuit(): void {
    this.circuitBreaker.reset();
  }

  /**
   * Synthesize short text (under threshold)
   * Uses exponential backoff retry for transient network errors.
   */
  private async synthesizeShort(request: TTSProviderRequest): Promise<TTSProviderResponse> {
    const settings = request.settings as {
      language?: string;
      model?: string;
    } | undefined;

    // Use Kokoro model by default (fast, Apache licensed)
    // Normalize model ID: database stores 'kokoro-82m' but API expects 'kokoro'
    const rawModel = settings?.model ?? request.modelId ?? 'kokoro';
    const model = rawModel.startsWith('kokoro') ? 'kokoro' : rawModel;

    ttsLogger.info(
      { voiceId: request.voiceId, textLength: request.text.length, model },
      'Self-hosted TTS: short synthesis'
    );

    try {
      const response = await withRetry(
        async () => {
          return this.client.post(
            '/synthesize',
            {
              text: request.text,
              voice_id: request.voiceId,
              language: settings?.language ?? 'en',
              speed: request.speed ?? 1.0,
              model: model,
            },
            {
              headers: {
                'Content-Type': 'application/json',
              },
              responseType: 'arraybuffer',
            }
          );
        },
        `TTS short synthesis (${request.text.length} chars)`
      );

      const durationMs = response.headers['x-synthesis-time-ms']
        ? parseInt(response.headers['x-synthesis-time-ms'], 10)
        : undefined;

      // Ensure we have a proper Buffer from the arraybuffer response
      const audioBuffer = response.data instanceof ArrayBuffer
        ? Buffer.from(response.data)
        : Buffer.isBuffer(response.data)
          ? response.data
          : Buffer.from(response.data as Uint8Array);

      ttsLogger.info(
        { audioSize: audioBuffer.length, dataType: typeof response.data, isArrayBuffer: response.data instanceof ArrayBuffer },
        'Self-hosted TTS: audio buffer created'
      );

      return {
        audioBuffer,
        format: 'wav',
        durationMs,
      };
    } catch (error) {
      ttsLogger.error({ error, voiceId: request.voiceId }, 'Self-hosted TTS short synthesis failed after retries');
      throw this.handleError(error);
    }
  }

  /**
   * Synthesize long text using chunked endpoint
   * The tts-service splits text into sentences and synthesizes each chunk.
   * Uses exponential backoff retry for transient network errors.
   */
  private async synthesizeLong(request: TTSProviderRequest): Promise<TTSProviderResponse> {
    const settings = request.settings as {
      language?: string;
      model?: string;
    } | undefined;

    // Use Kokoro for long texts (faster on CPU)
    // Normalize model ID: database stores 'kokoro-82m' but API expects 'kokoro'
    const rawModel = settings?.model ?? request.modelId ?? 'kokoro';
    const model = rawModel.startsWith('kokoro') ? 'kokoro' : rawModel;

    ttsLogger.info(
      { voiceId: request.voiceId, textLength: request.text.length, model },
      'Self-hosted TTS: long synthesis with chunking'
    );

    // Long synthesis gets more retries and longer delays since it's more resource-intensive
    const longSynthesisRetryConfig: RetryConfig = {
      maxRetries: 4,          // More retries for long synthesis
      baseDelayMs: 2000,      // Start with 2 seconds
      maxDelayMs: 30000,      // Cap at 30 seconds
      retryableErrors: DEFAULT_RETRY_CONFIG.retryableErrors,
    };

    try {
      const response = await withRetry(
        async () => {
          return this.client.post(
            '/synthesize-long',
            {
              text: request.text,
              voice_id: request.voiceId,
              language: settings?.language ?? 'en',
              speed: request.speed ?? 1.0,
              model: model,
              max_chunk_chars: 250,  // Optimal for CPU-based synthesis
            },
            {
              headers: {
                'Content-Type': 'application/json',
              },
              responseType: 'arraybuffer',
              timeout: 600000,  // 10 minute timeout for very long texts
            }
          );
        },
        `TTS long synthesis (${request.text.length} chars)`,
        longSynthesisRetryConfig
      );

      const durationMs = response.headers['x-synthesis-time-ms']
        ? parseInt(response.headers['x-synthesis-time-ms'], 10)
        : undefined;

      const totalChunks = response.headers['x-total-chunks']
        ? parseInt(response.headers['x-total-chunks'], 10)
        : undefined;

      // Ensure we have a proper Buffer from the arraybuffer response
      const audioBuffer = response.data instanceof ArrayBuffer
        ? Buffer.from(response.data)
        : Buffer.isBuffer(response.data)
          ? response.data
          : Buffer.from(response.data as Uint8Array);

      ttsLogger.info(
        { totalChunks, durationMs, audioSize: audioBuffer.length },
        'Self-hosted TTS: long synthesis completed'
      );

      return {
        audioBuffer,
        format: 'wav',
        durationMs,
      };
    } catch (error) {
      ttsLogger.error({ error, voiceId: request.voiceId }, 'Self-hosted TTS long synthesis failed after retries');
      throw this.handleError(error);
    }
  }

  private handleError(error: unknown): TTSProviderError {
    if (axios.isAxiosError(error)) {
      const code = error.code;

      // Network connectivity errors
      if (code === 'ECONNREFUSED') {
        return new TTSProviderError('SelfHosted', 'TTS service unavailable - please try again');
      }
      if (code === 'ECONNRESET') {
        return new TTSProviderError('SelfHosted', 'Connection to TTS service was reset - please try again');
      }
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        return new TTSProviderError('SelfHosted', 'TTS request timed out - text may be too long');
      }
      if (code === 'EPIPE') {
        return new TTSProviderError('SelfHosted', 'Connection to TTS service was interrupted - please try again');
      }
      if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
        return new TTSProviderError('SelfHosted', 'TTS service is unreachable - please try again');
      }

      // HTTP status errors
      const status = error.response?.status;
      if (status === 502 || status === 503 || status === 504) {
        return new TTSProviderError('SelfHosted', 'TTS service temporarily unavailable - please try again');
      }

      const message = error.response?.data?.detail ?? error.message;
      return new TTSProviderError('SelfHosted', message);
    }
    return new TTSProviderError('SelfHosted', 'Unknown error');
  }

  /**
   * Stream synthesis - yields chunks as they're synthesized
   * Uses NDJSON format from the TTS service.
   * Uses exponential backoff retry for initial connection.
   */
  async *synthesizeStream(request: TTSProviderRequest): AsyncGenerator<TTSStreamChunk> {
    const settings = request.settings as {
      language?: string;
      model?: string;
    } | undefined;

    const model = settings?.model ?? 'kokoro';

    ttsLogger.info(
      { voiceId: request.voiceId, textLength: request.text.length, model },
      'Self-hosted TTS: starting streaming synthesis'
    );

    try {
      // Retry the initial connection - once streaming starts, we don't retry mid-stream
      const response = await withRetry(
        async () => {
          return this.client.post(
            '/synthesize-stream',
            {
              text: request.text,
              voice_id: request.voiceId,
              language: settings?.language ?? 'en',
              speed: request.speed ?? 1.0,
              model: model,
              max_chunk_chars: 250,
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/x-ndjson',
              },
              responseType: 'stream',
              timeout: 900000,  // 15 minute timeout for streaming
            }
          );
        },
        `TTS streaming synthesis (${request.text.length} chars)`
      );

      // Create readline interface to parse NDJSON
      const rl = readline.createInterface({
        input: response.data as Readable,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const chunk = JSON.parse(line) as TTSStreamChunk;
            ttsLogger.debug(
              { index: chunk.index, total: chunk.total, durationMs: chunk.duration_ms },
              'Received TTS chunk'
            );
            yield chunk;

            if (chunk.error) {
              throw new TTSProviderError('SelfHosted', chunk.error);
            }
          } catch (parseError) {
            ttsLogger.error({ parseError, line }, 'Failed to parse TTS stream chunk');
          }
        }
      }

      ttsLogger.info('Self-hosted TTS: streaming synthesis completed');
    } catch (error) {
      ttsLogger.error({ error }, 'Self-hosted TTS streaming failed after retries');
      throw this.handleError(error);
    }
  }
}

// Mock TTS Client (for development/testing)
class MockTTSClient implements ProviderClient {
  async synthesize(request: TTSProviderRequest): Promise<TTSProviderResponse> {
    ttsLogger.info({ voiceId: request.voiceId, textLength: request.text.length }, 'Mock TTS synthesis');

    // Simulate processing delay (50-200ms)
    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 150));

    // Generate a simple audio-like buffer (silence in MP3 format header)
    // This is a minimal valid MP3 frame for testing purposes
    const mp3Header = Buffer.from([
      0xFF, 0xFB, 0x90, 0x00, // MP3 frame header
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);

    // Repeat the frame to create a longer "audio" based on text length
    const framesNeeded = Math.max(1, Math.ceil(request.text.length / 10));
    const audioBuffer = Buffer.concat(Array(framesNeeded).fill(mp3Header));

    // Estimate duration based on character count
    const estimatedDurationMs = estimateDurationMs(request.text.length, request.speed);

    return {
      audioBuffer,
      format: 'mp3',
      durationMs: estimatedDurationMs,
    };
  }
}

// ============================================================================
// Provider Manager
// ============================================================================

class TTSProviderManager {
  private providers: Map<TTSProvider, ProviderClient> = new Map();
  private gpuClient: SelfHostedClient | null = null;
  private cpuClient: SelfHostedClient | null = null;
  private gpuEnabled: boolean = false;
  private gpuHealthy: boolean = true;  // Assume healthy until proven otherwise
  private lastGpuHealthCheck: number = 0;
  private readonly GPU_HEALTH_CHECK_INTERVAL = 30000;  // 30 seconds

  constructor() {
    // GPU TTS (primary, faster inference) with circuit breaker
    if (config.GPU_TTS_URL && config.GPU_TTS_ENABLED) {
      this.gpuClient = new SelfHostedClient(
        config.GPU_TTS_URL,
        config.SELFHOSTED_TTS_API_KEY,
        gpuCircuitBreaker,
        'gpu-tts'
      );
      this.gpuEnabled = true;
      ttsLogger.info({ url: config.GPU_TTS_URL }, 'GPU TTS provider configured (primary) with circuit breaker');
    }

    // CPU TTS (fallback) with circuit breaker
    if (config.SELFHOSTED_TTS_URL) {
      this.cpuClient = new SelfHostedClient(
        config.SELFHOSTED_TTS_URL,
        config.SELFHOSTED_TTS_API_KEY,
        cpuCircuitBreaker,
        'cpu-tts'
      );
      // Register as selfhosted provider for backward compatibility
      this.providers.set('selfhosted', this.cpuClient);
      ttsLogger.info({ url: config.SELFHOSTED_TTS_URL }, 'CPU TTS provider configured (fallback) with circuit breaker');
    }

    // Mock provider (always available for testing)
    this.providers.set('mock', new MockTTSClient());
  }

  /**
   * Check if GPU endpoint is healthy.
   */
  private async checkGpuHealth(): Promise<boolean> {
    if (!this.gpuClient || !this.gpuEnabled) {
      return false;
    }

    const now = Date.now();
    if (now - this.lastGpuHealthCheck < this.GPU_HEALTH_CHECK_INTERVAL) {
      return this.gpuHealthy;
    }

    try {
      // Quick health check via a minimal request
      const testRequest: TTSProviderRequest = {
        text: 'test',
        voiceId: 'am_adam',
      };
      await Promise.race([
        this.gpuClient.synthesize(testRequest),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
      ]);
      this.gpuHealthy = true;
      this.lastGpuHealthCheck = now;
      return true;
    } catch (error) {
      ttsLogger.warn({ error }, 'GPU TTS health check failed');
      this.gpuHealthy = false;
      this.lastGpuHealthCheck = now;
      return false;
    }
  }

  /**
   * Get the best available TTS client (GPU preferred, CPU fallback).
   * Takes circuit breaker state into account.
   */
  async getBestClient(): Promise<{ client: SelfHostedClient; isGpu: boolean } | null> {
    // Try GPU first if enabled, healthy, and circuit is not open
    if (this.gpuEnabled && this.gpuClient && this.gpuHealthy) {
      const gpuCircuitState = this.gpuClient.getCircuitState();
      if (gpuCircuitState.state !== 'open') {
        return { client: this.gpuClient, isGpu: true };
      }
      ttsLogger.warn(
        { circuitState: gpuCircuitState.state, failures: gpuCircuitState.failures },
        'GPU circuit breaker open, falling back to CPU'
      );
    }

    // Fall back to CPU if circuit is not open
    if (this.cpuClient) {
      const cpuCircuitState = this.cpuClient.getCircuitState();
      if (cpuCircuitState.state !== 'open') {
        return { client: this.cpuClient, isGpu: false };
      }
      ttsLogger.warn(
        { circuitState: cpuCircuitState.state, failures: cpuCircuitState.failures },
        'CPU circuit breaker also open - no TTS provider available'
      );
    }

    return null;
  }

  /**
   * Get a provider client by name.
   */
  getProvider(name: TTSProvider): ProviderClient | undefined {
    return this.providers.get(name);
  }

  /**
   * Check if a provider is available.
   */
  hasProvider(name: TTSProvider): boolean {
    return this.providers.has(name);
  }

  /**
   * Synthesize text using the appropriate provider based on voice config.
   */
  async synthesize(
    voice: DBVoice,
    text: string,
    options?: { speed?: number; format?: 'mp3' | 'wav' | 'ogg' }
  ): Promise<TTSProviderResponse> {
    const provider = this.getProvider(voice.provider);

    if (!provider) {
      throw new TTSProviderError(voice.provider, 'Provider not configured');
    }

    ttsLogger.info(
      {
        provider: voice.provider,
        voiceId: voice.provider_voice_id,
        textLength: text.length,
      },
      'Starting TTS synthesis'
    );

    const startTime = Date.now();

    const result = await provider.synthesize({
      text,
      voiceId: voice.provider_voice_id,
      modelId: voice.provider_model_id ?? undefined,
      settings: voice.settings,
      speed: options?.speed,
      format: options?.format,
    });

    const duration = Date.now() - startTime;
    ttsLogger.info(
      {
        provider: voice.provider,
        durationMs: duration,
        audioSize: result.audioBuffer.length,
      },
      'TTS synthesis completed'
    );

    return result;
  }

  /**
   * Map voice IDs to self-hosted Kokoro equivalents.
   */
  private mapToSelfHostedVoice(voiceId: string): string {
    // If it's already a Kokoro voice ID (e.g., am_adam, af_nicole), pass it through unchanged
    if (/^[ab][fm]_/.test(voiceId)) {
      return voiceId;
    }

    // Default to Adam (male) for unknown voice IDs
    return 'am_adam';
  }

  /**
   * Check if self-hosted service is healthy.
   */
  async checkSelfHostedHealth(): Promise<boolean> {
    if (!this.hasProvider('selfhosted')) {
      return false;
    }

    try {
      // A simple health check can be done by synthesizing a very short text
      // In a real implementation, the service would have a /health endpoint
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synthesize using GPU with CPU fallback.
   * This is the preferred method for the worker - uses GPU when available,
   * falls back to CPU if GPU is unhealthy or unavailable.
   */
  async synthesizeWithFallback(
    request: TTSProviderRequest
  ): Promise<TTSProviderResponse & { usedGpu: boolean }> {
    const bestClient = await this.getBestClient();

    if (!bestClient) {
      throw new TTSProviderError('None', 'No TTS provider available');
    }

    const { client, isGpu } = bestClient;
    const startTime = Date.now();

    try {
      ttsLogger.info(
        {
          voiceId: request.voiceId,
          textLength: request.text.length,
          usingGpu: isGpu,
        },
        'Starting TTS synthesis with fallback'
      );

      const result = await client.synthesize(request);

      const duration = Date.now() - startTime;
      ttsLogger.info(
        {
          durationMs: duration,
          audioSize: result.audioBuffer.length,
          usedGpu: isGpu,
        },
        'TTS synthesis completed'
      );

      return { ...result, usedGpu: isGpu };
    } catch (error) {
      // If GPU failed, try CPU fallback
      if (isGpu && this.cpuClient) {
        ttsLogger.warn(
          { error, voiceId: request.voiceId },
          'GPU synthesis failed, falling back to CPU'
        );

        this.gpuHealthy = false;  // Mark GPU as unhealthy

        const cpuStartTime = Date.now();
        const result = await this.cpuClient.synthesize(request);

        const duration = Date.now() - cpuStartTime;
        ttsLogger.info(
          {
            durationMs: duration,
            audioSize: result.audioBuffer.length,
            usedGpu: false,
            fallback: true,
          },
          'CPU fallback synthesis completed'
        );

        return { ...result, usedGpu: false };
      }

      throw error;
    }
  }

  /**
   * Check if GPU is currently enabled and healthy.
   */
  isGpuAvailable(): boolean {
    return this.gpuEnabled && this.gpuHealthy && this.gpuClient !== null;
  }

  /**
   * Force re-check GPU health on next request.
   */
  resetGpuHealth(): void {
    this.lastGpuHealthCheck = 0;
    this.gpuHealthy = true;  // Optimistically assume healthy
  }

  /**
   * Get circuit breaker status for monitoring/health endpoints.
   */
  getCircuitBreakerStatus(): {
    gpu: { state: CircuitState; failures: number; lastFailure: number | null } | null;
    cpu: { state: CircuitState; failures: number; lastFailure: number | null } | null;
  } {
    return {
      gpu: this.gpuClient?.getCircuitState() ?? null,
      cpu: this.cpuClient?.getCircuitState() ?? null,
    };
  }

  /**
   * Reset circuit breakers (for manual recovery after outage is resolved).
   */
  resetCircuitBreakers(): void {
    this.gpuClient?.resetCircuit();
    this.cpuClient?.resetCircuit();
    ttsLogger.info('All circuit breakers reset');
  }

  /**
   * Stream synthesis using self-hosted service.
   * Yields chunks as they're synthesized for progressive playback.
   */
  async *synthesizeStream(
    voice: DBVoice,
    text: string,
    options?: { speed?: number }
  ): AsyncGenerator<TTSStreamChunk> {
    // Streaming only supported by self-hosted provider
    if (!this.hasProvider('selfhosted')) {
      throw new TTSProviderError('None', 'Streaming requires self-hosted TTS service');
    }

    const selfHostedVoiceId = this.mapToSelfHostedVoice(voice.provider_voice_id);

    ttsLogger.info(
      { voiceId: selfHostedVoiceId, textLength: text.length },
      'Starting streaming TTS synthesis'
    );

    const selfHostedClient = this.getProvider('selfhosted') as SelfHostedClient;

    yield* selfHostedClient.synthesizeStream({
      text,
      voiceId: selfHostedVoiceId,
      settings: voice.settings,
      speed: options?.speed,
    });
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const ttsProvider = new TTSProviderManager();

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Estimate cost for TTS synthesis (in USD).
 */
export function estimateCost(provider: TTSProvider, characters: number): number {
  const ratesPerMillion: Record<TTSProvider, number> = {
    selfhosted: 1,     // ~$0.001 per 1000 chars (infrastructure cost only)
    mock: 0,           // Free (testing only)
  };

  const rate = ratesPerMillion[provider] ?? 0;
  return (characters / 1_000_000) * rate;
}

/**
 * Estimate audio duration from character count.
 * Rough estimate: ~150 words per minute, ~5 chars per word = 750 chars/min
 */
export function estimateDurationMs(characters: number, speed = 1.0): number {
  const charsPerMinute = 750 * speed;
  const minutes = characters / charsPerMinute;
  return Math.round(minutes * 60 * 1000);
}
