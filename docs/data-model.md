# Captain — Data Model

Status: **implemented in Phase 3** (migrations `0000`–`0002`). Source of
truth: `packages/db/src/schema/*.ts` (tables, constraints, indexes) and
`packages/db/migrations/0002_db_rules.sql` (triggers, grants, reference
data). PostgreSQL 16. Items marked **[OPEN Dxx]** depend on unresolved
decisions in `docs/decisions.md`.

## Conventions

- Primary keys: `uuid` (`gen_random_uuid()`); high-volume history tables use `bigserial`.
- Timestamps: `timestamptz` (UTC). Displayed in `Africa/Addis_Ababa`
  (`@captain/domain` `formatEthiopiaDateTime`).
- Money: `bigint` **santim** columns named `*_santim`, plus a `currency`
  column (`CHECK currency = 'ETB'`). Arithmetic uses integers only
  (`@captain/domain`).
- Coordinates: WGS84 `double precision` with range checks. Lat/lng are
  stored as a pair or not at all.
- Rules that matter for money, safety or audit are enforced **in the
  database**: constraints, triggers and grants. Application code is not
  trusted to enforce them alone.

## Tables by area

### Identity and access (`schema/identity.ts`)
| Table | Purpose | Key rules |
|---|---|---|
| `riders` | Rider account, status (`active/suspended/deletion_requested/deleted`), language, terms + age attestation | |
| `rider_contacts` | Verified email/phone per rider | unique `(kind,value)`; one per kind per rider; email lower-case; phone E.164 |
| `staff_users` | Staff accounts (separate from riders) | unique lower-case email |
| `roles`, `permissions`, `role_permissions`, `staff_roles` | RBAC | seeded `admin` (all permissions) and `operator` (fleet/maintenance/incidents/ride review only) |
| `otp_challenges` | OTP challenges, **hashed code**, attempts ≤ max, expiry, provider used | |
| `auth_sessions` | Session per sign-in (`mobile`/`web`), expiry, revocation | exactly one subject (rider xor staff) |
| `session_tokens` | Hashed opaque access/refresh tokens; refresh `used_at` for reuse detection | |
| `rate_limit_buckets` | Fixed-window counters (PostgreSQL-backed; no Redis) | |

### Fleet and zones (`schema/fleet.ts`)
| Table | Purpose | Key rules |
|---|---|---|
| `scooters` | Code (printed), QR token, status, battery, last location/telemetry, `version` | code format `^[A-Z0-9-]{3,16}$`; battery 0–100; lat/lng ranges + pair |
| `devices` | IoT module, adapter `simulated/supplier_tcp`, `is_simulated`, online/last seen | `is_simulated = (adapter='simulated')`; both **immutable** (trigger) |
| `device_assignments` | Device ↔ scooter history | one active assignment per device and per scooter |
| `maintenance_records` | Inspections, repairs, battery swaps, repositioning tasks | |
| `zones` | GeoJSON polygon + bbox; `service_area/parking/no_parking/restricted/slow`; `is_dev_fixture` | bbox ordered and in range **[OPEN D-ZONES]** |
| `device_telemetry` | Location/battery/speed/locked + validity flag, `is_simulated`, raw payload | ranges; indexed by device + time |

