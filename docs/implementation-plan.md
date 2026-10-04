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

## Phase 0 — Documentation and rules ✅ (this task)
Deliverables: `CLAUDE.md`, `docs/*`, `.gitignore`.
Acceptance:
- Spec, architecture, data model, plan, decisions, progress documents exist.
- Unresolved business decisions recorded.
- Dependency versions checked against current registries/docs.

## Phase 1 — Cloud setup, skeletons, automated checks
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

## Phase 2 — Configuration hardening and logging
Scope: per-app env schemas as features need them, provider selection
enums extended, structured logger with redaction, request IDs.
Acceptance: guard tests for every provider added so far; logs redact
configured secret keys; unknown env keys with `DEV_`/`ALLOW_FAKE_`
prefixes rejected in production.

## Phase 3 — Database schema and migrations
Scope: tables from `docs/data-model.md` (except telemetry partitioning),
constraints (ledger sum trigger, partial unique ride indexes, append-only
grants), seed for roles and system ledger accounts.
Acceptance: migrations apply from empty DB in session and CI; constraint
tests (unbalanced ledger rejected, second active ride rejected, top-up
< 50 000 santim rejected, `is_simulated`/adapter CHECK).

## Phase 4 — Authentication (OTP) — needs D-LOGIN, D-EMAIL, D-ELIG
Scope: OTP challenge/verify, `OtpSender` interface, GeezSMS adapter
(from its docs), email adapter (chosen vendor), log-only senders for dev,
JWT access + refresh rotation, rider vs staff audiences, rate limits.
Acceptance: tests for expiry, attempts, cooldown, token audience
separation; GeezSMS/email adapters tested against recorded/mocked HTTP
(real send tested only with owner-provided sandbox credentials — otherwise
reported untested).

## Phase 5 — Roles, staff management, audit log
Acceptance: route-level permission tests for rider/operator/admin matrix
(product-spec §8); every staff mutation writes `audit_log`.

## Phase 6 — Fleet registry and simulated device gateway
Scope: scooters, devices, QR codes, `DeviceGateway` interface,
`SimulatedDeviceAdapter`, `device_commands` lifecycle, timeout worker
(pg-boss), internal API for command results.
Acceptance: tests for ack, nack, timeout, late ack (incident only, no
automatic command); simulated devices flagged and badge data exposed; no
supplier protocol code exists; motion-affecting commands rejected by the
real adapter interface until a documented stationary check exists.

## Phase 7 — Wallet ledger
Scope: ledger posting service, balances, holds, admin adjustments.
Acceptance: concurrency test (parallel charges cannot overspend),
idempotency tests, balance = sum of entries property test.

## Phase 8 — Chapa top-ups — **blocked on T-01** (official Chapa docs)
Scope: designed from the **official** Chapa documentation only (endpoints,
webhook authenticity check, verify semantics, test mode). Search snippets
are not a basis for implementation. Reconciliation job, `review` state.
Acceptance: tests with recorded Chapa responses for success, failure,
duplicate webhook, invalid signature, amount mismatch, lost webhook.
Live sandbox test only with owner-provided test keys; otherwise untested.

## Phase 9 — Ride start (unlock) — needs D-PRICE, D-MINBAL (D-PAUSE, D-ZONES may stay off)
Acceptance: insufficient balance blocked with `INSUFFICIENT_BALANCE`; one
active ride per rider/scooter; unlock ack/timeout transitions tested with
simulator; no charge on failed unlock.

## Phase 10 — Ride completion, billing, recovery — needs D-BILLCUT, D-PARK, D-ENDCONF, D-LOWBAL, D-REFUND
Acceptance: states `end_requested → completion_pending → completed` and
`operator_review` with `ride_incidents`; billing cutoff computed by the
configured policy; fare from snapshot; ledger charge idempotent; no
automatic physical command on any failure path (test asserts no command is
queued); late unlock ack opens an incident; restart recovery test for
pending commands.

## Phase 11 — Rider mobile app (screens) + EAS builds — needs D-UI (placeholder ok), D-EXPO
Scope: screens from product-spec §5, Mapbox map, QR scan, wallet/top-up,
ride flow against staging-like API with simulator. `eas.json` profiles.
Acceptance: component tests; JS bundle builds; **EAS Android development
build succeeds** — only after Expo access is verified; otherwise phase
reports the build as blocked.

## Phase 12 — Rider web app
Acceptance: Playwright E2E (Chromium) for sign-in (log-only OTP), top-up
(fake provider), start/end ride (simulator) against a local API + PG.

## Phase 13 — Operator area (`staff-web` /operator)
Acceptance: Playwright tests for fleet map/list, status change, service
command with ack/timeout display, SIMULATED badge, operator-review queue
and incident resolution.

## Phase 14 — Admin area (`staff-web` /admin)
Acceptance: Playwright tests for rider management, adjustments (audited),
pricing/zone config, staff roles, audit log view.

## Phase 15 — Staging environment — needs D-HOST
Acceptance: manual deploy workflow to staging; migrations run; health
checks pass; Chapa test keys; preview mobile build points to staging.
No production resources created.

## Phase 16 — Real IoT gateway — blocked on D-IOT (supplier documentation)
Scope: `SupplierTcpAdapter` implemented strictly from supplier docs;
protocol tests built from documented examples; bench test with real device.
Acceptance defined when docs arrive.

## Phase 17 — Production readiness (no deploy without owner approval)
Security review, backups/PITR, monitoring/alerts, load test of ride start,
runbooks, store listing prerequisites. Production deploy is a separate,
owner-approved task.
