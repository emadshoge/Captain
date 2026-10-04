/**
 * Staff provisioning (there is no public staff/admin sign-up).
 *
 *   APP_ENV=... DATABASE_URL=... node dist/cli/staff.js create --email a@captain.et --name "Name" --role admin --reason "first admin"
 *   ... grant  --email a@captain.et --role operator --reason "..."
 *   ... disable --email a@captain.et --reason "..."
 *
 * Every change writes an audit_log row (actor: system, via CLI) with the reason.
 * Later staff changes should go through the admin dashboard (Phase 5/11).
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { normalizeEmail } from '../lib/contacts';

const ROLES = new Set(['admin', 'operator']);

export async function runStaffCommand(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<string> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      role: { type: 'string' },
      reason: { type: 'string' },
    },
  });
  const command = positionals[0];
  if (!env.APP_ENV || !env.DATABASE_URL) throw new Error('APP_ENV and DATABASE_URL must be set');
  const email = normalizeEmail(values.email ?? '');
  if (!email) throw new Error('--email must be a valid email address');
  const reason = (values.reason ?? '').trim();
  if (reason.length < 3) throw new Error('--reason is required (at least 3 characters)');
  if (values.role !== undefined && !ROLES.has(values.role))
    throw new Error('--role must be admin or operator');

  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    const audit = (action: string, staffId: string, after: unknown) =>
      client.query(
        `insert into audit_log (actor_type, action, target_type, target_id, reason, after)
         values ('system', $1, 'staff_user', $2, $3, $4)`,
        [action, staffId, `cli: ${reason}`, JSON.stringify(after)],
      );
    let message: string;
    if (command === 'create') {
      const name = (values.name ?? '').trim();
      if (!name) throw new Error('--name is required');
      if (!values.role) throw new Error('--role is required');
      const existing = await client.query(`select 1 from staff_users where email = $1`, [email]);
      if (existing.rowCount) throw new Error('a staff user with this email already exists');
      const { rows } = await client.query<{ id: string }>(
        `insert into staff_users (email, display_name) values ($1, $2) returning id`,
        [email, name],
      );
      const staffId = rows[0]!.id;
      await client.query(`insert into staff_roles (staff_id, role_key) values ($1, $2)`, [
        staffId,
        values.role,
      ]);
      await audit('staff.provisioned', staffId, { email, role: values.role });
      message = `created staff ${email} with role ${values.role}`;
    } else if (command === 'grant') {
      if (!values.role) throw new Error('--role is required');
      const { rows } = await client.query<{ id: string }>(
        `select id from staff_users where email = $1`,
        [email],
      );
      if (!rows[0]) throw new Error('no staff user with this email');
      await client.query(
        `insert into staff_roles (staff_id, role_key) values ($1, $2) on conflict do nothing`,
        [rows[0].id, values.role],
      );
      await audit('staff.role_granted', rows[0].id, { role: values.role });
      message = `granted ${values.role} to ${email}`;
    } else if (command === 'disable') {
      const { rows } = await client.query<{ id: string }>(
        `update staff_users set status = 'disabled', updated_at = now() where email = $1 returning id`,
        [email],
      );
      if (!rows[0]) throw new Error('no staff user with this email');
      await client.query(
        `update auth_sessions set revoked_at = now(), revoke_reason = 'staff_disabled' where staff_id = $1 and revoked_at is null`,
        [rows[0].id],
      );
      await audit('staff.disabled', rows[0].id, { status: 'disabled' });
      message = `disabled ${email} and revoked their sessions`;
    } else {
      throw new Error(
        'usage: staff <create|grant|disable> --email … [--name …] [--role admin|operator] --reason …',
      );
    }
    await client.query('commit');
    return message;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

// Executed directly (not imported by tests).
if (process.argv[1] && /staff\.(ts|js)$/.test(process.argv[1])) {
  runStaffCommand(process.argv.slice(2), process.env)
    .then((message) => console.log(`staff: ${message}`))
    .catch((error: unknown) => {
      console.error(`staff: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
