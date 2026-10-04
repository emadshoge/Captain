import { randomUUID } from 'node:crypto';
import { PERMISSIONS } from '@captain/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStaffCommand } from '../src/cli/staff';
import { base32Decode, totpAt } from '../src/lib/totp';
import {
  bearer,
  buildTestApp,
  createHarness,
  destroyHarness,
  signInRider,
  signInStaff,
  postTestJournal,
  type Harness,
  type StaffSession,
  type TestApp,
} from './helpers';

let h: Harness;
const env = () => ({ APP_ENV: 'test', DATABASE_URL: h.db.url });
const provision = (email: string, role: 'admin' | 'operator') =>
  runStaffCommand(
    [
      'create',
      '--email',
      email,
      '--name',
      email.split('@')[0]!,
      '--role',
      role,
      '--reason',
      'test setup',
    ],
    env(),
  );

beforeAll(async () => {
  h = await createHarness();
  await provision('admin1@captain.et', 'admin');
  await provision('op1@captain.et', 'operator');
});
afterAll(async () => {
  await destroyHarness(h);
});

describe('permission catalogue', () => {
  it('matches the permissions table exactly', async () => {
    const { rows } = await h.pool.query<{ key: string }>(
      `select key from permissions order by key`,
    );
    expect(rows.map((r) => r.key)).toEqual([...PERMISSIONS].sort());
  });
});

