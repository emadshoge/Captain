# Captain — Data Model

Status: Phase 0 logical model. Physical schema (Drizzle + SQL migrations)
is created in the database phase. PostgreSQL 16.

Conventions:
- Primary keys: `uuid` (v7 generated in app, sortable).
- Timestamps: `timestamptz`, UTC. `created_at`, `updated_at` on mutable rows.
- Money: `bigint` **santim** (1 ETB = 100 santim), column suffix `_santim`.
- Enums: PostgreSQL enums or `text` + CHECK (decide in DB phase).
- Append-only tables (ledger, events, audit) have no UPDATE/DELETE grants
  for the application role.

## Entity relationship overview

```
riders 1─* rider_identities           staff_users *─* roles (via staff_roles)
riders 1─* auth_sessions              staff_users 1─* auth_sessions
riders 1─1 ledger_accounts(rider_wallet)
riders 1─* payments 1─* payment_events
riders 1─* rides 1─* ride_events
rides  *─1 scooters 1─1 devices 1─* device_commands
                         devices 1─* device_telemetry
rides  1─0..1 ledger_transactions (charge)
ledger_transactions 1─* ledger_entries *─1 ledger_accounts
riders 1─* wallet_holds *─0..1 rides
pricing_plans 1─* rides (plan snapshot copied onto ride)
zones (service / parking / no-parking)       audit_log (all staff actions)
otp_challenges   idempotency_keys   support_tickets
```

## Identity and access

### riders
`id`, `display_name`, `status` (`active|suspended|deleted`),
`eligibility_status` (**[OPEN D-ELIG]**), `terms_accepted_version`,
`terms_accepted_at`, `created_at`.

### rider_identities
`id`, `rider_id → riders`, `type` (`phone|email`), `value` (E.164 or
lower-cased email), `verified_at`. Unique `(type, value)`.
Supports either primary login method (**[OPEN D-LOGIN]**).

### staff_users
`id`, `email` (unique), `name`, `status`, `created_at`. Separate table from
riders — no shared login.

### roles / staff_roles
`roles`: `operator`, `admin` (seeded). `staff_roles(staff_user_id, role)`.
Permission checks map roles → capabilities in code (`packages/domain`).

### otp_challenges
`id`, `channel` (`email|sms`), `destination`, `purpose`
(`rider_login|staff_login`), `code_hash`, `expires_at`, `attempts`,
`consumed_at`, `provider` (records `geezsms`, `email:<name>`, or `log_only`).

### auth_sessions
`id`, `subject_type` (`rider|staff`), `subject_id`, `refresh_token_hash`,
`expires_at`, `revoked_at`, `user_agent`, `ip`.

## Fleet and devices

### scooters
`id`, `code` (short human code printed with the QR, unique), `qr_payload`
(unique), `status` (`available|reserved|in_ride|maintenance|charging|missing|retired`),
`battery_percent`, `last_location` (lat/lng; PostGIS `geography(Point)` if
adopted), `last_location_at`, `model`.

### devices
`id`, `scooter_id → scooters` (unique, nullable while unbound),
`supplier_device_id` (identifier format from supplier docs, unique),
`adapter` (`simulated|supplier_tcp`), `is_simulated` (boolean, immutable,
CHECK `is_simulated = (adapter = 'simulated')`), `firmware_version`,
`online`, `last_seen_at`.

### device_commands
`id`, `device_id`, `ride_id?`, `type` (internal enum; mapping to supplier
commands only from supplier docs), `status`
(`queued|sent|acked|nacked|timed_out|failed`), `issued_by_type`
(`system|staff`), `issued_by_id?`, `attempt`, `created_at`, `sent_at`,
`deadline_at`, `acked_at`, `result_code`, `result_payload` (jsonb).

### device_telemetry
`id`, `device_id`, `received_at`, `location`, `battery_percent`,
`locked` (nullable), `raw` (jsonb, adapter-specific). High volume →
consider partitioning by month; retention policy TBD.

## Rides

