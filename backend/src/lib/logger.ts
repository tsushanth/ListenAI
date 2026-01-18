import pino from 'pino';
import { config } from './config.js';

// ============================================================================
// Logger Configuration
// ============================================================================

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
    paths: ['req.headers.authorization', 'req.headers.cookie'],
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
