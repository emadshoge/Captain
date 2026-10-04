import type { ApiConfig } from '@captain/config';
import type pg from 'pg';
import { type CommandRow, notifyCommandListeners, openAlert } from '../fleet/service';
import { withTransaction } from '../lib/db';
import { sweepReservations, sweepRides } from '../rides/engine';
import { reconcilePayments } from '../wallet/payments';
import type { PaymentProvider } from '../wallet/providers';

export interface SweepDeps {
  config: ApiConfig;
  pool: pg.Pool;
  now: () => Date;
  /** Payment provider for reconciliation (absent or fake = skipped). */
  provider?: PaymentProvider | null;
}

export type Sweep = (deps: SweepDeps) => Promise<number>;

/** Commands past their deadline become timed_out (and raise an alert). */
export const sweepCommandTimeouts: Sweep = async ({ pool, now }) => {
  const at = now();
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<CommandRow & { scooter_id: string | null }>(
      `update device_commands c set status = 'timed_out', resolved_at = $1
       where c.status in ('queued','sent') and c.deadline_at < $1
       returning c.*, (select scooter_id from device_assignments a where a.device_id = c.device_id and a.unassigned_at is null) as scooter_id`,
      [at],
    );
    for (const command of rows) {
      await openAlert(client, {
        kind: 'command_timeout',
        severity: command.type === 'locate' ? 'info' : 'warning',
        dedupeKey: `command_timeout:${command.id}`,
        deviceId: command.device_id,
        scooterId: command.scooter_id,
        rideId: command.ride_id,
        data: { type: command.type, simulated: command.is_simulated },
      });
      await notifyCommandListeners(client, command, { outcome: 'timeout', late: false }, at);
    }
    return rows.length;
  });
};

/** Devices silent for DEVICE_OFFLINE_SECONDS are marked offline. */
export const sweepOfflineDevices: Sweep = async ({ pool, config, now }) => {
  const at = now();
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      id: string;
      is_simulated: boolean;
      scooter_id: string | null;
    }>(
      `update devices d set online = false, updated_at = $1
       where d.online and (d.last_seen_at is null or d.last_seen_at < $2)
       returning d.id, d.is_simulated,
         (select scooter_id from device_assignments a where a.device_id = d.id and a.unassigned_at is null) as scooter_id`,
      [at, new Date(at.getTime() - config.DEVICE_OFFLINE_SECONDS * 1000)],
    );
    for (const device of rows) {
      await openAlert(client, {
        kind: 'device_offline',
        severity: 'warning',
        dedupeKey: `device_offline:${device.id}`,
        deviceId: device.id,
        scooterId: device.scooter_id,
        data: { simulated: device.is_simulated },
      });
    }
    return rows.length;
  });
};

/** Available scooters whose location is stale get an alert (they are also hidden from riders). */
export const sweepStaleTelemetry: Sweep = async ({ pool, config, now }) => {
  const at = now();
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `select id from scooters where status = 'available'
       and (last_telemetry_at is null or last_telemetry_at < $1)`,
      [new Date(at.getTime() - config.FLEET_TELEMETRY_STALE_SECONDS * 1000)],
    );
    for (const scooter of rows) {
      await openAlert(client, {
        kind: 'stale_telemetry',
        severity: 'warning',
        dedupeKey: `stale_telemetry:${scooter.id}`,
        scooterId: scooter.id,
      });
    }
    return rows.length;
  });
};

/** Housekeeping for short-lived security data. */
export const sweepPurge: Sweep = async ({ pool, now }) => {
  const at = now();
  const day = 86_400_000;
  let removed = 0;
  removed +=
    (
      await pool.query(`delete from rate_limit_buckets where window_start < $1`, [
        new Date(at.getTime() - day),
      ])
    ).rowCount ?? 0;
  removed +=
    (
      await pool.query(`delete from session_tokens where expires_at < $1`, [
        new Date(at.getTime() - 7 * day),
      ])
    ).rowCount ?? 0;
  removed +=
    (await pool.query(`delete from idempotency_keys where expires_at < $1`, [at])).rowCount ?? 0;
  removed +=
    (
      await pool.query(`delete from otp_challenges where created_at < $1`, [
        new Date(at.getTime() - 30 * day),
      ])
    ).rowCount ?? 0;
  return removed;
};

/**
 * Re-verifies payments whose webhook may have been lost. The fake provider
 * keeps state in its own process, so it is never reconciled from the worker.
 */
export const sweepPaymentReconciliation: Sweep = async (deps) => {
  if (!deps.provider || deps.provider.name === 'fake') return 0;
  return reconcilePayments({
    config: deps.config,
    pool: deps.pool,
    now: deps.now,
    provider: deps.provider,
  });
};

/** Ride recovery, duration and low-balance alerts (never device commands). */
export const sweepRideRecovery: Sweep = (deps) => sweepRides(deps);
export const sweepExpiredReservations: Sweep = (deps) => sweepReservations(deps);

export const SWEEPS: Record<string, Sweep> = {
  reservations: sweepExpiredReservations,
  rideRecovery: sweepRideRecovery,
  paymentReconciliation: sweepPaymentReconciliation,
  commandTimeouts: sweepCommandTimeouts,
  offlineDevices: sweepOfflineDevices,
  staleTelemetry: sweepStaleTelemetry,
  purge: sweepPurge,
};

const WORKER_LOCK_ID = 7_102_026; // arbitrary constant: one active worker per database

/**
 * Runs every sweep once, guarded by a session advisory lock so that two
 * worker instances never sweep concurrently. Returns null if another worker
 * holds the lock.
 */
export async function runSweepsOnce(deps: SweepDeps, sweeps: Record<string, Sweep> = SWEEPS) {
  const lockClient = await deps.pool.connect();
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>(
      `select pg_try_advisory_lock($1) as locked`,
      [WORKER_LOCK_ID],
    );
    if (!rows[0]?.locked) return null;
    try {
      const results: Record<string, number> = {};
      for (const [name, sweep] of Object.entries(sweeps)) results[name] = await sweep(deps);
      return results;
    } finally {
      await lockClient.query(`select pg_advisory_unlock($1)`, [WORKER_LOCK_ID]);
    }
  } finally {
    lockClient.release();
  }
}
