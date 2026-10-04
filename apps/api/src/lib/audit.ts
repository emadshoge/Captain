import { redactDeep } from '@captain/logging';
import type { FastifyRequest } from 'fastify';
import type { Queryable } from './db';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Appends an audit record attributed to the request's principal. Must be
 * called inside the same transaction as the change it records.
 */
export async function recordAudit(
  q: Queryable,
  request: FastifyRequest,
  entry: AuditEntry,
): Promise<void> {
  const auth = request.auth;
  const actorType = auth?.type ?? 'system';
  await q.query(
    `insert into audit_log (actor_type, actor_staff_id, actor_rider_id, action, target_type, target_id,
       reason, before, after, request_id, ip)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      actorType,
      auth?.type === 'staff' ? auth.staffId : null,
      auth?.type === 'rider' ? auth.riderId : null,
      entry.action,
      entry.targetType,
      entry.targetId ?? null,
      entry.reason ?? null,
      entry.before === undefined ? null : JSON.stringify(redactDeep(entry.before)),
      entry.after === undefined ? null : JSON.stringify(redactDeep(entry.after)),
      request.id,
      request.ip,
    ],
  );
}
