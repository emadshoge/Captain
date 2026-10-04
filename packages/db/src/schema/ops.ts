import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, ts, updatedAt } from './_common';
import { devices, scooters } from './fleet';
import { riders, staffUsers } from './identity';
import { actorType } from './money';
import { rides } from './rides';

export const incidentKind = pgEnum('incident_kind', [
  'late_unlock_ack',
  'unlock_failed',
  'completion_timeout',
  'completion_nack',
  'telemetry_mismatch',
  'parking_dispute',
  'damage_report',
  'billing_dispute',
  'safety_report',
  'other',
]);
export const incidentStatus = pgEnum('incident_status', ['open', 'in_progress', 'resolved']);
export const incidentResolution = pgEnum('incident_resolution', [
  'completed_confirmed',
  'completed_adjusted',
  'cancelled_no_charge',
  'no_action',
  'other',
]);

/** Ride/device incidents and rider support reports. Opening one never sends a device command. */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: incidentKind('kind').notNull(),
    status: incidentStatus('status').notNull().default('open'),
    rideId: uuid('ride_id').references(() => rides.id),
    scooterId: uuid('scooter_id').references(() => scooters.id),
    deviceId: uuid('device_id').references(() => devices.id),
    riderId: uuid('rider_id').references(() => riders.id),
    reportedByType: actorType('reported_by_type').notNull(),
    description: text('description').notNull(),
    assignedStaffId: uuid('assigned_staff_id').references(() => staffUsers.id),
    resolution: incidentResolution('resolution'),
    resolutionNote: text('resolution_note'),
    resolvedByStaffId: uuid('resolved_by_staff_id').references(() => staffUsers.id),
    resolvedAt: ts('resolved_at'),
    isSimulated: boolean('is_simulated').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('incidents_open_idx')
      .on(t.createdAt)
      .where(sql`${t.status} <> 'resolved'`),
    index('incidents_ride_idx').on(t.rideId),
    index('incidents_rider_idx').on(t.riderId),
  ],
);

export const alertKind = pgEnum('alert_kind', [
  'low_battery',
  'device_offline',
  'stale_telemetry',
  'outside_service_area',
  'command_timeout',
  'max_ride_duration',
  'low_balance',
  'invalid_telemetry',
  'payment_review',
]);
export const alertSeverity = pgEnum('alert_severity', ['info', 'warning', 'critical']);
export const alertStatus = pgEnum('alert_status', ['open', 'acknowledged', 'resolved']);

export const operationalAlerts = pgTable(
  'operational_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: alertKind('kind').notNull(),
    severity: alertSeverity('severity').notNull(),
    status: alertStatus('status').notNull().default('open'),
    scooterId: uuid('scooter_id').references(() => scooters.id),
    deviceId: uuid('device_id').references(() => devices.id),
    rideId: uuid('ride_id').references(() => rides.id),
    /** At most one unresolved alert per dedupe key (e.g. "low_battery:<scooter>"). */
    dedupeKey: text('dedupe_key').notNull(),
    data: jsonb('data').notNull().default({}),
    acknowledgedByStaffId: uuid('acknowledged_by_staff_id').references(() => staffUsers.id),
    createdAt: createdAt(),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    uniqueIndex('operational_alerts_open_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`${t.status} <> 'resolved'`),
    index('operational_alerts_open_idx')
      .on(t.severity, t.createdAt)
      .where(sql`${t.status} <> 'resolved'`),
  ],
);

/** Sensitive staff (and system) actions. Append-only (trigger + grants). */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorType: actorType('actor_type').notNull(),
    actorStaffId: uuid('actor_staff_id').references(() => staffUsers.id),
    actorRiderId: uuid('actor_rider_id').references(() => riders.id),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    reason: text('reason'),
    before: jsonb('before'),
    after: jsonb('after'),
    requestId: text('request_id'),
    ip: inet('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_actor_idx').on(t.actorStaffId, t.id),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
    index('audit_log_time_idx').on(t.createdAt),
  ],
);

export const idempotencyStatus = pgEnum('idempotency_status', ['in_progress', 'completed']);

/** Replay protection for POSTs that move money or send device commands. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    subjectKey: text('subject_key').notNull(),
    endpoint: text('endpoint').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: idempotencyStatus('status').notNull().default('in_progress'),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.subjectKey, t.endpoint, t.key] }),
    index('idempotency_keys_expiry_idx').on(t.expiresAt),
  ],
);
