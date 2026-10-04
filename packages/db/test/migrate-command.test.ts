import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrateCommand } from '../src/cli/migrate-command';
import { createTestDatabase, type TestDatabase } from '../src/testing';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

describe('migrate command', () => {
  it('reports status without changing anything, then migrates', async () => {
    const lines: string[] = [];
    expect(
      await runMigrateCommand(['--status'], { APP_ENV: 'staging', DATABASE_URL: db.url }, (l) =>
        lines.push(l),
      ),
    ).toBe(0);
    expect(lines.at(-1)).toMatch(/0 applied, \d+ pending/);
    expect(
      await runMigrateCommand([], { APP_ENV: 'staging', DATABASE_URL: db.url }, (l) =>
        lines.push(l),
      ),
    ).toBe(0);
    expect(
      await runMigrateCommand(['--status'], { APP_ENV: 'staging', DATABASE_URL: db.url }, (l) =>
        lines.push(l),
      ),
    ).toBe(0);
    expect(lines.at(-1)).toMatch(/\d+ applied, 0 pending\./);
  });

  it('refuses production without the per-release database confirmation', async () => {
    const lines: string[] = [];
    const env = { APP_ENV: 'production', DATABASE_URL: db.url };
    expect(await runMigrateCommand([], env, (l) => lines.push(l))).toBe(1);
    expect(lines[0]).toContain('refusing');
    expect(
      await runMigrateCommand(
        [],
        { ...env, CAPTAIN_MIGRATE_CONFIRM_DATABASE: 'some_other_db' },
        () => undefined,
      ),
    ).toBe(1);
    // Status is read-only and allowed.
    expect(await runMigrateCommand(['--status'], env, () => undefined)).toBe(0);
    // With the matching confirmation it runs (here: nothing pending).
    expect(
      await runMigrateCommand(
        [],
        { ...env, CAPTAIN_MIGRATE_CONFIRM_DATABASE: db.name },
        () => undefined,
      ),
    ).toBe(0);
  });

  it('requires APP_ENV and a valid DATABASE_URL', async () => {
    expect(await runMigrateCommand([], { DATABASE_URL: db.url }, () => undefined)).toBe(1);
    expect(
      await runMigrateCommand(
        [],
        { APP_ENV: 'staging', DATABASE_URL: 'not a url' },
        () => undefined,
      ),
    ).toBe(1);
  });
});
