# Captain — Implementation Plan

One phase per task (see `CLAUDE.md`). A phase is complete only when every
acceptance criterion is demonstrated with checks run in the cloud, and
`docs/progress.md` lists what was and was not tested.

Global acceptance rules for every phase after Phase 1:
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass in a cloud session and in
  GitHub Actions.
- No secrets committed; `.env.example` updated for any new variable.
- Production guard still rejects fake providers (its tests pass).

---

## Phase 0 — Documentation and rules ✅
Deliverables: `CLAUDE.md`, `docs/*`, `.gitignore`.
Acceptance:
- Spec, architecture, data model, plan, decisions, progress documents exist.
- Unresolved business decisions recorded.
- Dependency versions checked against current registries/docs.

## Phase 1 — Cloud setup, skeletons, automated checks ✅
Goal: a reproducible cloud dev environment, empty-but-running apps, and CI.
Scope:
- pnpm workspace (no Turborepo yet, R-02), shared `tsconfig`, ESLint flat
  config, Prettier, Node 22 (`engines`, `.nvmrc`), `packageManager` field,
  committed `pnpm-lock.yaml`.
- Skeletons: `apps/api` (Fastify `/health` + `/ready`), `apps/iot-gateway`
  (process with health endpoint; **no protocol, no commands**),
  `apps/rider-web` and `apps/staff-web` (Next.js; staff-web has `/admin`
  and `/operator` placeholder routes), `apps/rider-mobile` (Expo SDK 57 +
  Expo Router hello screen), `packages/contracts`, `packages/config`,
  `packages/db`, `packages/tsconfig`.
- `packages/config`: Zod env schema with `APP_ENV` and the production
  safety guard (fake/simulated providers, `DEV_*`/`ALLOW_FAKE_*`
  variables, missing `DATABASE_URL`).
- `packages/db`: Drizzle + SQL migration mechanism, first migration
  (`app_settings`), migration runner.
- `scripts/cloud-setup.sh` + `scripts/db-local.sh` and a Claude Code
  SessionStart hook (architecture §12).
- GitHub Actions CI with a `postgres:16` service.
- **Not in scope:** payments (no Chapa code), OTP, rides, devices, maps.
Acceptance:
- Fresh cloud session: setup installs from the lockfile and starts an
  isolated PG 16 cluster without manual steps. Running it a second time is
  safe (no re-init, no data loss, same result).
- Setup refuses to run when `APP_ENV` is `staging`/`production`. It never
  touches a database other than its own local cluster.
- `pnpm check` (format, lint, typecheck, test, build) passes.
- `/health` and `/ready` tests pass via `app.inject()`. `/ready` reports
  not-ready when the DB is unreachable or migrations are pending.
- DB integration test applies migrations to a fresh PostgreSQL 16
  database, verifies constraints and repeatable migration, both locally
  and in CI.
- Production guard unit tests pass.
- Expo app: config resolves and JS bundles export for Android and iOS;
  `expo-doctor` run if reachable. **No native build is claimed.**
- No secrets, `.env` files, or database files tracked.
- CI workflow runs on the PR.

## Phase 2 — Configuration hardening and logging ✅ (CI: see progress.md)
Scope: structured logging for API and gateway, request IDs, redaction,
safe error envelope, production config guards.
Acceptance:
- Logs are JSON with service/env/level/time. Request-scoped lines carry
  `requestId`, which is also in the `x-request-id` header and error bodies.
- Redaction tests cover authorization headers, cookies, passwords, OTP
  codes, provider credentials/API keys/tokens, and connection strings, in
  objects, messages, errors, child bindings and URLs.
- Request bodies are not logged (tested).
- Error responses follow the envelope; 500s leak no internal details;
  validation errors do not echo submitted values.
- Guard tests: fake/simulated providers, dev-only variables, debug/trace
  log level in production; config errors never echo values.

## Plan revision 2 (2026-10-04): master work order

The owner's master work order (build through a verified launch candidate)
replaced the original Phases 3–17. Phases still run **one at a time**
(CLAUDE.md rule 1), each on its own stacked branch and PR. Merge order is
the phase order. Every phase must also satisfy the global acceptance rules
above. Status labels (implemented / simulated / blocked / verified) are
defined in CLAUDE.md. Requirement-level status lives in
`docs/traceability.md`.

## Phase 3 — Data model and migrations
Scope: full schema for identity, sessions, OTP, roles/permissions, fleet,
devices, zones, reservations, rides, pricing (versioned), ledger,
payments, refunds, device commands/telemetry, alerts, incidents,
maintenance, audit, idempotency. Money in `bigint` santim with currency.
Balanced, append-only ledger enforced in the database. Separate migration
owner and runtime roles. Development fixtures clearly labelled and refused
outside development/test.
Acceptance: migrations apply to an empty DB locally and in CI; constraint
tests for unbalanced journals, ledger UPDATE/DELETE, one active ride per
rider/scooter, currency, top-up minimum, simulated-device flag, runtime
role privileges; fixture loader refuses staging/production.

