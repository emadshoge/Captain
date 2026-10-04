import { z } from 'zod';

/**
 * Permission catalogue. Must match the `permissions` table (migration 0002);
 * a test enforces this. Roles map to permissions in the database.
 */
export const PERMISSIONS = [
  'fleet.read',
  'fleet.status.update',
  'fleet.manage',
  'device.command.service',
  'maintenance.manage',
  'alerts.manage',
  'incidents.read',
  'incidents.resolve',
  'rides.read',
  'rides.review',
  'riders.read',
  'riders.manage',
  'wallet.read',
  'wallet.adjust',
  'refunds.approve',
  'payments.read',
  'payments.reconcile',
  'pricing.manage',
  'zones.manage',
  'staff.manage',
  'audit.read',
  'reports.export',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const STAFF_ROLES = ['admin', 'operator'] as const;
export const StaffRoleSchema = z.enum(STAFF_ROLES);

export const STAFF_ERROR_CODES = {
  LAST_ADMIN: 'LAST_ADMIN',
  SELF_CHANGE_FORBIDDEN: 'SELF_CHANGE_FORBIDDEN',
  STAFF_EXISTS: 'STAFF_EXISTS',
  DELETION_BLOCKED: 'DELETION_BLOCKED',
  INVALID_STATE: 'INVALID_STATE',
} as const;

/** Every sensitive staff action carries a human reason (stored in the audit log). */
export const ReasonSchema = z.string().trim().min(3).max(500);

export const StaffSummarySchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  status: z.enum(['active', 'suspended', 'disabled']),
  roles: z.array(z.string()),
  mfaEnabled: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const CreateStaffSchema = z.object({
  email: z.string().trim().min(3).max(254),
  displayName: z.string().trim().min(1).max(80),
  roles: z.array(StaffRoleSchema).min(1),
  reason: ReasonSchema,
});

export const UpdateStaffStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'disabled']),
  reason: ReasonSchema,
});

export const SetStaffRolesSchema = z.object({
  roles: z.array(StaffRoleSchema),
  reason: ReasonSchema,
});

export const ReasonBodySchema = z.object({ reason: ReasonSchema });

export const StaffMeSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  mfaEnabled: z.boolean(),
  mfaVerifiedThisSession: z.boolean(),
});

export const TotpSetupResponseSchema = z.object({
  otpauthUri: z.string(),
  /** Base32 secret, shown once for manual entry. */
  secret: z.string(),
});

export const TotpConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const RiderAdminSummarySchema = z.object({
  id: z.uuid(),
  displayName: z.string().nullable(),
  status: z.enum(['active', 'suspended', 'deletion_requested', 'deleted']),
  contacts: z.array(z.object({ kind: z.enum(['email', 'phone']), value: z.string() })),
  createdAt: z.iso.datetime(),
});

export const RiderAdminDetailSchema = RiderAdminSummarySchema.extend({
  statusReason: z.string().nullable(),
  termsVersion: z.string().nullable(),
  termsAcceptedAt: z.iso.datetime().nullable(),
  deletionRequestedAt: z.iso.datetime().nullable(),
  walletBalanceSantim: z.number().int(),
  heldSantim: z.number().int(),
  openRideId: z.uuid().nullable(),
});

export const AuditEntrySchema = z.object({
  id: z.number().int(),
  actorType: z.enum(['system', 'staff', 'rider']),
  actorStaffId: z.uuid().nullable(),
  actorRiderId: z.uuid().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  reason: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  requestId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const AuditQuerySchema = z.object({
  targetType: z.string().max(50).optional(),
  targetId: z.string().max(100).optional(),
  actorStaffId: z.uuid().optional(),
  action: z.string().max(100).optional(),
  /** Return entries with id < before (keyset pagination). */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
