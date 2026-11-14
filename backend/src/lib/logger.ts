import pino from 'pino';
import { config } from './config.js';

// ============================================================================
// Logger Configuration
// ============================================================================

// Credential-carrying request headers that must never reach a log line. `xi-api-key` is the ElevenLabs-style way
// to send the public rtts_ key (middleware/apiKeyAuth.ts); the authorization header can also carry one.
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["xi-api-key"]',
  'req.headers["x-gateway-admin-secret"]',
  'headers.authorization',
  'headers["xi-api-key"]',
];

export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  transport:
    config.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  base: {
    service: 'listenai-backend',
    env: config.NODE_ENV,
  },
  redact: {
    paths: LOG_REDACT_PATHS,
    censor: '[REDACTED]',
  },
});

// ============================================================================
// Child Loggers for Different Modules
// ============================================================================

export const authLogger = logger.child({ module: 'auth' });
export const ttsLogger = logger.child({ module: 'tts' });
export const usageLogger = logger.child({ module: 'usage' });
export const voicesLogger = logger.child({ module: 'voices' });
