# Requirements traceability

Status vocabulary (CLAUDE.md): **implemented** (code + passing automated
tests), **simulated** (only against fakes/simulator), **blocked**
(external input needed), **verified** (real-world evidence, see
`docs/launch-checklist.md`), **planned** (not started), **partial**.

Updated at the end of every phase.

## Platform foundation (master order D, M)

| Req | Requirement | Code | Tests | Status | Notes / blockers |
|---|---|---|---|---|---|
| F1 | Validated env config, no unsafe production defaults | `packages/config` | `packages/config/test/config.test.ts` | implemented | `APP_ENV` required |
| F2 | Production rejects fake payments/OTP/simulated devices | `packages/config/src/guard.ts` | config tests; built-bundle smoke | implemented | no override flag |
| F3 | Structured logs + request IDs | `packages/logging`, `apps/api/src/app.ts` | `packages/logging/test/*`, `apps/api/test/observability.test.ts` | implemented | |
| F4 | Redaction (tokens, cookies, passwords, OTPs, credentials, connection strings) | `packages/logging/src/redact.ts` | logging + API tests | implemented | |
| F5 | No sensitive body logging | Fastify request serializers | observability test | implemented | |
| F6 | Consistent API errors, no internals | `apps/api/src/errors.ts` | observability test | implemented | |
| F7 | Rate limits (auth, expensive endpoints) | `apps/api/src/lib/rate-limit.ts` | auth tests (per destination, cooldown) | implemented for auth; ride/payment endpoints in Phases 7–8 | PostgreSQL-backed |
| F8 | Explicit CORS | `apps/api/src/app.ts`, `CORS_ORIGINS` | CORS preflight test | implemented | required in staging/prod |
| F9 | Secure cookies + CSRF | `apps/api/src/auth/http.ts` | cookie/CSRF/Origin tests | implemented | |
| F10 | Bounded request sizes | Fastify `bodyLimit` | 413 test | implemented | default 1 MiB |
| F11 | Health/readiness without secrets | `apps/api/src/routes/health.ts` | health tests | implemented | |
| F17 | Background worker (sweeps, single instance) | `apps/api/src/worker*` | fleet tests (sweeps, advisory lock) | implemented | |
| F12 | Audit records for sensitive staff actions | `apps/api/src/lib/audit.ts` + staff/admin routes | `authz.test.ts` | implemented | append-only (DB) |
| F13 | Reproducible cloud setup + PostgreSQL cluster | `scripts/*`, `.claude/` | manual runs (progress.md) | implemented | hook active once on `main` |
| F14 | CI: format, lint, typecheck, tests (PG), builds, Expo checks | `.github/workflows/ci.yml` | CI runs | implemented | |
| F15 | Browser E2E in CI | — | — | planned (Phase 10–11) | |
| F16 | Performance test with measured results | — | — | planned (Phase 12) | |

## Data and integrity (master order E)

| Req | Requirement | Code | Tests | Status | Notes |
|---|---|---|---|---|---|
| E1 | Full schema with FKs, uniques, indexes | `packages/db/src/schema/*` | `packages/db/test/rules.test.ts` | implemented | 36 tables |
| E2 | Money as integer santim + currency | schema `santim()`/`currency()`, `packages/domain/src/money.ts` | rules + domain tests | implemented | |
| E3 | Balanced, append-only ledger; compensating corrections | `migrations/0002_db_rules.sql` | rules tests (unbalanced, single-line, UPDATE/DELETE/TRUNCATE) | implemented (DB level); posting service Phase 7 | |
| E4 | Separate migration owner vs runtime DB role | `captain_app` in `0002` | runtime role test | implemented | API runtime login wiring: Phase 13 deploy docs |
| E5 | Controlled production migration path | `packages/db/src/cli/migrate.ts` (refuses prod) | — | partial | controlled path in Phase 13 |
| E6 | Versioned billing configuration | `pricing_plans` + immutability trigger | pricing tests | implemented (storage); use in Phase 8 | values **[OPEN]** |
| E7 | Dev fixtures labelled and refused outside dev/test | `packages/db/src/fixtures.ts` | `fixtures.test.ts` | implemented | |
| E8 | UTC storage, Ethiopia-local display | `timestamptz`; `packages/domain/src/time.ts` | domain tests | implemented | |

## Identity and access (F)

