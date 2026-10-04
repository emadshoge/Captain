import { COMMON_ERROR_CODES, type ErrorResponse } from '@captain/contracts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

/**
 * An error whose code and message are safe to return to clients. Anything
 * else thrown by a handler becomes a generic 500 response.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Client-safe responses for framework-level 4xx errors (body parsing, size, …). */
const CLIENT_ERRORS: Record<number, { code: string; message: string }> = {
  400: { code: COMMON_ERROR_CODES.BAD_REQUEST, message: 'The request could not be processed.' },
  401: { code: COMMON_ERROR_CODES.UNAUTHORIZED, message: 'Authentication is required.' },
  403: { code: COMMON_ERROR_CODES.FORBIDDEN, message: 'You do not have access to this resource.' },
  404: { code: COMMON_ERROR_CODES.NOT_FOUND, message: 'Resource not found.' },
  405: { code: COMMON_ERROR_CODES.METHOD_NOT_ALLOWED, message: 'Method not allowed.' },
  409: {
    code: COMMON_ERROR_CODES.CONFLICT,
    message: 'The request conflicts with the current state.',
  },
  413: { code: COMMON_ERROR_CODES.PAYLOAD_TOO_LARGE, message: 'The request body is too large.' },
  415: { code: COMMON_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, message: 'Unsupported content type.' },
  429: { code: COMMON_ERROR_CODES.RATE_LIMITED, message: 'Too many requests. Try again later.' },
};

const INTERNAL = {
  code: COMMON_ERROR_CODES.INTERNAL_ERROR,
  message: 'An unexpected error occurred.',
};

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  body: Omit<ErrorResponse['error'], 'requestId'>,
) {
  const payload: ErrorResponse = { error: { ...body, requestId: request.id } };
  return reply.code(statusCode).type('application/json').send(payload);
}

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      // Paths and messages only: never echo submitted values back.
      const issues = error.validation.map((issue) => ({
        path: issue.instancePath || '/',
        message: issue.message,
      }));
      request.log.info(
        { validationContext: error.validationContext, issues },
        'request validation failed',
      );
      return send(reply, request, 400, {
        code: COMMON_ERROR_CODES.VALIDATION_FAILED,
        message: 'The request is invalid.',
        details: { issues },
      });
    }

    if (error instanceof AppError) {
      const level = error.statusCode >= 500 ? 'error' : 'info';
      request.log[level]({ code: error.code, statusCode: error.statusCode }, 'application error');
      if (error.options.retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(error.options.retryAfterSeconds));
      }
      return send(reply, request, error.statusCode, {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response did not match its schema');
      return send(reply, request, 500, INTERNAL);
    }

    const status = error.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      const mapped = CLIENT_ERRORS[status] ?? CLIENT_ERRORS[400]!;
      request.log.info({ code: error.code, statusCode: status }, 'client error');
      return send(reply, request, status, mapped);
    }

    // Unexpected: log everything (redacted by the logger), return nothing internal.
    request.log.error({ err: error }, 'unhandled error');
    return send(reply, request, 500, INTERNAL);
  });

  app.setNotFoundHandler((request, reply) => send(reply, request, 404, CLIENT_ERRORS[404]!));
}