### rides
`id`, `rider_id`, `scooter_id`, `device_id`, `status`
(`unlock_pending|unlock_failed|active|paused|lock_pending|end_unconfirmed|ended`),
`pricing_snapshot` (jsonb copy of plan at start), `requested_at`,
`started_at` (unlock ack), `end_requested_at`, `ended_at` (lock ack or
operator confirmation), `start_location`, `end_location`,
`end_zone_status` (`ok|outside|unknown`), `duration_seconds`,
`fare_santim`, `charge_ledger_tx_id?`, `failure_reason?`.

Constraints:
- Partial unique index: one ride per `rider_id` where status not in
  (`ended`, `unlock_failed`).
- Partial unique index: one ride per `scooter_id` with same condition.

### ride_events
`id`, `ride_id`, `from_status`, `to_status`, `cause`
(`rider|device_ack|timeout|operator|system`), `actor_id?`,
`device_command_id?`, `created_at`, `data` (jsonb). Append-only.

### pricing_plans
`id`, `name`, `unlock_fee_santim`, `per_minute_santim`,
`min_start_balance_santim`, `pause_per_minute_santim?`, `active_from`,
`active_to`, `created_by`. Values are **[OPEN D-PRICE / D-MINBAL /
D-PAUSE]** — no defaults committed for production.

### zones
`id`, `name`, `type` (`service|parking|no_parking|slow`), `geometry`
(GeoJSON polygon; PostGIS if adopted), `active`. **[OPEN D-ZONES]**

## Wallet and payments

### ledger_accounts
`id`, `type` (`rider_wallet|chapa_clearing|ride_revenue|refunds_expense|adjustments`),
`rider_id?` (unique for `rider_wallet`), `currency` (`ETB`, CHECK).
Rider wallet row is the lock target (`SELECT … FOR UPDATE`).

### ledger_transactions
`id`, `kind` (`topup|ride_charge|refund|adjustment|reversal`),
`source_type`, `source_id`, `created_at`, `created_by_type`,
`created_by_id?`, `memo`. Unique `(source_type, source_id, kind)` for
idempotency. Append-only.

### ledger_entries
`id`, `ledger_transaction_id`, `ledger_account_id`, `amount_santim`
(signed; + credit to account balance, − debit). Sum per transaction = 0
(enforced by deferred constraint trigger). Append-only.

### wallet_holds
`id`, `rider_id`, `ride_id?`, `amount_santim`, `status`
(`active|released|captured`), `created_at`, `released_at`.
Used only if the hold policy requires (**[OPEN D-MINBAL / D-LOWBAL]**).

### payments
`id`, `rider_id`, `provider` (`chapa|fake`), `tx_ref` (unique),
`amount_santim` (CHECK ≥ 50 000), `currency` (`ETB`), `status`
(`pending|succeeded|failed|expired|review`), `checkout_url`,
`provider_reference?`, `verified_at?`, `ledger_tx_id?`, `created_at`.
`provider = 'fake'` rows are rejected in production by config guard and a
DB CHECK tied to a settings row is considered in the DB phase.

### payment_events
`id`, `payment_id?`, `source` (`webhook|verify_call|return_url`),
`signature_valid` (boolean), `payload` (jsonb), `received_at`. Append-only.

### refunds
`id`, `rider_id`, `ride_id?`, `payment_id?`, `amount_santim`, `reason`,
`status` (`requested|approved|rejected|completed`), `requested_by`,
`approved_by?`. Rules **[OPEN D-REFUND]**.

## Operations

### support_tickets
`id`, `rider_id?`, `ride_id?`, `scooter_id?`, `category`, `status`,
`description`, `assigned_staff_id?`, timestamps.

### audit_log
`id`, `actor_type` (`staff|system`), `actor_id?`, `action`, `target_type`,
`target_id`, `before` / `after` (jsonb, secrets redacted), `ip`,
`created_at`. Append-only.

### idempotency_keys
`key`, `subject_id`, `endpoint`, `request_hash`, `response_status`,
`response_body`, `created_at`, `expires_at`. Primary key
`(subject_id, endpoint, key)`.

### app_settings
Key/value (jsonb) for configurable business rules not tied to a pricing
plan (e.g. min top-up 50 000 santim, OTP limits). Changes audited.