describe('authorization matrix (backend enforcement)', () => {
  const ID = '00000000-0000-4000-8000-000000000000';
  // Every protected staff route with a body that would pass validation.
  const ROUTES: [method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown][] = [
    ['GET', '/v1/admin/staff'],
    [
      'POST',
      '/v1/admin/staff',
      {
        email: `x${randomUUID().slice(0, 6)}@captain.et`,
        displayName: 'X',
        roles: ['operator'],
        reason: 'matrix',
      },
    ],
    ['PATCH', `/v1/admin/staff/${ID}/status`, { status: 'suspended', reason: 'matrix' }],
    ['PUT', `/v1/admin/staff/${ID}/roles`, { roles: ['operator'], reason: 'matrix' }],
    ['POST', `/v1/admin/staff/${ID}/totp/reset`, { reason: 'matrix' }],
    ['GET', '/v1/admin/riders'],
    ['GET', `/v1/admin/riders/${ID}`],
    ['POST', `/v1/admin/riders/${ID}/suspend`, { reason: 'matrix' }],
    ['POST', `/v1/admin/riders/${ID}/unsuspend`, { reason: 'matrix' }],
    ['POST', `/v1/admin/riders/${ID}/complete-deletion`, { reason: 'matrix' }],
    ['GET', '/v1/admin/audit'],
  ];

  let t: TestApp;
  let admin: StaffSession;
  let operator: StaffSession;
  let riderToken: string;
  beforeAll(async () => {
    t = await buildTestApp(h);
    admin = await signInStaff(t, 'admin1@captain.et');
    operator = await signInStaff(t, 'op1@captain.et');
    riderToken = (await signInRider(t)).accessToken;
  });

  it.each(ROUTES)(
    '%s %s: anonymous 401, rider 403, operator 403, admin allowed',
    async (method, url, payload) => {
      const anonymous = await t.request({
        method,
        url,
        ...(payload ? { payload: payload as object } : {}),
      });
      expect(anonymous.statusCode).toBe(401);
      const rider = await t.request({
        method,
        url,
        headers: bearer(riderToken),
        ...(payload ? { payload: payload as object } : {}),
      });
      expect(rider.statusCode).toBe(403);
      const op = await operator.call(method, url, payload);
      expect(op.statusCode).toBe(403);
      expect(op.json().error.code).toBe('FORBIDDEN');
      const ad = await admin.call(method, url, payload);
      expect([401, 403]).not.toContain(ad.statusCode);
    },
  );

  it('authorizes before validating, so unauthorized callers learn nothing about schemas', async () => {
    const op = await operator.call('POST', '/v1/admin/staff', { nonsense: true });
    expect(op.statusCode).toBe(403);
    const anon = await t.request({
      method: 'POST',
      url: '/v1/admin/staff',
      payload: { nonsense: true },
    });
    expect(anon.statusCode).toBe(401);
    const rider = await t.request({
      method: 'PATCH',
      url: '/v1/rider/me',
      payload: { displayName: 5 },
    });
    expect(rider.statusCode).toBe(401);
  });

  it('lets any staff member read their own profile', async () => {
    const me = await operator.call('GET', '/v1/staff/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().roles).toEqual(['operator']);
    expect(me.json().permissions).not.toContain('staff.manage');
  });

  it('fails closed when a staff route forgets to declare a permission', async () => {
    const fresh = await buildTestApp(h);
    fresh.app.get('/v1/admin/test-unguarded', async () => ({ leaked: true }));
    fresh.app.get('/v1/operator/test-unguarded', async () => ({ leaked: true }));
    const a = await signInStaff(fresh, 'admin1@captain.et');
    for (const url of ['/v1/admin/test-unguarded', '/v1/operator/test-unguarded']) {
      const res = await a.call('GET', url);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('leaked');
    }
  });

  it('an operator cannot escalate by tampering with requests', async () => {
    const selfRoles = await operator.call('PUT', `/v1/admin/staff/${operator.staffId}/roles`, {
      roles: ['admin', 'operator'],
      reason: 'promote myself',
    });
    expect(selfRoles.statusCode).toBe(403);
    const forged = await t.request({
      method: 'GET',
      url: '/v1/admin/staff?role=admin&permission=staff.manage',
      headers: { cookie: operator.cookie, 'x-staff-role': 'admin' },
    });
    expect(forged.statusCode).toBe(403);
    const roles = await h.pool.query(`select role_key from staff_roles where staff_id = $1`, [
      operator.staffId,
    ]);
    expect(roles.rows).toEqual([{ role_key: 'operator' }]);
  });

  it('rejects staff cookie writes without CSRF even for admins', async () => {
    const res = await t.request({
      method: 'POST',
      url: `/v1/admin/riders/${ID}/suspend`,
      headers: { cookie: admin.cookie, origin: 'http://localhost:3002' },
      payload: { reason: 'no csrf' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_FAILED');
  });
});

describe('staff second factor (TOTP)', () => {
  it('blocks staff APIs until enrollment, then requires TOTP at every sign-in', async () => {
    await provision('mfa-admin@captain.et', 'admin');
    const t = await buildTestApp(h, { STAFF_MFA_REQUIRED: 'true' });

    const first = await signInStaff(t, 'mfa-admin@captain.et');
    expect((await first.call('GET', '/v1/staff/me')).json().mfaVerifiedThisSession).toBe(false);
    const blocked = await first.call('GET', '/v1/admin/staff');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const setup = await first.call('POST', '/v1/staff/me/totp/setup');
    expect(setup.statusCode).toBe(200);
    expect(setup.json().otpauthUri).toMatch(
      /^otpauth:\/\/totp\/Captain%3Amfa-admin%40captain.et\?secret=/,
    );
    const secret = base32Decode(setup.json().secret);
    const stored = (
      await h.pool.query(`select secret_ciphertext from staff_totp where staff_id = $1`, [
        first.staffId,
      ])
    ).rows[0];
    expect(stored.secret_ciphertext).not.toContain(setup.json().secret);

    const wrong = await first.call('POST', '/v1/staff/me/totp/confirm', {
      code: '000000' === totpAt(secret, t.now()) ? '111111' : '000000',
    });
    expect(wrong.statusCode).toBe(400);
    const confirm = await first.call('POST', '/v1/staff/me/totp/confirm', {
      code: totpAt(secret, t.now()),
    });
    expect(confirm.json()).toMatchObject({ mfaEnabled: true, mfaVerifiedThisSession: true });
    expect((await first.call('GET', '/v1/admin/staff')).statusCode).toBe(200);
    expect((await first.call('POST', '/v1/staff/me/totp/setup')).statusCode).toBe(409);

    // Next sign-in: email code alone is not enough.
    t.advance(61_000);
    await expect(signInStaff(t, 'mfa-admin@captain.et')).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 401 }),
    });
    t.advance(61_000);
    await expect(
      signInStaff(
        t,
        'mfa-admin@captain.et',
        '123456' === totpAt(secret, t.now()) ? '654321' : '123456',
      ),
    ).rejects.toThrow(/MFA_INVALID/);
    t.advance(61_000);
    const code = totpAt(secret, t.now());
    const second = await signInStaff(t, 'mfa-admin@captain.et', code);
    expect((await second.call('GET', '/v1/admin/staff')).statusCode).toBe(200);

    // The same TOTP code cannot be replayed.
    t.advance(61_000);
    await expect(signInStaff(t, 'mfa-admin@captain.et', code)).rejects.toThrow(/MFA_INVALID/);

    const audit = await h.pool.query(
      `select 1 from audit_log where action = 'staff.mfa.enrolled' and target_id = $1`,
      [first.staffId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('lets another admin reset a lost authenticator (sessions revoked, audited)', async () => {
    await provision('lost@captain.et', 'operator');
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'admin1@captain.et');
    const lost = await signInStaff(t, 'lost@captain.et');
    await lost.call('POST', '/v1/staff/me/totp/setup');
    const self = await admin.call('POST', `/v1/admin/staff/${admin.staffId}/totp/reset`, {
      reason: 'self reset',
    });
    expect(self.json().error.code).toBe('SELF_CHANGE_FORBIDDEN');
    const reset = await admin.call('POST', `/v1/admin/staff/${lost.staffId}/totp/reset`, {
      reason: 'phone lost',
    });
    expect(reset.statusCode).toBe(200);
    expect((await lost.call('GET', '/v1/staff/me')).statusCode).toBe(401);
  });
});

describe('staff management', () => {
  it('creates staff with audit, refuses duplicates, protects self and the last admin', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'admin1@captain.et');
    const created = await admin.call('POST', '/v1/admin/staff', {
      email: 'New.Op@Captain.ET',
      displayName: 'New Op',
      roles: ['operator'],
      reason: 'hired for pilot',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      email: 'new.op@captain.et',
      roles: ['operator'],
      mfaEnabled: false,
    });
    const audit = (
      await h.pool.query(
        `select * from audit_log where action = 'staff.created' and target_id = $1`,
        [created.json().id],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      actor_type: 'staff',
      actor_staff_id: admin.staffId,
      reason: 'hired for pilot',
    });
    expect(audit.request_id).toBeTruthy();

    const dup = await admin.call('POST', '/v1/admin/staff', {
      email: 'new.op@captain.et',
      displayName: 'Dup',
      roles: ['operator'],
      reason: 'dup',
    });
    expect(dup.json().error.code).toBe('STAFF_EXISTS');

    expect(
      (
        await admin.call('PATCH', `/v1/admin/staff/${admin.staffId}/status`, {
          status: 'disabled',
          reason: 'oops',
        })
      ).json().error.code,
    ).toBe('SELF_CHANGE_FORBIDDEN');
    expect(
      (
        await admin.call('PUT', `/v1/admin/staff/${admin.staffId}/roles`, {
          roles: ['operator'],
          reason: 'oops',
        })
      ).json().error.code,
    ).toBe('SELF_CHANGE_FORBIDDEN');
    expect(
      (
        await admin.call('POST', '/v1/admin/staff', {
          email: 'bad',
          displayName: 'x',
          roles: ['operator'],
          reason: 'ok',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await admin.call('POST', '/v1/admin/staff', {
          email: 'a@b.et',
          displayName: 'x',
          roles: ['root'],
          reason: 'ok',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await admin.call('POST', '/v1/admin/staff', {
          email: 'a@b.et',
          displayName: 'x',
          roles: ['operator'],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('disabling or suspending staff revokes their sessions', async () => {
    await provision('temp-op@captain.et', 'operator');
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'admin1@captain.et');
    const op = await signInStaff(t, 'temp-op@captain.et');
    const res = await admin.call('PATCH', `/v1/admin/staff/${op.staffId}/status`, {
      status: 'suspended',
      reason: 'investigation',
    });
    expect(res.json().status).toBe('suspended');
    expect((await op.call('GET', '/v1/staff/me')).statusCode).toBe(401);
  });

  it('never leaves the platform without an active admin', async () => {
    const t = await buildTestApp(h);
    // Temporarily let operators manage staff to reach the last-admin check.
    await h.pool.query(
      `insert into role_permissions (role_key, permission_key) values ('operator', 'staff.manage')`,
    );
    try {
      const { rows } = await h.pool.query<{ id: string }>(
        `select s.id from staff_users s join staff_roles r on r.staff_id = s.id
         where r.role_key = 'admin' and s.status = 'active'`,
      );
      // Leave exactly one active admin.
      await h.pool.query(`update staff_users set status = 'disabled' where id = any($1::uuid[])`, [
        rows.slice(1).map((r) => r.id),
      ]);
      const op = await signInStaff(t, 'op1@captain.et');
      const res = await op.call('PATCH', `/v1/admin/staff/${rows[0]!.id}/status`, {
        status: 'disabled',
        reason: 'test',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('LAST_ADMIN');
      const roles = await op.call('PUT', `/v1/admin/staff/${rows[0]!.id}/roles`, {
        roles: ['operator'],
        reason: 'test',
      });
      expect(roles.json().error.code).toBe('LAST_ADMIN');
      await h.pool.query(`update staff_users set status = 'active' where id = any($1::uuid[])`, [
        rows.slice(1).map((r) => r.id),
      ]);
    } finally {
      await h.pool.query(
        `delete from role_permissions where role_key = 'operator' and permission_key = 'staff.manage'`,
      );
    }
  });
});

describe('rider administration', () => {
  it('searches riders by phone (any format), email, id and name', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'admin1@captain.et');
    const rider = await signInRider(t, '+251911777888');
    await t.request({
      method: 'PATCH',
      url: '/v1/rider/me',
      headers: bearer(rider.accessToken),
      payload: { displayName: 'Selam Tesfaye' },
    });
    for (const q of ['0911777888', '+251 911 777 888', rider.subject.riderId, 'selam']) {
      const res = await admin.call('GET', `/v1/admin/riders?q=${encodeURIComponent(q)}`);
      expect(res.json().map((r: { id: string }) => r.id)).toContain(rider.subject.riderId);
    }
    const none = await admin.call('GET', `/v1/admin/riders?q=${encodeURIComponent('%')}`);
    expect(none.statusCode).toBe(200);
  });

  it('shows rider detail with wallet figures and audits the view', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'admin1@captain.et');
    const rider = await signInRider(t);
    const res = await admin.call('GET', `/v1/admin/riders/${rider.subject.riderId}`);
    expect(res.json()).toMatchObject({
      status: 'active',
      walletBalanceSantim: 0,
      heldSantim: 0,
      openRideId: null,
    });
    const audit = await h.pool.query(
      `select 1 from audit_log where action = 'rider.viewed' and target_id = $1 and actor_staff_id = $2`,
      [rider.subject.riderId, admin.staffId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('suspends and unsuspends with reasons; suspension ends rider sessions', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'admin1@captain.et');
    const rider = await signInRider(t);
    const id = rider.subject.riderId;
    expect((await admin.call('POST', `/v1/admin/riders/${id}/suspend`, {})).statusCode).toBe(400); // reason required
    const s = await admin.call('POST', `/v1/admin/riders/${id}/suspend`, {
      reason: 'fraud review',
    });
    expect(s.json().status).toBe('suspended');
    expect(
      (await t.request({ method: 'GET', url: '/v1/rider/me', headers: bearer(rider.accessToken) }))
        .statusCode,
    ).toBe(401);
    expect(
      (await admin.call('POST', `/v1/admin/riders/${id}/suspend`, { reason: 'again' })).json().error
        .code,
    ).toBe('INVALID_STATE');
    const u = await admin.call('POST', `/v1/admin/riders/${id}/unsuspend`, { reason: 'cleared' });
    expect(u.json().status).toBe('active');
    const trail = await admin.call('GET', `/v1/admin/audit?targetType=rider&targetId=${id}`);
    expect(trail.json().entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['rider.suspended', 'rider.unsuspended']),
    );
  });

  it('completes deletion only when nothing is open; keeps the ledger; frees the contact', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'admin1@captain.et');
    const rider = await signInRider(t, '+251922333444');
    const id = rider.subject.riderId;

    expect(
      (
        await admin.call('POST', `/v1/admin/riders/${id}/complete-deletion`, {
          reason: 'x request',
        })
      ).json().error.code,
    ).toBe('INVALID_STATE');
    await t.request({
      method: 'POST',
      url: '/v1/rider/me/deletion-request',
      headers: bearer(rider.accessToken),
      payload: { confirm: true },
    });

    // A remaining balance blocks completion.
    await postTestJournal(h.pool, id, 700);
    const blocked = await admin.call('POST', `/v1/admin/riders/${id}/complete-deletion`, {
      reason: 'requested',
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatchObject({
      code: 'DELETION_BLOCKED',
      details: { blockers: ['wallet_balance_not_zero'] },
    });

    // Settle the balance with a compensating entry, then complete.
    await postTestJournal(h.pool, id, -700, 'refunds', 'refund');
    const done = await admin.call('POST', `/v1/admin/riders/${id}/complete-deletion`, {
      reason: 'rider request',
    });
    expect(done.json()).toMatchObject({ status: 'deleted', displayName: null, contacts: [] });
    const lines = await h.pool.query(
      `select count(*)::int n from ledger_lines l join ledger_accounts a on a.id = l.account_id where a.rider_id = $1`,
      [id],
    );
    expect(lines.rows[0].n).toBe(2); // financial history retained

    t.advance(61_000);
    const reborn = await signInRider(t, '+251922333444');
    expect(reborn.subject.riderId).not.toBe(id);
  });
});

describe('audit trail', () => {
  it('filters and paginates newest first', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'admin1@captain.et');
    const page1 = await admin.call('GET', '/v1/admin/audit?limit=2');
    expect(page1.json().entries).toHaveLength(2);
    const [a, b] = page1.json().entries;
    expect(a.id).toBeGreaterThan(b.id);
    const page2 = await admin.call(
      'GET',
      `/v1/admin/audit?limit=2&before=${page1.json().nextBefore}`,
    );
    expect(page2.json().entries[0].id).toBeLessThan(b.id);
    const logins = await admin.call(
      'GET',
      `/v1/admin/audit?action=staff.login&actorStaffId=${admin.staffId}`,
    );
    expect(logins.json().entries.every((e: { action: string }) => e.action === 'staff.login')).toBe(
      true,
    );
  });
});