## Phase 4 — Authentication and request security
Scope: rider and staff OTP sign-in (email + SMS channels), hashed OTPs,
attempt limits, cooldowns, PostgreSQL-backed rate limits; opaque session
tokens (hashed) with refresh rotation, expiry, logout and revocation;
mobile bearer tokens; web cookies (`HttpOnly`, `Secure`, `SameSite`) plus
CSRF protection; explicit CORS; body limits; profile editing with contact
re-verification; suspension and deletion workflow; staff provisioning
CLI (no public admin sign-up). Provider adapters: SMTP email (protocol
standard), GeezSMS **blocked on official docs**, log-only senders for
development.
Acceptance: tests for OTP expiry/attempts/cooldown/rate limit, token
audience separation, refresh rotation and reuse detection, revocation,
CSRF, CORS, suspended accounts. **Real delivery is not claimed** until a
message is received (launch checklist).

## Phase 5 — Authorization, staff management, audit
Scope: permission catalogue and role → permission mapping in the
database; backend enforcement on every staff route; rider ownership
checks; audit records for sensitive staff actions; staff management API.
Acceptance: matrix tests (rider/operator/admin × every protected route),
cross-user access tests, URL/body tampering tests, audit rows written.

## Phase 6 — Fleet, zones, devices and the simulator
Scope: scooters, devices, assignments, maintenance records, zones (GeoJSON
polygons with server-side point-in-polygon; PostGIS not required yet),
nearby search, freshness/staleness rules, operational alerts; IoT
`DeviceAdapter` interface, **labelled simulator**, internal authenticated
gateway↔API contract, command lifecycle with deadlines, late/duplicate
acknowledgments, telemetry ingestion with validation; PostgreSQL-backed
sweeper worker (advisory-lock singleton).
Acceptance: tests for zone geometry, stale telemetry, invalid coordinates,
command ack/nack/timeout/late/duplicate, internal auth, simulator
labelling; no supplier protocol code.

## Phase 7 — Wallet ledger and payments
Scope: ledger posting service, balances (ledger/held/available), holds,
history; top-up flow with unique references, state machine
(pending → succeeded/failed/expired → reconciled), verify-before-credit,
idempotent event processing, reconciliation sweep, ambiguous-result
handling; refunds and staff adjustments (reasons, permissions, audit).
`PaymentProvider` interface with an isolated fake provider. **Chapa
adapter blocked** on official docs (T-01).
Acceptance: concurrency tests (parallel credits/debits), tampered
amount/currency/reference, replayed and reordered events, rollback on
failure, redirect never credits, exactly-once credit.

## Phase 8 — Pricing and ride engine
Scope: versioned pricing configuration (fees, rounding, pause rate,
minimum balance, hold, reservation window, max duration) with
development fixtures only; reservation, start, unlock pending, active,
pause, end requested, completion pending, completed, failed start,
operator review; idempotent start/end; pricing snapshots; settlement;
recovery; receipts and history.
Acceptance: state-transition table tests, races (double start, two riders
one scooter), duplicate/late events, disconnect/restart recovery, failed
unlock never charges, low balance never triggers hardware action.

## Phase 9 — Rider mobile app and EAS configuration
Scope: working screens against the API (product-spec §5), secure token
storage, Mapbox (development build), QR scanning + manual entry,
localization scaffolding, provisional styling; `eas.json` profiles, app
identifiers, permissions text, deep links.
Acceptance: component/unit tests, bundle export, expo-doctor; native
builds **only claimed when an EAS build actually succeeds** (blocked on
Expo access).

## Phase 10 — Rider web app
Scope: same rider flows on Next.js with cookie sessions, CSRF, Mapbox GL,
manual scooter code entry (camera optional).
Acceptance: Playwright E2E against a real API and PostgreSQL with fake
providers and the simulator.

## Phase 11 — Staff web (admin and operator)
Scope: admin overview, riders, fleet/devices, rides, payments
reconciliation + CSV exports (formula-injection safe), refunds and
adjustments, pricing and zones, staff and roles, incidents, audit trail;
operator fleet/tasks, alerts, inspections/maintenance, repositioning,
incidents. Confirmations and reasons for destructive/financial actions.
Acceptance: Playwright E2E including operator-cannot-do-admin checks.

## Phase 12 — Performance and resilience testing
Scope: reproducible load test for a documented fleet/rider load; restart
and failure drills in CI where possible.
Acceptance: measured results recorded; no unlimited-scale claims.

## Phase 13 — Deployment preparation and staging
Scope: hosting evaluation (TCP support, latency, backups, cost model
without invented prices), container builds in CI, environment
separation, migrations release path, DNS/HTTPS for captain.et, webhook
endpoints, gateway networking, monitoring/alerts, backups and restore
drill, rollback and incident runbooks. Staging deploy **blocked** on
hosting account and explicit authorization.

## Phase 14 — Real provider integrations
Chapa, GeezSMS, email provider, Mapbox tokens. Each blocked on official
docs and/or credentials; each verified only with real evidence.

## Phase 15 — Real IoT protocol
Blocked on supplier documentation, a test device and SIM. Implement
framing, checksums, heartbeats, correlation, safety semantics from the
docs; verify with recorded fixtures, then the real device.

## Phase 16 — Launch readiness and pilot
`docs/launch-checklist.md` evidence: real OTP, one controlled live
payment credited once, real scooter telemetry/unlock/end, recovery,
devices installed on Android and iPhone, backup restore, rollback,
reconciliation, controlled pilot. Production launch only on explicit
instruction.
