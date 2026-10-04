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
Goal: a reproducible cloud dev environment and empty-but-running apps.
Scope:
- pnpm workspace, Turborepo, shared `tsconfig`, ESLint (flat config),
  Prettier, Node 22 via `.nvmrc` / `engines`, `packageManager` field.
- Skeletons: `apps/api` (Fastify `/health`), `apps/iot-gateway` (process
  that starts and exits cleanly / health), `apps/rider-web`,
  `apps/admin-web`, `apps/operator-web` (Next.js hello pages),
  `apps/rider-mobile` (Expo SDK 57 + Expo Router hello screen),
  `packages/contracts`, `packages/config`, `packages/db`, `packages/domain`.
- `scripts/db-local.sh` (start/stop/reset local PG 16 per architecture §12)
  and a Claude Code **SessionStart hook** that installs deps and starts PG.
- `packages/db`: Drizzle config, empty initial migration, test helper that
  connects to `DATABASE_URL` and proves `select 1` + migration run.
- GitHub Actions CI: install, lint, typecheck, unit tests, DB tests with
  `postgres:16` service, Next.js builds, `expo export` (web/JS bundle) or
  `expo-doctor` for the mobile app.
Acceptance:
- Fresh cloud session: SessionStart hook completes; `pnpm check` (lint +
  typecheck + test + build) passes with no manual steps.
- `GET /health` test passes via `app.inject()`.
- DB integration test runs against a real PostgreSQL 16 locally and in CI.
- CI workflow green on the PR.
- Expo app passes `npx expo-doctor` and bundles; React/RN versions match
  SDK 57 pins.
- Untested items (e.g. native mobile build) explicitly listed.

## Phase 2 — Configuration and production safety guard
Scope: `packages/config` Zod env schema per app, `APP_ENV`, provider
selection, fail-fast guard (architecture §6), structured logger with
redaction.
Acceptance: unit tests for every guard rule (production + fake payment,
fake OTP, dev OTP code, simulated device adapter, Chapa test key) exit
non-zero; logs redact configured secret keys.

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
Acceptance: tests for ack, nack, timeout, late ack; simulated devices
flagged and badge data exposed; no supplier protocol code exists.

## Phase 7 — Wallet ledger
Scope: ledger posting service, balances, holds, admin adjustments.
Acceptance: concurrency test (parallel charges cannot overspend),
idempotency tests, balance = sum of entries property test.

## Phase 8 — Chapa top-ups — needs T-01 resolved
Scope: initialize, return URL, webhook with signature verification, verify
call, reconciliation job, `review` state.
Acceptance: tests with recorded Chapa responses for success, failure,
duplicate webhook, invalid signature, amount mismatch, lost webhook.
Live sandbox test only with owner-provided test keys; otherwise untested.

## Phase 9 — Ride start (unlock) — needs D-PRICE, D-MINBAL (D-PAUSE, D-ZONES may stay off)
Acceptance: insufficient balance blocked with `INSUFFICIENT_BALANCE`; one
active ride per rider/scooter; unlock ack/timeout transitions tested with
simulator; no charge on failed unlock.

## Phase 10 — Ride end, billing, recovery — needs D-LOWBAL, D-REFUND (interim rules documented)
Acceptance: fare computed from snapshot; ledger charge idempotent; lock
retries; `end_unconfirmed` path and operator confirmation; restart
recovery test for pending commands.

## Phase 11 — Rider mobile app (screens) + EAS builds — needs D-UI (placeholder ok), D-EXPO
Scope: screens from product-spec §5, Mapbox map, QR scan, wallet/top-up,
ride flow against staging-like API with simulator. `eas.json` profiles.
Acceptance: component tests; JS bundle builds; **EAS Android development
build succeeds** — only after Expo access is verified; otherwise phase
reports the build as blocked.

## Phase 12 — Rider web app
Acceptance: Playwright E2E (Chromium) for sign-in (log-only OTP), top-up
(fake provider), start/end ride (simulator) against a local API + PG.

## Phase 13 — Operator dashboard
Acceptance: Playwright tests for fleet map/list, status change, service
command with ack/timeout display, SIMULATED badge, end_unconfirmed review.

## Phase 14 — Admin dashboard
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