| Req | Requirement | Status | Phase / blocker |
|---|---|---|---|
| A1 | Rider registration/login via OTP | implemented (SMS simulated via log-only; email via SMTP) | 4 |
| A2 | Hashed OTP, expiry, attempts, cooldowns, abuse controls | implemented | 4 |
| A3 | Sessions: expiry, refresh, logout, revocation | implemented (reuse detection) | 4 |
| A4 | Secure mobile token storage | planned | 9 |
| A5 | Browser sessions (cookies + CSRF) | implemented (API side); web client Phase 10 | 4/10 |
| A6 | Suspension and deletion with financial retention | implemented (suspend/unsuspend, deletion request + staff completion with blockers; ledger retained) | 4/5 |
| A7 | Profile/contact change with re-verification | implemented | 4 |
| A8 | Staff provisioning (no public admin sign-up) + stronger staff auth | implemented: audited CLI + admin API (create/status/roles), TOTP second factor with enforcement; UI Phase 11 | 4/5 |
| A9 | Real email adapter | implemented (SMTP, tested against a local SMTP server); **real delivery unverified** (B4, L2) | 4, 14 |
| A10 | Real GeezSMS adapter | blocked (official docs B1, account B3) | 14 |
| A11 | Backend permission enforcement + cross-user tests | implemented: fail-closed guard, matrix test (anonymous/rider/operator/admin × every staff route), tampering + cross-rider tests; must be extended for every new route | 5 |

## Wallet and payments (G)

| Req | Requirement | Status | Phase / blocker |
|---|---|---|---|
| W1 | Balances (ledger, held, available) + history | implemented + tested (`apps/api/test/wallet.test.ts`) | 7 |
| W2 | Top-up ≥ 500 ETB, unique references, state machine | implemented + tested | 7 |
| W3 | Verify-before-credit; never credit from redirect | implemented + tested (fake provider only) | 7 |
| W4 | Idempotent duplicate/reordered events | implemented + tested (replay, concurrency) | 7 |
| W5 | Reconciliation when webhooks fail | implemented + tested (reconcile, expiry, late success) | 7 |
| W6 | Refunds and staff adjustments with audit | implemented + tested (API; staff UI in 11) | 7/11 |
| W7 | Chapa checkout + webhook auth + verify | **blocked** (T-01, B1, B2) | 14 |

## Maps, fleet, zones (H)

| Req | Requirement | Status | Phase / blocker |
|---|---|---|---|
| M1 | Nearby scooters, details, freshness | implemented (`/v1/rider/scooters/nearby`, lookup with reasons) | 6 |
| M2 | Zones (service/parking/restricted) server-side validation | implemented (GeoJSON validation, point-in-polygon, bbox serving, service-area alerts); real zones blocked on D-ZONES | 6 |
| M3 | Fleet onboarding, assignment, maintenance, offline | implemented (admin onboarding, assignment, retire, maintenance/repositioning tasks, alerts, offline/stale sweeps) | 6 |
| M4 | QR + manual code | planned | 9/10 |
| M5 | Mapbox web + mobile | planned; real tokens blocked (B5) | 9/10 |

## Rides (I)

| Req | Requirement | Status | Phase |
|---|---|---|---|
| R1 | Explicit state machine incl. reservation, pause, review | implemented + tested (`apps/api/test/rides.test.ts`; simulated devices) | 8 |
| R2 | One active ride per rider; exclusive scooter | implemented + tested (concurrent start races) | 3/8 |
| R3 | Idempotent start/end; pricing snapshots; server time | implemented + tested | 8 |
| R4 | Insufficient balance blocks start | implemented + tested | 8 |
| R5 | Recovery, timeouts, late acks → review, no unsafe hardware action | implemented + tested (timeouts, late acks, recovery sweep, alerts only) | 6/8 |

## IoT (J)

| Req | Requirement | Status | Phase / blocker |
|---|---|---|---|
| I1 | Adapter interface + labelled simulator | implemented + **simulated** (3-process smoke: API + worker + gateway) | 6 |
| I2 | Internal authenticated gateway↔API contract | implemented (`/internal/v1`, service token) | 6 |
| I3 | Real TCP protocol | **blocked** (D-IOT, B6) | 15 |

## Clients (K, L)

| Req | Requirement | Status | Phase |
|---|---|---|---|
| C1 | Rider mobile screens (product-spec §5) | implemented + tested (jest component/unit tests, JS bundle export); map **blocked** (B1/B5, list fallback); native build **blocked** (B9) | 9 |
| C2 | Rider web screens | implemented + tested (Playwright E2E: real API, worker, PostgreSQL, fake payments, simulated gateway); map **blocked** (B1/B5) | 10 |
| C3 | Admin tools | planned | 11 |
| C4 | Operator tools | planned | 11 |
| C5 | CSV exports with formula-injection protection | planned | 11 |
| C6 | Localization support; approved translations | scaffolding implemented (mobile, English only); translations blocked (D-L10N) | 9–11 |

## Deployment and distribution (N, O)

| Req | Requirement | Status | Phase / blocker |
|---|---|---|---|
| D1 | Hosting evaluation and deployment docs | planned | 13 |
| D2 | Staging deploy | blocked (B7, authorization) | 13 |
| D3 | EAS profiles and identifiers | planned | 9 |
| D4 | Native builds | blocked (B9) | 9 |
| D5 | Store checklists | planned | 13 |
