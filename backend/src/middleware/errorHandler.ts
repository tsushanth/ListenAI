import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';
import { config } from '../lib/config.js';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  QuotaExceededError,
  ValidationError,
  NotFoundError,
  TTSProviderError,
} from '../types/index.js';

// ============================================================================
// Error Response Interface
// ============================================================================

interface ErrorResponse {
  error: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
}

// ============================================================================
// Error Handler Middleware
// ============================================================================

/**
 * Central error handling middleware.
 * Converts errors to appropriate HTTP responses.
 */
export const errorHandler: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Default values
  let statusCode = 500;
  let errorCode = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';
  let details: Record<string, unknown> | undefined;

  // Handle known error types
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    errorCode = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = 'Invalid request data';
    details = { errors: err.flatten().fieldErrors };
  } else if (err.name === 'SyntaxError' && 'body' in err) {
    // JSON parse error
    statusCode = 400;
    errorCode = 'INVALID_JSON';
    message = 'Invalid JSON in request body';
  }

  // Log the error
  const logData = {
    statusCode,
    errorCode,
    message,
    path: req.path,
    method: req.method,
    userId: (req as { user?: { id: string } }).user?.id,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    details,
  };

  if (statusCode >= 500) {
    logger.error({ ...logData, stack: err.stack }, 'Server error');
  } else if (statusCode >= 400) {
    logger.warn(logData, 'Client error');
  }

  // Build response
  const response: ErrorResponse = {
    error: errorCode,
    message,
  };

  if (details) {
    response.details = details;
  }

  // Include stack trace in development
  if (config.NODE_ENV === 'development' && err.stack) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

// ============================================================================
// Not Found Handler
// ============================================================================

/**
 * Handler for undefined routes.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.path} not found`,
  });
}

// ============================================================================
// Async Handler Wrapper
// ============================================================================

/**
 * Wrapper for async route handlers to ensure errors are passed to error middleware.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
