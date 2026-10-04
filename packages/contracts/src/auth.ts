import { z } from 'zod';

export const AudienceSchema = z.enum(['rider', 'staff']);
export const ChannelSchema = z.enum(['sms', 'email']);
export const ClientSchema = z.enum(['mobile', 'web']);

/** Destination as typed by the user; the server normalizes it (E.164 / lower-case email). */
export const OtpRequestSchema = z.object({
  audience: AudienceSchema,
  channel: ChannelSchema,
  destination: z.string().trim().min(3).max(254),
});
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpRequestResponseSchema = z.object({
  challengeId: z.uuid(),
  expiresAt: z.iso.datetime(),
  resendAvailableAt: z.iso.datetime(),
});

export const OtpVerifySchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  client: ClientSchema,
  /** Staff with a confirmed authenticator must also send the current TOTP code. */
  totpCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const SubjectSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rider'),
    riderId: z.uuid(),
    needsOnboarding: z.boolean(),
  }),
  z.object({
    type: z.literal('staff'),
    staffId: z.uuid(),
    roles: z.array(z.string()),
  }),
]);

/** Mobile clients receive tokens in the body; web clients receive cookies + csrfToken. */
export const SessionResponseSchema = z.object({
  sessionId: z.uuid(),
  subject: SubjectSchema,
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  accessTokenExpiresAt: z.iso.datetime(),
  sessionExpiresAt: z.iso.datetime(),
  csrfToken: z.string().optional(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(10).max(200).optional(),
});

export const RiderProfileSchema = z.object({
  id: z.uuid(),
  displayName: z.string().nullable(),
  preferredLanguage: z.string(),
  status: z.enum(['active', 'suspended', 'deletion_requested', 'deleted']),
  termsVersion: z.string().nullable(),
  termsAcceptedAt: z.iso.datetime().nullable(),
  contacts: z.array(
    z.object({ kind: z.enum(['email', 'phone']), value: z.string(), verifiedAt: z.iso.datetime() }),
  ),
});
export type RiderProfile = z.infer<typeof RiderProfileSchema>;

export const UpdateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    preferredLanguage: z.enum(['en', 'am']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'nothing to update');

export const AcceptTermsSchema = z.object({
  termsVersion: z.string().min(1).max(40),
  ageAttested: z.literal(true),
});

export const ContactChangeRequestSchema = z.object({
  channel: ChannelSchema,
  destination: z.string().trim().min(3).max(254),
});

export const ContactChangeVerifySchema = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
});

export const DeletionRequestSchema = z.object({ confirm: z.literal(true) });

export const SessionSummarySchema = z.object({
  id: z.uuid(),
  client: ClientSchema,
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
});

export const AUTH_ERROR_CODES = {
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  OTP_INVALID: 'OTP_INVALID',
  CHANNEL_UNAVAILABLE: 'CHANNEL_UNAVAILABLE',
  OTP_DELIVERY_FAILED: 'OTP_DELIVERY_FAILED',
  CSRF_FAILED: 'CSRF_FAILED',
  CONTACT_IN_USE: 'CONTACT_IN_USE',
  INVALID_DESTINATION: 'INVALID_DESTINATION',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  MFA_ENROLLMENT_REQUIRED: 'MFA_ENROLLMENT_REQUIRED',
} as const;
