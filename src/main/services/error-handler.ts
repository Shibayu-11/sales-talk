import type { AppError } from '@shared/types';
import { AppErrorSchema } from '@shared/schemas';
import { logger } from '../logger';
import { maskPiiInObject } from './pii';

export interface ErrorNotificationTarget {
  send(channel: string, payload: AppError): void;
}

export interface ErrorHandlerOptions {
  notify?: (error: AppError) => void;
  captureException?: (error: AppError) => void;
  captureEvent?: (eventName: string, properties: Record<string, unknown>) => void;
}

export class ErrorHandler {
  constructor(private readonly options: ErrorHandlerOptions = {}) {}

  handle(input: AppError): AppError {
    const error = AppErrorSchema.parse({
      ...input,
      context: input.context ? maskPiiInObject(input.context) : undefined,
    });

    switch (error.severity) {
      case 'critical':
        logger.fatal({ appError: error }, error.message);
        this.options.captureException?.(error);
        this.options.notify?.(error);
        break;
      case 'high':
        logger.error({ appError: error }, error.message);
        this.options.captureException?.(error);
        this.options.notify?.(error);
        break;
      case 'medium':
        logger.warn({ appError: error }, error.message);
        this.options.captureEvent?.('system_degraded', errorToProperties(error));
        break;
      case 'low':
        logger.info({ appError: error }, error.message);
        this.options.captureEvent?.('system_low_severity', errorToProperties(error));
        break;
    }

    return error;
  }
}

function errorToProperties(error: AppError): Record<string, unknown> {
  return {
    severity: error.severity,
    category: error.category,
    code: error.code,
    recoverable: error.recoverable,
    recoveryAction: error.recoveryAction,
  };
}

export const errorHandler = new ErrorHandler();
