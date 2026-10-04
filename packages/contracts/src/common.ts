import { z } from 'zod';

/** Stable machine-readable error envelope returned by every API endpoint. */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * Money amount in santim (1 ETB = 100 santim). Integers only, never floats.
 * Limited to the JavaScript safe-integer range for transport as JSON numbers.
 */
export const SantimSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type Santim = z.infer<typeof SantimSchema>;
