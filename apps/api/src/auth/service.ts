import { randomUUID } from 'node:crypto';
import type { ApiConfig } from '@captain/config';
import { AUTH_ERROR_CODES, COMMON_ERROR_CODES } from '@captain/contracts';
import type pg from 'pg';
import { AppError } from '../errors';
import { normalizeEmail, normalizeEthiopianPhone } from '../lib/contacts';
import { generateOtpCode, hmacHex, randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { type Queryable, one, withTransaction } from '../lib/db';
import { RATE_LIMITS, enforceRateLimit } from '../lib/rate-limit';
import { type Channel, DeliveryError, type OtpSenders } from './senders';

export interface AuthDeps {
  config: ApiConfig;
  pool: pg.Pool;
  senders: OtpSenders;
  now: () => Date;
}

export type Audience = 'rider' | 'staff';
export type Client = 'mobile' | 'web';
export type Purpose = 'login' | 'contact_change';

export interface RequestMeta {
  ip: string;
  userAgent?: string;
}

/** Authenticated principal attached to a request. */
export type AuthContext =
  | { type: 'rider'; sessionId: string; riderId: string; client: Client; via: 'bearer' | 'cookie' }
  | {
      type: 'staff';
      sessionId: string;
      staffId: string;
      client: Client;
      via: 'bearer' | 'cookie';
      roles: string[];
      permissions: Set<string>;
    };

const INVALID_CODE = () =>
  new AppError(
    400,
    AUTH_ERROR_CODES.OTP_INVALID,
    'The code is incorrect or has expired. Request a new code.',
  );

export function normalizeDestination(channel: Channel, input: string): string {
  const value = channel === 'sms' ? normalizeEthiopianPhone(input) : normalizeEmail(input);
  if (!value) {
    throw new AppError(
      400,
      AUTH_ERROR_CODES.INVALID_DESTINATION,
      channel === 'sms' ? 'Enter a valid Ethiopian mobile number.' : 'Enter a valid email address.',
    );
  }
  return value;
}

function otpHash(secret: string, challengeId: string, code: string) {
  return hmacHex(secret, `otp:${challengeId}:${code}`);
}

export function csrfTokenFor(secret: string, sessionId: string) {
  return hmacHex(secret, `csrf:${sessionId}`);
}

// ---------------------------------------------------------------------------
// OTP request
// ---------------------------------------------------------------------------

export interface OtpRequestInput {
  audience: Audience;
  channel: Channel;
  destination: string;
  purpose?: Purpose;
  riderId?: string;
}

export interface OtpRequestResult {
  challengeId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
}

export async function requestOtp(
  deps: AuthDeps,
  input: OtpRequestInput,
  meta: RequestMeta,
): Promise<OtpRequestResult> {
  const { config, pool, senders } = deps;
  const now = deps.now();
  const purpose = input.purpose ?? 'login';

  if (input.audience === 'staff' && input.channel !== 'email') {
    throw new AppError(400, AUTH_ERROR_CODES.CHANNEL_UNAVAILABLE, 'Staff sign in with email.');
  }
  if (input.audience === 'rider' && !config.AUTH_RIDER_CHANNELS.includes(input.channel)) {
    throw new AppError(
      400,
      AUTH_ERROR_CODES.CHANNEL_UNAVAILABLE,
      'This sign-in method is not offered.',
    );
  }
  const sender = senders[input.channel];
  if (!sender.available) {
    throw new AppError(
      503,
      AUTH_ERROR_CODES.CHANNEL_UNAVAILABLE,
      'This sign-in method is temporarily unavailable.',
    );
  }

  const destination = normalizeDestination(input.channel, input.destination);
  await enforceRateLimit(pool, RATE_LIMITS.otpRequestPerIp, meta.ip, now);
  await enforceRateLimit(
    pool,
    RATE_LIMITS.otpRequestPerDestination,
    `${input.audience}:${destination}`,
    now,
  );

  const cooldownMs = config.OTP_RESEND_COOLDOWN_SECONDS * 1000;
  const latest = await one<{ created_at: Date }>(
    pool,
    `select created_at from otp_challenges
     where destination = $1 and subject_type = $2 and purpose = $3
     order by created_at desc limit 1`,
    [destination, input.audience, purpose],
  );
  if (latest && now.getTime() - latest.created_at.getTime() < cooldownMs) {
    const retryAfterSeconds = Math.ceil(
      (latest.created_at.getTime() + cooldownMs - now.getTime()) / 1000,
    );
    throw new AppError(
      429,
      COMMON_ERROR_CODES.RATE_LIMITED,
      'Please wait before requesting another code.',
      undefined,
      {
        retryAfterSeconds,
      },
    );
  }

  const expiresAt = new Date(now.getTime() + config.OTP_TTL_SECONDS * 1000);
  const resendAvailableAt = new Date(now.getTime() + cooldownMs);

  let staffId: string | null = null;
  if (input.audience === 'staff') {
    const staff = await one<{ id: string }>(
      pool,
      `select id from staff_users where email = $1 and status = 'active'`,
      [destination],
    );
    if (!staff) {
      // Unknown staff email: identical response, nothing stored or sent (no account enumeration).
      return { challengeId: randomUUID(), expiresAt, resendAvailableAt };
    }
    staffId = staff.id;
  }

  const challengeId = randomUUID();
  const code = generateOtpCode();
  await pool.query(
    `insert into otp_challenges (id, subject_type, purpose, channel, destination, rider_id, staff_id,
       code_hash, max_attempts, expires_at, provider, ip, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      challengeId,
      input.audience,
      purpose,
      input.channel,
      destination,
      input.riderId ?? null,
      staffId,
      otpHash(config.AUTH_SECRET, challengeId, code),
      config.OTP_MAX_ATTEMPTS,
      expiresAt,
      sender.provider,
      meta.ip,
      now,
    ],
  );

  try {
    await sender.send({ destination, code, ttlMinutes: Math.round(config.OTP_TTL_SECONDS / 60) });
  } catch (error) {
    // Nothing was delivered: remove the challenge so it neither works nor blocks a retry.
    await pool.query(`delete from otp_challenges where id = $1`, [challengeId]);
    if (error instanceof DeliveryError) {
      throw new AppError(
        503,
        AUTH_ERROR_CODES.OTP_DELIVERY_FAILED,
        'We could not send the code. Please try again.',
      );
    }
    throw error;
  }
  return { challengeId, expiresAt, resendAvailableAt };
}

// ---------------------------------------------------------------------------
// OTP verification (shared by login and contact change)
// ---------------------------------------------------------------------------

interface ChallengeRow {
  id: string;
  subject_type: Audience;
  purpose: Purpose;
  channel: Channel;
  destination: string;
  rider_id: string | null;
  staff_id: string | null;
  code_hash: string;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
}

/**
 * Checks a code inside the caller's transaction. Returns null when the code
 * is wrong/expired/exhausted. A wrong code increments `attempts` in the same
 * transaction, so callers must COMMIT and then throw (see `INVALID`).
 */
async function consumeChallenge(
  deps: AuthDeps,
  client: pg.PoolClient,
  challengeId: string,
  code: string,
  expected: { purpose: Purpose; audience?: Audience; riderId?: string },
): Promise<ChallengeRow | null> {
  const now = deps.now();
  const row = await one<ChallengeRow>(
    client,
    `select * from otp_challenges where id = $1 for update`,
    [challengeId],
  );
  if (
    !row ||
    row.purpose !== expected.purpose ||
    (expected.audience && row.subject_type !== expected.audience) ||
    (expected.riderId && row.rider_id !== expected.riderId) ||
    row.consumed_at !== null ||
    row.expires_at.getTime() <= now.getTime() ||
    row.attempts >= row.max_attempts
  ) {
    return null;
  }
  if (!safeEqual(otpHash(deps.config.AUTH_SECRET, row.id, code), row.code_hash)) {
    await client.query(`update otp_challenges set attempts = attempts + 1 where id = $1`, [row.id]);
    return null;
  }
  await client.query(`update otp_challenges set consumed_at = $2 where id = $1`, [row.id, now]);
  return row;
}

/** Sentinel: the transaction commits (keeping the attempt count), then we throw. */
const INVALID = Symbol('invalid-otp');

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  sessionExpiresAt: Date;
}

async function issueTokens(
  deps: AuthDeps,
  q: Queryable,
  sessionId: string,
  sessionExpiresAt: Date,
): Promise<Omit<IssuedSession, 'sessionId' | 'sessionExpiresAt'>> {
  const now = deps.now().getTime();
  const cap = (ms: number) => new Date(Math.min(now + ms, sessionExpiresAt.getTime()));
  const accessToken = randomToken('cat_');
  const refreshToken = randomToken('crt_');
  const accessTokenExpiresAt = cap(deps.config.ACCESS_TOKEN_TTL_SECONDS * 1000);
  const refreshTokenExpiresAt = cap(deps.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await q.query(
    `insert into session_tokens (token_hash, session_id, kind, expires_at) values ($1,$2,'access',$3), ($4,$2,'refresh',$5)`,
    [
      sha256Hex(accessToken),
      sessionId,
      accessTokenExpiresAt,
      sha256Hex(refreshToken),
      refreshTokenExpiresAt,
    ],
  );
  return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt };
}

async function createSession(
  deps: AuthDeps,
  q: Queryable,
  subject: { type: 'rider'; riderId: string } | { type: 'staff'; staffId: string },
  client: Client,
  meta: RequestMeta,
): Promise<IssuedSession> {
  const now = deps.now();
  const maxMs =
    subject.type === 'staff'
      ? deps.config.STAFF_SESSION_MAX_HOURS * 3_600_000
      : deps.config.RIDER_SESSION_MAX_DAYS * 86_400_000;
  const sessionExpiresAt = new Date(now.getTime() + maxMs);
  const sessionId = randomUUID();
  await q.query(
    `insert into auth_sessions (id, subject_type, rider_id, staff_id, client, expires_at, last_used_at, user_agent, ip, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7)`,
    [
      sessionId,
      subject.type,
      subject.type === 'rider' ? subject.riderId : null,
      subject.type === 'staff' ? subject.staffId : null,
      client,
      sessionExpiresAt,
      now,
      meta.userAgent?.slice(0, 300) ?? null,
      meta.ip,
    ],
  );
  const tokens = await issueTokens(deps, q, sessionId, sessionExpiresAt);
  return { sessionId, sessionExpiresAt, ...tokens };
}

export interface LoginResult {
  session: IssuedSession;
  subject:
    | { type: 'rider'; riderId: string; needsOnboarding: boolean }
    | { type: 'staff'; staffId: string; roles: string[] };
}

export async function verifyLogin(
  deps: AuthDeps,
  input: { challengeId: string; code: string; client: Client },
  meta: RequestMeta,
): Promise<LoginResult> {
  await enforceRateLimit(deps.pool, RATE_LIMITS.otpVerifyPerIp, meta.ip, deps.now());
  const result = await withTransaction(
    deps.pool,
    async (client): Promise<LoginResult | typeof INVALID> => {
      const challenge = await consumeChallenge(deps, client, input.challengeId, input.code, {
        purpose: 'login',
      });
      if (!challenge) return INVALID;

      if (challenge.subject_type === 'staff') {
        if (input.client !== 'web') {
          throw new AppError(
            400,
            COMMON_ERROR_CODES.BAD_REQUEST,
            'Staff sign in on the web dashboard.',
          );
        }
        const staff = await one<{ id: string; status: string }>(
          client,
          `select id, status from staff_users where id = $1`,
          [challenge.staff_id],
        );
        if (!staff || staff.status !== 'active') throw suspended();
        const roles = (
          await client.query<{ role_key: string }>(
            `select role_key from staff_roles where staff_id = $1`,
            [staff.id],
          )
        ).rows.map((r) => r.role_key);
        await client.query(`update staff_users set last_login_at = $2 where id = $1`, [
          staff.id,
          deps.now(),
        ]);
        const session = await createSession(
          deps,
          client,
          { type: 'staff', staffId: staff.id },
          input.client,
          meta,
        );
        await client.query(
          `insert into audit_log (actor_type, actor_staff_id, action, target_type, target_id, ip)
         values ('staff', $1::uuid, 'staff.login', 'staff_user', $1::text, $2)`,
          [staff.id, meta.ip],
        );
        return { session, subject: { type: 'staff', staffId: staff.id, roles } };
      }

      // Rider: find or create the account bound to this verified contact.
      const kind = challenge.channel === 'sms' ? 'phone' : 'email';
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [
        `contact:${kind}:${challenge.destination}`,
      ]);
      let rider = await one<{ id: string; status: string; terms_accepted_at: Date | null }>(
        client,
        `select r.id, r.status, r.terms_accepted_at from rider_contacts c join riders r on r.id = c.rider_id
       where c.kind = $1 and c.value = $2`,
        [kind, challenge.destination],
      );
      if (!rider) {
        rider = await one(
          client,
          `insert into riders default values returning id, status, terms_accepted_at`,
        );
        await client.query(
          `insert into rider_contacts (rider_id, kind, value, verified_at) values ($1,$2,$3,$4)`,
          [rider!.id, kind, challenge.destination, deps.now()],
        );
        await client.query(
          `insert into ledger_accounts (type, rider_id) values ('rider_wallet', $1)`,
          [rider!.id],
        );
      }
      if (rider!.status !== 'active') throw suspended();
      const session = await createSession(
        deps,
        client,
        { type: 'rider', riderId: rider!.id },
        input.client,
        meta,
      );
      return {
        session,
        subject: {
          type: 'rider',
          riderId: rider!.id,
          needsOnboarding: rider!.terms_accepted_at === null,
        },
      };
    },
  );
  if (result === INVALID) throw INVALID_CODE();
  return result;
}

function suspended() {
  return new AppError(
    403,
    AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
    'This account is not active. Contact support.',
  );
}

// ---------------------------------------------------------------------------
// Refresh rotation, revocation, authentication
// ---------------------------------------------------------------------------

export async function refreshSession(deps: AuthDeps, refreshToken: string, meta: RequestMeta) {
  await enforceRateLimit(deps.pool, RATE_LIMITS.refreshPerIp, meta.ip, deps.now());
  const outcome = await withTransaction(deps.pool, async (client) => {
    const row = await one<{
      session_id: string;
      used_at: Date | null;
      expires_at: Date;
      revoked_at: Date | null;
      session_expires_at: Date;
      subject_type: Audience;
      rider_id: string | null;
      staff_id: string | null;
      client: Client;
    }>(
      client,
      `select t.session_id, t.used_at, t.expires_at, s.revoked_at, s.expires_at as session_expires_at,
              s.subject_type, s.rider_id, s.staff_id, s.client
       from session_tokens t join auth_sessions s on s.id = t.session_id
       where t.token_hash = $1 and t.kind = 'refresh' for update of t, s`,
      [sha256Hex(refreshToken)],
    );
    const now = deps.now();
    if (!row) return { error: 'invalid' as const };
    if (row.revoked_at) return { error: 'revoked' as const };
    if (row.used_at) {
      // A rotated refresh token was replayed: assume theft, end the session.
      await client.query(
        `update auth_sessions set revoked_at = $2, revoke_reason = 'refresh_token_reuse' where id = $1`,
        [row.session_id, now],
      );
      return { error: 'reuse' as const };
    }
    if (row.expires_at <= now || row.session_expires_at <= now)
      return { error: 'invalid' as const };
    await assertSubjectActive(client, row.subject_type, row.rider_id ?? row.staff_id!);
    await client.query(`update session_tokens set used_at = $2 where token_hash = $1`, [
      sha256Hex(refreshToken),
      now,
    ]);
    await client.query(`update auth_sessions set last_used_at = $2 where id = $1`, [
      row.session_id,
      now,
    ]);
    const tokens = await issueTokens(deps, client, row.session_id, row.session_expires_at);
    return {
      session: { sessionId: row.session_id, sessionExpiresAt: row.session_expires_at, ...tokens },
      subjectType: row.subject_type,
      client: row.client,
    };
  });
  if ('error' in outcome) {
    if (outcome.error === 'invalid') {
      throw new AppError(
        401,
        COMMON_ERROR_CODES.UNAUTHORIZED,
        'Your session has ended. Please sign in again.',
      );
    }
    throw new AppError(
      401,
      AUTH_ERROR_CODES.SESSION_REVOKED,
      'Your session has ended. Please sign in again.',
    );
  }
  return outcome;
}

async function assertSubjectActive(q: Queryable, type: Audience, id: string) {
  const row = await one<{ status: string }>(
    q,
    type === 'rider'
      ? `select status from riders where id = $1`
      : `select status from staff_users where id = $1`,
    [id],
  );
  if (!row || row.status !== 'active') throw suspended();
}

export async function revokeSession(q: Queryable, sessionId: string, reason: string, now: Date) {
  await q.query(
    `update auth_sessions set revoked_at = $2, revoke_reason = $3 where id = $1 and revoked_at is null`,
    [sessionId, now, reason],
  );
}

export async function revokeAllSessions(
  q: Queryable,
  subject: { riderId: string } | { staffId: string },
  reason: string,
  now: Date,
) {
  const [column, id] =
    'riderId' in subject ? ['rider_id', subject.riderId] : ['staff_id', subject.staffId];
  await q.query(
    `update auth_sessions set revoked_at = $2, revoke_reason = $3 where ${column} = $1 and revoked_at is null`,
    [id, now, reason],
  );
}

/** Resolves an access token to its principal, or throws 401/403. */
export async function authenticateAccessToken(
  deps: AuthDeps,
  token: string,
  via: 'bearer' | 'cookie',
): Promise<AuthContext> {
  const unauthorized = () =>
    new AppError(401, COMMON_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.');
  if (!/^cat_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthorized();
  const row = await one<{
    session_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    session_expires_at: Date;
    subject_type: Audience;
    rider_id: string | null;
    staff_id: string | null;
    client: Client;
    last_used_at: Date;
    subject_status: string | null;
  }>(
    deps.pool,
    `select t.session_id, t.expires_at, s.revoked_at, s.expires_at as session_expires_at, s.subject_type,
            s.rider_id, s.staff_id, s.client, s.last_used_at,
            coalesce(r.status::text, st.status::text) as subject_status
     from session_tokens t
     join auth_sessions s on s.id = t.session_id
     left join riders r on r.id = s.rider_id
     left join staff_users st on st.id = s.staff_id
     where t.token_hash = $1 and t.kind = 'access'`,
    [sha256Hex(token)],
  );
  const now = deps.now();
  if (!row) throw unauthorized();
  if (row.revoked_at)
    throw new AppError(
      401,
      AUTH_ERROR_CODES.SESSION_REVOKED,
      'Your session has ended. Please sign in again.',
    );
  if (row.session_expires_at <= now) throw unauthorized();
  if (row.expires_at <= now)
    throw new AppError(401, AUTH_ERROR_CODES.TOKEN_EXPIRED, 'Your access token expired.');
  if (row.subject_status !== 'active') throw suspended();

  if (now.getTime() - row.last_used_at.getTime() > 60_000) {
    await deps.pool.query(`update auth_sessions set last_used_at = $2 where id = $1`, [
      row.session_id,
      now,
    ]);
  }
  if (row.subject_type === 'rider') {
    return {
      type: 'rider',
      sessionId: row.session_id,
      riderId: row.rider_id!,
      client: row.client,
      via,
    };
  }
  const perms = await deps.pool.query<{ role_key: string; permission_key: string | null }>(
    `select sr.role_key, rp.permission_key from staff_roles sr
     left join role_permissions rp on rp.role_key = sr.role_key where sr.staff_id = $1`,
    [row.staff_id],
  );
  return {
    type: 'staff',
    sessionId: row.session_id,
    staffId: row.staff_id!,
    client: row.client,
    via,
    roles: [...new Set(perms.rows.map((p) => p.role_key))],
    permissions: new Set(
      perms.rows.map((p) => p.permission_key).filter((p): p is string => p !== null),
    ),
  };
}

// ---------------------------------------------------------------------------
// Contact change (re-verification)
// ---------------------------------------------------------------------------

export async function verifyContactChange(
  deps: AuthDeps,
  riderId: string,
  input: { challengeId: string; code: string },
  meta: RequestMeta,
) {
  await enforceRateLimit(deps.pool, RATE_LIMITS.otpVerifyPerIp, meta.ip, deps.now());
  const result = await withTransaction(deps.pool, async (client) => {
    const challenge = await consumeChallenge(deps, client, input.challengeId, input.code, {
      purpose: 'contact_change',
      audience: 'rider',
      riderId,
    });
    if (!challenge) return INVALID;
    const kind = challenge.channel === 'sms' ? 'phone' : 'email';
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [
      `contact:${kind}:${challenge.destination}`,
    ]);
    const owner = await one<{ rider_id: string }>(
      client,
      `select rider_id from rider_contacts where kind = $1 and value = $2`,
      [kind, challenge.destination],
    );
    if (owner && owner.rider_id !== riderId) {
      throw new AppError(
        409,
        AUTH_ERROR_CODES.CONTACT_IN_USE,
        'This contact is already used by another account.',
      );
    }
    const previous = await one<{ value: string }>(
      client,
      `delete from rider_contacts where rider_id = $1 and kind = $2 returning value`,
      [riderId, kind],
    );
    await client.query(
      `insert into rider_contacts (rider_id, kind, value, verified_at) values ($1,$2,$3,$4)`,
      [riderId, kind, challenge.destination, deps.now()],
    );
    await client.query(
      `insert into audit_log (actor_type, actor_rider_id, action, target_type, target_id, before, after, ip)
       values ('rider', $1::uuid, 'rider.contact.changed', 'rider', $1::text, $2, $3, $4)`,
      [
        riderId,
        JSON.stringify({ kind, replaced: Boolean(previous) }),
        JSON.stringify({ kind }),
        meta.ip,
      ],
    );
    return { kind, value: challenge.destination };
  });
  if (result === INVALID) throw INVALID_CODE();
  return result;
}
