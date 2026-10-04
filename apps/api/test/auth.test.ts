import { createServer } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LogOnlySender, SmtpEmailSender, UnavailableSender } from '../src/auth/senders';
import { runStaffCommand } from '../src/cli/staff';
import {
  WEB_ORIGIN,
  bearer,
  buildTestApp,
  createHarness,
  destroyHarness,
  signInRider,
  type Harness,
  type TestApp,
} from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await destroyHarness(h);
});

const otpRequest = (t: TestApp, destination: string, extra: Record<string, unknown> = {}) =>
  t.request({
    method: 'POST',
    url: '/v1/auth/otp/request',
    payload: { audience: 'rider', channel: 'sms', destination, ...extra },
  });
const otpVerify = (
  t: TestApp,
  challengeId: string,
  code: string | undefined,
  client = 'mobile',
  headers = {},
) =>
  t.request({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { challengeId, code, client },
    headers,
  });

describe('rider sign-up and sign-in (SMS, log-only sender)', () => {
  it('creates the rider, a verified E.164 contact and a wallet, and returns mobile tokens', async () => {
    const t = await buildTestApp(h);
    const req = await otpRequest(t, '0911 22 33 44');
    expect(req.statusCode).toBe(202);
    const code = t.lastCode('+251911223344');
    expect(code).toMatch(/^\d{6}$/);

    const res = await otpVerify(t, req.json().challengeId, code);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toMatch(/^cat_/);
    expect(body.refreshToken).toMatch(/^crt_/);
    expect(body.csrfToken).toBeUndefined();
    expect(body.subject).toMatchObject({ type: 'rider', needsOnboarding: true });

    const me = await t.request({
      method: 'GET',
      url: '/v1/rider/me',
      headers: bearer(body.accessToken),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().contacts).toEqual([
      expect.objectContaining({ kind: 'phone', value: '+251911223344' }),
    ]);
    const wallet = await h.pool.query(
      `select 1 from ledger_accounts where rider_id = $1 and type = 'rider_wallet'`,
      [body.subject.riderId],
    );
    expect(wallet.rowCount).toBe(1);

    // Same number again signs in to the same rider.
    t.advance(61_000);
    const again = await otpRequest(t, '+251911223344');
    const second = await otpVerify(t, again.json().challengeId, t.lastCode('+251911223344'));
    expect(second.json().subject.riderId).toBe(body.subject.riderId);

    // Onboarding: terms + age attestation.
    const terms = await t.request({
      method: 'POST',
      url: '/v1/rider/me/terms',
      headers: bearer(body.accessToken),
      payload: { termsVersion: 'DRAFT-2026-10', ageAttested: true },
    });
    expect(terms.json().termsVersion).toBe('DRAFT-2026-10');
  });

  it('stores only a hash of the code and never logs it', async () => {
    const t = await buildTestApp(h);
    const phone = '+251922000111';
    const req = await otpRequest(t, phone);
    const code = t.lastCode(phone)!;
    const row = (
      await h.pool.query(`select * from otp_challenges where id = $1`, [req.json().challengeId])
    ).rows[0];
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.lines.join('')).not.toContain(code);
  });

  it.each(['12345', '+1 202 555 0100', 'abc', '0811223344'])(
    'rejects invalid Ethiopian number %j',
    async (dest) => {
      const t = await buildTestApp(h);
      const res = await otpRequest(t, dest);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_DESTINATION');
    },
  );
});