### Pricing, reservations, rides, commands (`schema/rides.ts`)
| Table | Purpose | Key rules |
|---|---|---|
| `pricing_plans` | Versioned pricing: unlock fee, per-minute, billing increment (rounding), pause rate/limit, min start balance, hold, reservation window/fee, max ride minutes, low-balance floor, `is_dev_fixture` | one `active` plan; **numbers immutable after draft**; transitions draft→active→retired only; amounts ≥ 0; floor ≤ 0 **[OPEN D-PRICE, D-ROUND, D-MINBAL, D-RESERVE, D-PAUSE, D-MAXRIDE, D-LOWBAL]** |
| `reservations` | Active/expired/cancelled/converted holds on a scooter | one active per rider and per scooter |
| `rides` | Status (`start_requested, unlock_pending, active, paused, end_requested, completion_pending, completed, start_failed, operator_review`), pricing snapshot, timestamps (request, unlock confirmed, end requested + location, completion confirmed + source, billing cutoff, completed), pause accounting, parking status, fare | one **open** ride per rider and per scooter (`operator_review` counts as open); identity + snapshot immutable; terminal states final; `completed` requires `completed_at` and fare; no deletes |
| `ride_events` | Every transition with cause/actor/command | append-only |
| `device_commands` | Internal intents (`unlock/lock/locate` — **not** supplier codes), status, deadline, issuer, reason, `is_simulated` | |
| `device_command_acks` | Every ack/nack incl. late and duplicate | append-only |

### Money (`schema/money.ts`)
| Table | Purpose | Key rules |
|---|---|---|
| `ledger_accounts` | Rider wallets + system accounts (`provider_clearing, ride_revenue, reservation_revenue, refunds, adjustments`) | one wallet per rider; one system account per type; unique `(id,currency)` |
| `journal_entries` | Balanced set of lines; kind, reference, reverses | unique `(reference_type, reference_id, kind)` (idempotency); **append-only** |
| `ledger_lines` | Signed santim amounts | non-zero; currency must equal account currency (composite FK); **sum per journal = 0 and ≥ 2 lines** (deferred constraint trigger); **append-only** incl. TRUNCATE |
| `wallet_holds` | Reserved funds (affects *available* balance) | positive; one active hold per ride |
| `payment_attempts` | Top-ups: unique `tx_ref`, amount ≥ 50 000 santim, status, verified amount/currency, journal | `succeeded` requires a journal and `verified_at`; one payment per journal |
| `payment_events` | Raw webhook/verify/reconcile records | dedupe key unique per provider; raw fields immutable; no deletes |
| `refunds` | Refund requests and decisions with reasons | positive; reason required **[OPEN D-REFUND]** |
| `wallet_adjustments` | Staff adjustments (signed) with reason + journal | non-zero; reason required |

Balances: **ledger balance** = sum of wallet lines; **held** = sum of
active holds; **available** = ledger − held (Phase 7).

### Operations (`schema/ops.ts`)
| Table | Purpose | Key rules |
|---|---|---|
| `incidents` | Ride/device incidents and rider support reports, assignment, resolution | opening one never sends a device command |
| `operational_alerts` | Low battery, offline, stale/invalid telemetry, command timeout, max duration, low balance | one unresolved alert per dedupe key |
| `audit_log` | Sensitive staff/system actions with before/after, reason, request ID | append-only incl. TRUNCATE |
| `idempotency_keys` | Stored responses for retried POSTs | PK `(subject, endpoint, key)` |
| `app_settings` | Key/value settings not tied to pricing | key format |

## Database roles

- **Migration owner**: the role that runs `db:migrate`. It owns the
  schema and runs DDL.
- **`captain_app`** is a NOLOGIN group role created by migration `0002`
  (or by a DB admin beforehand, where the migration owner lacks
  CREATEROLE). Runtime logins (API, worker) are granted membership.
  - **Granted:** DML on ordinary tables, `INSERT`/`SELECT` only on history
    tables, read access to migration status.
  - **Not granted:** DDL, reference-data writes, or deletes of rides,
    pricing and payment events.
  - **New tables:** default privileges give them DML. Migrations that add
    history tables must `REVOKE UPDATE, DELETE`.
- Append-only triggers also bind the migration owner.

## Development fixtures

`pnpm --filter @captain/db db:fixtures` (also run by `cloud-setup.sh` on
the local dev DB) loads:
- 12 **simulated** scooters/devices (`DEV-0001`…);
- 4 zones in central Addis Ababa;
- a pricing plan.

Every fixture row is named or flagged `DEV FIXTURE`. The loader refuses
any `APP_ENV` other than `development`/`test`, and refuses to replace an
active non-fixture plan.
