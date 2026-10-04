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
| F7 | Rate limits (auth, expensive endpoints) | — | — | planned (Phase 4) | |
| F8 | Explicit CORS | — | — | planned (Phase 4) | |
| F9 | Secure cookies + CSRF | — | — | planned (Phase 4) | |
| F10 | Bounded request sizes | Fastify `bodyLimit` | 413 test | implemented | default 1 MiB |
| F11 | Health/readiness without secrets | `apps/api/src/routes/health.ts` | health tests | implemented | |
| F12 | Audit records for sensitive staff actions | — | — | planned (Phase 5) | |
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
| A1 | Rider registration/login via OTP | planned | 4 |
| A2 | Hashed OTP, expiry, attempts, cooldowns, abuse controls | planned | 4 |
| A3 | Sessions: expiry, refresh, logout, revocation | planned | 4 |
| A4 | Secure mobile token storage | planned | 9 |
| A5 | Browser sessions (cookies + CSRF) | planned | 4/10 |
| A6 | Suspension and deletion with financial retention | planned | 4/5 |
| A7 | Profile/contact change with re-verification | planned | 4 |
| A8 | Staff provisioning (no public admin sign-up) | planned | 4/5 |
| A9 | Real email adapter | planned / blocked on provider choice (B4) | 4, 14 |
| A10 | Real GeezSMS adapter | blocked (official docs B1, account B3) | 14 |
| A11 | Backend permission enforcement + cross-user tests | planned | 5 |

## Wallet and payments (G)

| Req | Requirement | Status | Phase / blocker |
|---|---|---|---|
| W1 | Balances (ledger, held, available) + history | planned | 7 |
| W2 | Top-up ≥ 500 ETB, unique references, state machine | planned | 7 |
| W3 | Verify-before-credit; never credit from redirect | planned | 7 |
| W4 | Idempotent duplicate/reordered events | planned | 7 |
| W5 | Reconciliation when webhooks fail | planned | 7 |
| W6 | Refunds and staff adjustments with audit | planned | 7/11 |
| W7 | Chapa checkout + webhook auth + verify | **blocked** (T-01, B1, B2) | 14 |

## Maps, fleet, zones (H)

| Req | Requirement | Status | Phase / blocker |
|---|---|---|---|
| M1 | Nearby scooters, details, freshness | planned | 6 |
| M2 | Zones (service/parking/restricted) server-side validation | planned | 6 |
| M3 | Fleet onboarding, assignment, maintenance, offline | planned | 6 |
| M4 | QR + manual code | planned | 9/10 |
| M5 | Mapbox web + mobile | planned; real tokens blocked (B5) | 9/10 |

## Rides (I)

| Req | Requirement | Status | Phase |
|---|---|---|---|
| R1 | Explicit state machine incl. reservation, pause, review | planned | 8 |
| R2 | One active ride per rider; exclusive scooter | implemented at DB level (partial unique indexes); engine Phase 8 | 3/8 |
| R3 | Idempotent start/end; pricing snapshots; server time | planned | 8 |
| R4 | Insufficient balance blocks start | planned | 8 |
| R5 | Recovery, timeouts, late acks → review, no unsafe hardware action | planned | 6/8 |

## IoT (J)

| Req | Requirement | Status | Phase / blocker |
|---|---|---|---|
| I1 | Adapter interface + labelled simulator | planned | 6 |
| I2 | Internal authenticated gateway↔API contract | planned | 6 |
| I3 | Real TCP protocol | **blocked** (D-IOT, B6) | 15 |

## Clients (K, L)

| Req | Requirement | Status | Phase |
|---|---|---|---|
| C1 | Rider mobile screens (product-spec §5) | planned | 9 |
| C2 | Rider web screens | planned | 10 |
| C3 | Admin tools | planned | 11 |
| C4 | Operator tools | planned | 11 |
| C5 | CSV exports with formula-injection protection | planned | 11 |
| C6 | Localization support; approved translations | planned; translations blocked (D-L10N) | 9–11 |

## Deployment and distribution (N, O)

| Req | Requirement | Status | Phase / blocker |
|---|---|---|---|
| D1 | Hosting evaluation and deployment docs | planned | 13 |
| D2 | Staging deploy | blocked (B7, authorization) | 13 |
| D3 | EAS profiles and identifiers | planned | 9 |
| D4 | Native builds | blocked (B9) | 9 |
| D5 | Store checklists | planned | 13 |