describe('OTP abuse controls', () => {
  it('counts wrong codes, locks after max attempts, and rejects expired or reused codes', async () => {
    const t = await buildTestApp(h, { OTP_MAX_ATTEMPTS: '3' });
    const phone = '+251933000001';
    const { challengeId } = (await otpRequest(t, phone)).json();
    const code = t.lastCode(phone)!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 3; i++) {
      const res = await otpVerify(t, challengeId, wrong);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('OTP_INVALID');
    }
    const attempts = (
      await h.pool.query(`select attempts from otp_challenges where id = $1`, [challengeId])
    ).rows[0];
    expect(attempts.attempts).toBe(3);
    expect((await otpVerify(t, challengeId, code)).statusCode).toBe(400); // exhausted

    t.advance(61_000);
    const second = (await otpRequest(t, phone)).json();
    const code2 = t.lastCode(phone)!;
    t.advance(301_000); // past OTP_TTL_SECONDS
    expect((await otpVerify(t, second.challengeId, code2)).statusCode).toBe(400);

    t.advance(61_000);
    const third = (await otpRequest(t, phone)).json();
    const code3 = t.lastCode(phone)!;
    expect((await otpVerify(t, third.challengeId, code3)).statusCode).toBe(200);
    expect((await otpVerify(t, third.challengeId, code3)).statusCode).toBe(400); // single use
  });

  it('enforces the resend cooldown with Retry-After', async () => {
    const t = await buildTestApp(h);
    const phone = '+251944000002';
    expect((await otpRequest(t, phone)).statusCode).toBe(202);
    const blocked = await otpRequest(t, phone);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    t.advance(60_000);
    expect((await otpRequest(t, phone)).statusCode).toBe(202);
  });

  it('rate-limits requests per destination per hour', async () => {
    const t = await buildTestApp(h, { OTP_RESEND_COOLDOWN_SECONDS: '15' });
    const phone = '+251955000003';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await otpRequest(t, phone)).statusCode);
      t.advance(16_000);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('rejects channels not offered or not configured', async () => {
    const emailOnly = await buildTestApp(h, { AUTH_RIDER_CHANNELS: 'email' });
    const r1 = await otpRequest(emailOnly, '+251966000004');
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe('CHANNEL_UNAVAILABLE');

    const noSms = await buildTestApp(
      h,
      {},
      { sms: new UnavailableSender('sms'), email: new LogOnlySender('email') },
    );
    const r2 = await otpRequest(noSms, '+251966000005');
    expect(r2.statusCode).toBe(503);
    expect(r2.json().error.code).toBe('CHANNEL_UNAVAILABLE');
  });

  it('removes the challenge and returns 503 when delivery fails', async () => {
    const failing = new LogOnlySender('sms');
    failing.send = async () => {
      const { DeliveryError } = await import('../src/auth/senders');
      throw new DeliveryError('gateway down');
    };
    const t = await buildTestApp(h, {}, { sms: failing, email: new LogOnlySender('email') });
    const res = await otpRequest(t, '+251977000006');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('OTP_DELIVERY_FAILED');
    const rows = await h.pool.query(
      `select 1 from otp_challenges where destination = '+251977000006'`,
    );
    expect(rows.rowCount).toBe(0);
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes the session when an old refresh token is replayed', async () => {
    const t = await buildTestApp(h);
    const s = await signInRider(t);
    const r1 = await t.request({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    });
    expect(r1.statusCode).toBe(200);
    const next = r1.json();
    expect(next.refreshToken).not.toBe(s.refreshToken);

    const replay = await t.request({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('SESSION_REVOKED');
    // The whole session is gone, including the newest tokens.
    const me = await t.request({
      method: 'GET',
      url: '/v1/rider/me',
      headers: bearer(next.accessToken),
    });
    expect(me.json().error.code).toBe('SESSION_REVOKED');
  });

  it('expires access tokens (TOKEN_EXPIRED) and recovers via refresh', async () => {
    const t = await buildTestApp(h);
    const s = await signInRider(t);
    t.advance(901_000);
    const me = await t.request({
      method: 'GET',
      url: '/v1/rider/me',
      headers: bearer(s.accessToken),
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('TOKEN_EXPIRED');
    const r = await t.request({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    });
    const ok = await t.request({
      method: 'GET',
      url: '/v1/rider/me',
      headers: bearer(r.json().accessToken),
    });
    expect(ok.statusCode).toBe(200);
  });

  it('caps sessions at their absolute lifetime', async () => {
    const t = await buildTestApp(h, { RIDER_SESSION_MAX_DAYS: '1' });
    const s = await signInRider(t);
    t.advance(86_400_000 + 1_000);
    const r = await t.request({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: s.refreshToken },
    });
    expect(r.statusCode).toBe(401);
  });

  it('logs out, lists sessions, and cannot touch another rider’s session', async () => {
    const t = await buildTestApp(h);
    const a = await signInRider(t);
    const b = await signInRider(t);
    const list = await t.request({
      method: 'GET',
      url: '/v1/rider/me/sessions',
      headers: bearer(a.accessToken),
    });
    expect(list.json()).toEqual([expect.objectContaining({ id: a.sessionId, current: true })]);

    const steal = await t.request({
      method: 'DELETE',
      url: `/v1/rider/me/sessions/${b.sessionId}`,
      headers: bearer(a.accessToken),
    });
    expect(steal.statusCode).toBe(404);

    const out = await t.request({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: bearer(a.accessToken),
    });
    expect(out.statusCode).toBe(204);
    const after = await t.request({
      method: 'GET',
      url: '/v1/rider/me',
      headers: bearer(a.accessToken),
    });
    expect(after.json().error.code).toBe('SESSION_REVOKED');
    const bStill = await t.request({
      method: 'GET',
      url: '/v1/rider/me',
      headers: bearer(b.accessToken),
    });
    expect(bStill.statusCode).toBe(200);
  });

  it('rejects garbage and missing tokens', async () => {
    const t = await buildTestApp(h);
    for (const headers of [
      {},
      bearer('nope'),
      bearer(`cat_${'x'.repeat(43)}`),
      { authorization: 'Basic abc' },
    ]) {
      const res = await t.request({ method: 'GET', url: '/v1/rider/me', headers });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe('browser sessions: cookies, CSRF, CORS', () => {
  async function webSignIn(t: TestApp, phone: string) {
    const { challengeId } = (await otpRequest(t, phone)).json();
    const res = await otpVerify(t, challengeId, t.lastCode(phone), 'web', { origin: WEB_ORIGIN });
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies as {
      name: string;
      value: string;
      httpOnly?: boolean;
      sameSite?: string;
    }[];
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    return { body: res.json(), cookies, cookieHeader };
  }

  it('sets HttpOnly SameSite=Strict cookies and returns a CSRF token instead of bearer tokens', async () => {
    const t = await buildTestApp(h);
    const { body, cookies } = await webSignIn(t, '+251911000101');
    expect(body.accessToken).toBeUndefined();
    expect(body.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    expect(cookies.map((c) => c.name).sort()).toEqual(['captain_at', 'captain_rt']);
    for (const c of cookies) {
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe('Strict');
    }
  });

  it('uses __Host- cookies when COOKIE_SECURE=true', async () => {
    const t = await buildTestApp(h, { COOKIE_SECURE: 'true' });
    const { cookies } = await webSignIn(t, '+251911000102');
    expect(cookies.map((c) => c.name).sort()).toEqual(['__Host-captain_at', '__Host-captain_rt']);
  });

  it('requires the CSRF token and an allowed Origin for cookie-authenticated writes', async () => {
    const t = await buildTestApp(h);
    const { body, cookieHeader } = await webSignIn(t, '+251911000103');
    const patch = (headers: Record<string, string>) =>
      t.request({
        method: 'PATCH',
        url: '/v1/rider/me',
        headers: { cookie: cookieHeader, ...headers },
        payload: { displayName: 'Abebe' },
      });

    expect(
      (await t.request({ method: 'GET', url: '/v1/rider/me', headers: { cookie: cookieHeader } }))
        .statusCode,
    ).toBe(200);
    expect((await patch({ origin: WEB_ORIGIN })).json().error.code).toBe('CSRF_FAILED');
    expect(
      (await patch({ origin: WEB_ORIGIN, 'x-csrf-token': 'f'.repeat(64) })).json().error.code,
    ).toBe('CSRF_FAILED');
    expect(
      (await patch({ origin: 'https://evil.example', 'x-csrf-token': body.csrfToken })).statusCode,
    ).toBe(403);
    const ok = await patch({ origin: WEB_ORIGIN, 'x-csrf-token': body.csrfToken });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().displayName).toBe('Abebe');
  });

  it('refuses a web sign-in from a foreign origin (login CSRF)', async () => {
    const t = await buildTestApp(h);
    const phone = '+251911000104';
    const { challengeId } = (await otpRequest(t, phone)).json();
    const res = await otpVerify(t, challengeId, t.lastCode(phone), 'web', {
      origin: 'https://evil.example',
    });
    expect(res.statusCode).toBe(403);
  });

  it('answers CORS preflight only for configured origins', async () => {
    const t = await buildTestApp(h);
    const preflight = (origin: string) =>
      t.request({
        method: 'OPTIONS',
        url: '/v1/rider/me',
        headers: { origin, 'access-control-request-method': 'PATCH' },
      });
    const good = await preflight(WEB_ORIGIN);
    expect(good.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(good.headers['access-control-allow-credentials']).toBe('true');
    const bad = await preflight('https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends security headers', async () => {
    const t = await buildTestApp(h);
    const res = await t.request({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('account lifecycle', () => {
  it('blocks suspended riders at sign-in and on existing sessions', async () => {
    const t = await buildTestApp(h);
    const s = await signInRider(t);
    await h.pool.query(`update riders set status = 'suspended' where id = $1`, [s.subject.riderId]);
    const me = await t.request({
      method: 'GET',
      url: '/v1/rider/me',
      headers: bearer(s.accessToken),
    });
    expect(me.statusCode).toBe(403);
    expect(me.json().error.code).toBe('ACCOUNT_SUSPENDED');
    t.advance(61_000);
    const { challengeId } = (await otpRequest(t, s.phone)).json();
    const login = await otpVerify(t, challengeId, t.lastCode(s.phone));
    expect(login.json().error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('re-verifies new contacts and refuses contacts owned by another rider', async () => {
    const t = await buildTestApp(h);
    const a = await signInRider(t);
    const b = await signInRider(t);
    const add = async (token: string, email: string) => {
      const req = await t.request({
        method: 'POST',
        url: '/v1/rider/me/contacts/otp',
        headers: bearer(token),
        payload: { channel: 'email', destination: email },
      });
      expect(req.statusCode).toBe(202);
      return t.request({
        method: 'POST',
        url: '/v1/rider/me/contacts/verify',
        headers: bearer(token),
        payload: { challengeId: req.json().challengeId, code: t.lastCode(email.toLowerCase()) },
      });
    };
    const ok = await add(a.accessToken, 'Abebe@Example.ET');
    expect(ok.statusCode).toBe(200);
    expect(
      ok
        .json()
        .contacts.map((c: { value: string }) => c.value)
        .sort(),
    ).toEqual([a.phone, 'abebe@example.et'].sort());
    t.advance(61_000); // per-destination resend cooldown
    const conflict = await add(b.accessToken, 'abebe@example.et');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('CONTACT_IN_USE');

    // A contact-change code cannot be used to sign in, and vice versa.
    const req = await t.request({
      method: 'POST',
      url: '/v1/rider/me/contacts/otp',
      headers: bearer(b.accessToken),
      payload: { channel: 'email', destination: 'b@example.et' },
    });
    const login = await otpVerify(t, req.json().challengeId, t.lastCode('b@example.et'));
    expect(login.statusCode).toBe(400);
  });

  it('starts deletion: status changes, all sessions end, audit row written', async () => {
    const t = await buildTestApp(h);
    t.lines.length = 0;
    const s = await signInRider(t);
    const res = await t.request({
      method: 'POST',
      url: '/v1/rider/me/deletion-request',
      headers: bearer(s.accessToken),
      payload: { confirm: true },
    });
    expect(res.statusCode).toBe(202);
    const rider = (
      await h.pool.query(`select status from riders where id = $1`, [s.subject.riderId])
    ).rows[0];
    expect(rider.status).toBe('deletion_requested');
    const me = await t.request({
      method: 'GET',
      url: '/v1/rider/me',
      headers: bearer(s.accessToken),
    });
    expect(me.statusCode).toBe(401);
    const audit = await h.pool.query(
      `select 1 from audit_log where action = 'rider.deletion_requested' and actor_rider_id = $1`,
      [s.subject.riderId],
    );
    expect(audit.rowCount).toBe(1);
  });
});

describe('staff authentication', () => {
  it('provisions staff only via the CLI and audits it', async () => {
    const env = { APP_ENV: 'test', DATABASE_URL: h.db.url };
    await expect(
      runStaffCommand(
        [
          'create',
          '--email',
          'Ops@Captain.ET',
          '--name',
          'Ops',
          '--role',
          'operator',
          '--reason',
          'pilot ops',
        ],
        env,
      ),
    ).resolves.toMatch(/created staff ops@captain.et/);
    await expect(
      runStaffCommand(
        [
          'create',
          '--email',
          'ops@captain.et',
          '--name',
          'Ops',
          '--role',
          'operator',
          '--reason',
          'dup',
        ],
        env,
      ),
    ).rejects.toThrow(/already exists/);
    await expect(
      runStaffCommand(
        [
          'create',
          '--email',
          'x@captain.et',
          '--name',
          'X',
          '--role',
          'root',
          '--reason',
          'testing',
        ],
        env,
      ),
    ).rejects.toThrow(/admin or operator/);
    await expect(
      runStaffCommand(['create', '--email', 'y@captain.et', '--name', 'Y', '--role', 'admin'], env),
    ).rejects.toThrow(/reason/);
    const audit = await h.pool.query(
      `select reason from audit_log where action = 'staff.provisioned'`,
    );
    expect(audit.rows[0].reason).toBe('cli: pilot ops');
  });

  it('signs staff in by email on the web only, with roles; unknown emails reveal nothing', async () => {
    const env = { APP_ENV: 'test', DATABASE_URL: h.db.url };
    await runStaffCommand(
      [
        'create',
        '--email',
        'admin@captain.et',
        '--name',
        'Admin',
        '--role',
        'admin',
        '--reason',
        'test admin',
      ],
      env,
    );
    const t = await buildTestApp(h);

    const unknown = await t.request({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { audience: 'staff', channel: 'email', destination: 'nobody@captain.et' },
    });
    expect(unknown.statusCode).toBe(202);
    expect(t.lastCode('nobody@captain.et')).toBeUndefined();
    const bogus = await otpVerify(t, unknown.json().challengeId, '123456', 'web', {
      origin: WEB_ORIGIN,
    });
    expect(bogus.statusCode).toBe(400);

    const smsStaff = await t.request({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { audience: 'staff', channel: 'sms', destination: '+251911000999' },
    });
    expect(smsStaff.statusCode).toBe(400);

    const req = await t.request({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { audience: 'staff', channel: 'email', destination: 'admin@captain.et' },
    });
    const code = t.lastCode('admin@captain.et');
    const mobile = await otpVerify(t, req.json().challengeId, code, 'mobile');
    expect(mobile.statusCode).toBe(400); // staff are web-only; code stays unconsumed
    const web = await otpVerify(t, req.json().challengeId, code, 'web', { origin: WEB_ORIGIN });
    expect(web.statusCode).toBe(200);
    expect(web.json().subject).toMatchObject({ type: 'staff', roles: ['admin'] });

    const cookie = (web.cookies as { name: string; value: string }[])
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const session = await t.request({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie },
    });
    expect(session.json().permissions).toContain('staff.manage');
    // A staff session cannot use rider endpoints.
    const riderRoute = await t.request({ method: 'GET', url: '/v1/rider/me', headers: { cookie } });
    expect(riderRoute.statusCode).toBe(403);
  });

  it('disabling a staff member revokes their sessions', async () => {
    const env = { APP_ENV: 'test', DATABASE_URL: h.db.url };
    await runStaffCommand(
      [
        'create',
        '--email',
        'gone@captain.et',
        '--name',
        'Gone',
        '--role',
        'operator',
        '--reason',
        'temp',
      ],
      env,
    );
    const t = await buildTestApp(h);
    const req = await t.request({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { audience: 'staff', channel: 'email', destination: 'gone@captain.et' },
    });
    const web = await otpVerify(t, req.json().challengeId, t.lastCode('gone@captain.et'), 'web', {
      origin: WEB_ORIGIN,
    });
    const cookie = (web.cookies as { name: string; value: string }[])
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    await runStaffCommand(
      ['disable', '--email', 'gone@captain.et', '--reason', 'left company'],
      env,
    );
    const session = await t.request({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie },
    });
    expect(session.statusCode).toBe(401);
  });
});

describe('SMTP email adapter (real SMTP protocol against a local test server)', () => {
  it('delivers the OTP email over SMTP with authentication', async () => {
    const received: { from?: string; to: string[]; data: string; user?: string }[] = [];
    const server = new SMTPServer({
      authOptional: false,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      logger: false,
      onAuth(auth, _session, callback) {
        if (auth.username === 'captain' && auth.password === 'smtp-test-pass')
          return callback(null, { user: auth.username });
        return callback(new Error('bad credentials'));
      },
      onData(stream, session, callback) {
        let data = '';
        stream.on('data', (chunk: Buffer) => (data += chunk.toString()));
        stream.on('end', () => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined,
            to: session.envelope.rcptTo.map((r) => r.address),
            data,
            user: session.user as string | undefined,
          });
          callback();
        });
      },
    });
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    try {
      const smtpEnv = {
        OTP_EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(port),
        SMTP_USER: 'captain',
        SMTP_PASSWORD: 'smtp-test-pass',
        SMTP_REQUIRE_TLS: 'false',
        EMAIL_FROM: 'Captain <no-reply@captain.et>',
      };
      const base = await buildTestApp(h, smtpEnv);
      const sender = new SmtpEmailSender(base.config);
      const t = await buildTestApp(h, smtpEnv, { sms: new LogOnlySender('sms'), email: sender });
      const res = await t.request({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { audience: 'rider', channel: 'email', destination: 'Rider@Example.ET' },
      });
      expect(res.statusCode).toBe(202);
      expect(received).toHaveLength(1);
      expect(received[0]!.to).toEqual(['rider@example.et']);
      expect(received[0]!.user).toBe('captain');
      const code = /Your Captain code is (\d{6})/.exec(received[0]!.data)?.[1];
      expect(code).toMatch(/^\d{6}$/);
      const verify = await otpVerify(t, res.json().challengeId, code);
      expect(verify.statusCode).toBe(200);

      // Wrong SMTP password: request fails cleanly, nothing stored.
      const badSender = new SmtpEmailSender({ ...base.config, SMTP_PASSWORD: 'wrong' });
      const bad = await buildTestApp(h, smtpEnv, {
        sms: new LogOnlySender('sms'),
        email: badSender,
      });
      const failed = await bad.request({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { audience: 'rider', channel: 'email', destination: 'other@example.et' },
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error.code).toBe('OTP_DELIVERY_FAILED');
      expect(bad.lines.join('')).not.toContain('wrong');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('development outbox', () => {
  it('exists in test, not in staging', async () => {
    const t = await buildTestApp(h);
    await otpRequest(t, '+251988000007');
    const res = await t.request({
      method: 'GET',
      url: `/v1/dev/outbox?destination=${encodeURIComponent('+251988000007')}`,
    });
    expect(res.json()).toMatchObject({
      simulated: true,
      messages: [expect.objectContaining({ channel: 'sms' })],
    });

    const staging = await buildTestApp(h, {
      APP_ENV: 'staging',
      AUTH_SECRET: 's'.repeat(40),
      CORS_ORIGINS: 'https://staging.captain.et',
      COOKIE_SECURE: 'true',
      STAFF_MFA_REQUIRED: 'true',
      INTERNAL_API_TOKEN: 'i'.repeat(40),
      RIDE_BILLING_CUTOFF: 'end_request',
      RIDE_END_CONFIRMATION: 'device_lock',
      RIDE_PARKING_POLICY: 'flag',
    });
    const none = await staging.request({ method: 'GET', url: '/v1/dev/outbox?destination=x' });
    expect(none.statusCode).toBe(404);
  });
});
