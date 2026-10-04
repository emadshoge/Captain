import { sql } from 'drizzle-orm';
import {
  check,
  index,
  inet,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, ts, updatedAt } from './_common';

export const riderStatus = pgEnum('rider_status', [
  'active',
  'suspended',
  'deletion_requested',
  'deleted',
]);
export const staffStatus = pgEnum('staff_status', ['active', 'suspended', 'disabled']);
export const contactKind = pgEnum('contact_kind', ['email', 'phone']);
export const subjectType = pgEnum('subject_type', ['rider', 'staff']);
export const otpPurpose = pgEnum('otp_purpose', ['login', 'contact_change']);
export const otpChannel = pgEnum('otp_channel', ['email', 'sms']);
export const sessionClient = pgEnum('session_client', ['mobile', 'web']);
export const tokenKind = pgEnum('token_kind', ['access', 'refresh']);

export const riders = pgTable('riders', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name'),
  status: riderStatus('status').notNull().default('active'),
  statusReason: text('status_reason'),
  preferredLanguage: text('preferred_language').notNull().default('en'),
  termsVersion: text('terms_version'),
  termsAcceptedAt: ts('terms_accepted_at'),
  ageAttestedAt: ts('age_attested_at'),
  deletionRequestedAt: ts('deletion_requested_at'),
  deletedAt: ts('deleted_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Verified login identifiers. One email and one phone per rider at most. */
export const riderContacts = pgTable(
  'rider_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    riderId: uuid('rider_id')
      .notNull()
      .references(() => riders.id),
    kind: contactKind('kind').notNull(),
    value: text('value').notNull(),
    verifiedAt: ts('verified_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('rider_contacts_kind_value_uq').on(t.kind, t.value),
    uniqueIndex('rider_contacts_rider_kind_uq').on(t.riderId, t.kind),
    check(
      'rider_contacts_value_format',
      sql`(${t.kind} = 'email' and ${t.value} = lower(${t.value}) and ${t.value} like '%_@_%')
        or (${t.kind} = 'phone' and ${t.value} ~ '^\\+[1-9][0-9]{7,14}$')`,
    ),
  ],
);

export const staffUsers = pgTable(
  'staff_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    status: staffStatus('status').notNull().default('active'),
    createdByStaffId: uuid('created_by_staff_id'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('staff_users_email_uq').on(t.email),
    check(
      'staff_users_email_lower',
      sql`${t.email} = lower(${t.email}) and ${t.email} like '%_@_%'`,
    ),
  ],
);

export const roles = pgTable('roles', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
});

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })],
);

export const staffRoles = pgTable(
  'staff_roles',
  {
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staffUsers.id),
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key),
    grantedByStaffId: uuid('granted_by_staff_id').references(() => staffUsers.id),
    grantedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.roleKey] })],
);

/** One-time passcodes. Only a hash of the code is stored. */
export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectType: subjectType('subject_type').notNull(),
    purpose: otpPurpose('purpose').notNull(),
    channel: otpChannel('channel').notNull(),
    destination: text('destination').notNull(),
    riderId: uuid('rider_id').references(() => riders.id),
    staffId: uuid('staff_id').references(() => staffUsers.id),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    provider: text('provider').notNull(),
    ip: inet('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('otp_challenges_destination_idx').on(t.destination, t.createdAt),
    check('otp_challenges_attempts', sql`${t.attempts} >= 0 and ${t.attempts} <= ${t.maxAttempts}`),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectType: subjectType('subject_type').notNull(),
    riderId: uuid('rider_id').references(() => riders.id),
    staffId: uuid('staff_id').references(() => staffUsers.id),
    client: sessionClient('client').notNull(),
    expiresAt: ts('expires_at').notNull(),
    lastUsedAt: ts('last_used_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
    revokeReason: text('revoke_reason'),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'auth_sessions_subject',
      sql`(${t.subjectType} = 'rider' and ${t.riderId} is not null and ${t.staffId} is null)
        or (${t.subjectType} = 'staff' and ${t.staffId} is not null and ${t.riderId} is null)`,
    ),
    index('auth_sessions_rider_idx').on(t.riderId),
    index('auth_sessions_staff_idx').on(t.staffId),
  ],
);

/** Opaque bearer/refresh tokens; only SHA-256 hashes are stored. */
export const sessionTokens = pgTable(
  'session_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => authSessions.id),
    kind: tokenKind('kind').notNull(),
    expiresAt: ts('expires_at').notNull(),
    /** Refresh tokens are single-use; reuse indicates theft (session revoked). */
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('session_tokens_session_idx').on(t.sessionId)],
);

/** Fixed-window counters for rate limiting (PostgreSQL-backed; no Redis). */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    key: text('key').notNull(),
    windowStart: ts('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    index('rate_limit_buckets_window_idx').on(t.windowStart),
  ],
);
