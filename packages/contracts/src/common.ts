import { z } from 'zod';

/** Error codes shared by every endpoint. Feature phases add their own codes. */
export const COMMON_ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

/**
 * Stable machine-readable error envelope returned by every API endpoint.
 * `message` is safe to show to users and never contains internal details.
 * `requestId` matches the `x-request-id` response header and the server logs.
 */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * Money amount in santim (1 ETB = 100 santim). Integers only, never floats.
 * Limited to the JavaScript safe-integer range for transport as JSON numbers.
 */
export const SantimSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type Santim = z.infer<typeof SantimSchema>;
