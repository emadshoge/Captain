import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStaffCommand } from '../src/cli/staff';
import {
  bearer,
  buildTestApp,
  createHarness,
  destroyHarness,
  signInRider,
  signInStaff,
  type Harness,
} from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await runStaffCommand(
    [
      'create',
      '--email',
      'inc-op@captain.et',
      '--name',
      'Op',
      '--role',
      'operator',
      '--reason',
      'tests',
    ],
    {
      APP_ENV: 'test',
      DATABASE_URL: h.db.url,
    },
  );
});
afterAll(async () => {
  await destroyHarness(h);
});

describe('incidents', () => {
  it('lets operators report, take and resolve incidents with an audit trail', async () => {
    const t = await buildTestApp(h);
    const op = await signInStaff(t, 'inc-op@captain.et');
    const created = await op.call('POST', '/v1/operator/incidents', {
      kind: 'damage_report',
      description: 'Broken brake lever reported by a passer-by',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: 'open',
      reportedByType: 'staff',
      isSimulated: false,
    });
    const id = created.json().id;

    const list = await op.call('GET', '/v1/operator/incidents');
    expect(list.json().map((i: { id: string }) => i.id)).toContain(id);

    const taken = await op.call('POST', `/v1/operator/incidents/${id}/assign`);
    expect(taken.json()).toMatchObject({ status: 'in_progress', assignedStaffId: op.staffId });

    const resolved = await op.call('POST', `/v1/operator/incidents/${id}/resolve`, {
      resolution: 'no_action',
      note: 'Lever replaced during routine maintenance',
    });
    expect(resolved.json()).toMatchObject({
      status: 'resolved',
      resolution: 'no_action',
      resolvedByStaffId: op.staffId,
    });
    expect(
      (
        await op.call('POST', `/v1/operator/incidents/${id}/resolve`, {
          resolution: 'other',
          note: 'again please',
        })
      ).statusCode,
    ).toBe(409);
    expect((await op.call('POST', `/v1/operator/incidents/${id}/assign`)).statusCode).toBe(409);
    expect((await op.call('GET', '/v1/operator/incidents?status=resolved')).json()[0].id).toBe(id);

    const audit = await h.pool.query(
      `select action from audit_log where target_id = $1 order by created_at`,
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['incident.created', 'incident.resolved']);
  });

  it('requires a reason to resolve and keeps riders out', async () => {
    const t = await buildTestApp(h);
    const op = await signInStaff(t, 'inc-op@captain.et');
    const { id } = (
      await op.call('POST', '/v1/operator/incidents', {
        kind: 'other',
        description: 'Something odd',
      })
    ).json();
    expect(
      (
        await op.call('POST', `/v1/operator/incidents/${id}/resolve`, {
          resolution: 'other',
          note: '',
        })
      ).statusCode,
    ).toBe(400);
    const rider = await signInRider(t);
    expect(
      (
        await t.request({
          method: 'GET',
          url: '/v1/operator/incidents',
          headers: bearer(rider.accessToken),
        })
      ).statusCode,
    ).toBe(403);
    expect((await t.request({ method: 'GET', url: '/v1/operator/incidents' })).statusCode).toBe(
      401,
    );
  });
});
