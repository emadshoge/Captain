# Captain — Architecture

Status: Phase 0. Versions below were checked against the npm registry and
the Expo SDK 57 `bundledNativeModules.json` on 2026-10-04. Re-check when a
phase installs them; record changes in `docs/decisions.md`.

## 1. System overview

```
 ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
 │ Rider mobile │ │  Rider web   │ │ Admin web    │ │ Operator web │
 │ Expo / RN    │ │  Next.js     │ │ Next.js      │ │ Next.js      │
 └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
        │ HTTPS/JSON      │                │                │
        └────────────┬────┴────────────────┴────────────────┘
                     ▼
            ┌─────────────────┐   webhooks/verify   ┌──────────┐
            │   Backend API   │◄───────────────────►│  Chapa   │
            │ Fastify + Zod   │                     └──────────┘
            │                 │──► EmailProvider / GeezSMS (OTP)
            └───┬─────────┬───┘
                │ SQL     │ DeviceGateway interface (internal)
                ▼         ▼
        ┌────────────┐  ┌───────────────────────────────┐
        │ PostgreSQL │  │ IoT gateway                   │
        │  (16+)     │  │  - SimulatedAdapter (dev/stg) │
        └────────────┘  │  - SupplierTcpAdapter (later) │
                        └──────────────┬────────────────┘
                                       │ TCP (supplier protocol, TBD)
                                       ▼
                                   Scooters
```

## 2. Monorepo layout (pnpm workspaces)

```
apps/
  api/            Backend API (Fastify)
  iot-gateway/    Device gateway process (simulator first; supplier TCP later)
  rider-mobile/   Expo app (Android/iOS)
  rider-web/      Next.js rider web app
  admin-web/      Next.js admin dashboard
  operator-web/   Next.js operator dashboard
packages/
  contracts/      Zod schemas + inferred types for every API request/response
  config/         Typed env loading + production safety guard
  db/             Drizzle schema, migrations, DB test helpers
  domain/         Pure business logic (ride state machine, fare calc, ledger rules)
  ui-web/         Shared React components for the three Next.js apps (optional)
  tsconfig/       Shared tsconfig bases
  eslint-config/  Shared lint config
docs/
```

Rationale: one repo, one lockfile, shared contracts imported by both
server and clients so request shapes cannot drift.

## 3. Technology choices

| Concern | Choice | Verified version (2026-10-04) | Notes |
|---|---|---|---|
| Runtime | Node.js 22 LTS | 22.22.0 in cloud image | Next 16 needs ≥20.9 |
| Package manager | pnpm | 10.28.0 | workspaces; `node-linker=hoisted` likely needed for Expo app (verify in Phase 1) |
| Language | TypeScript **6.0.x** | 6.0.3 | **Not 7.0**: `typescript-eslint` 8.71 peer range is `>=4.8.4 <6.1.0` |
| Task runner | Turborepo | 2.11.7 | cached lint/typecheck/test/build |
| API framework | **Fastify 5** | 5.12.5 | see §4 |
| Schema/validation | Zod 4 | 4.6.5 | `fastify-type-provider-zod` 7.0.0 needs zod ≥4.1.5, fastify ^5.5 |
| ORM / migrations | Drizzle ORM + drizzle-kit, `pg` driver | 0.45.3 / 0.31.11 / 8.23.1 | SQL-first; plain SQL migrations committed |
| Job/timeouts | pg-boss (PostgreSQL-backed) | 12.36.0 | avoids Redis; see §8 |
| Mobile | Expo SDK 57, Expo Router | expo 57.0.26 | SDK 57 pins **react-native 0.86.3, react 19.2.3** |
| Mobile maps | `@rnmapbox/maps` | 10.3.5 | not in Expo Go → requires development builds (EAS) |
| Mobile QR/location | `expo-camera`, `expo-location` | ~57.0.x | |
| Web | Next.js 16 (App Router) | 16.3.8 | React peer `^19` → pin React **19.2.3** repo-wide to match Expo |
| Web maps | `mapbox-gl` | 3.32.0 | |
| Unit/integration tests | Vitest | 5.0.3 | |
| E2E web tests | Playwright | 1.63.0 | Chromium pre-installed in cloud image |
| Mobile builds | EAS Build (cloud) | eas-cli 24.10.0 | account access **not yet verified** |

Compatibility notes:
- React must be a single version (19.2.3) across the workspace while Expo
  SDK 57 pins it; upgrading web React independently risks duplicate React
  in the shared packages.
- `typescript` 7.x (native compiler) is excluded until typescript-eslint
  and Next.js type checking officially support it.
- Expo monorepo setup (Metro, pnpm) must be validated in Phase 1 against
  the Expo "Work with monorepos" guide for SDK 57.

## 4. Backend framework recommendation: Fastify

Recommendation: **Fastify 5 with `fastify-type-provider-zod`**, organized
as feature modules (auth, riders, wallet, payments, rides, fleet, devices,
admin, operator), with business rules in `packages/domain`.

Why Fastify over NestJS / Express:
- **Shared contracts:** Zod schemas from `packages/contracts` plug directly
  into route definitions for validation, serialization, and OpenAPI
  generation (`@fastify/swagger`). NestJS's idiomatic path is
  class-validator DTOs, which would duplicate the contracts.
- **Performance and low overhead** for many small polling/ack requests from
  apps, on modest hosting.
- **Plugin encapsulation** gives clear module boundaries without a DI
  framework; testable with `app.inject()` (no network needed in tests).
- **Mature, maintained, Node 20+**, first-class TypeScript, good ecosystem
  (`@fastify/rate-limit`, `@fastify/helmet`, `@fastify/cors`).
- Express lacks built-in schema validation and has a weaker type story.

Trade-off: no enforced architecture like NestJS — mitigated by the module
conventions and lint rules defined in Phase 1.

## 5. API boundaries

All endpoints under `/v1`. Three audiences with separate route prefixes
and separate token audiences:

| Prefix | Audience | Examples |
|---|---|---|
| `/v1/auth/*` | public | request OTP, verify OTP, refresh, logout |
| `/v1/rider/*` | rider token | profile, nearby scooters, wallet, top-ups, rides |
| `/v1/operator/*` | staff token with `operator` or `admin` role | fleet, scooter status, service commands, ride reviews |
| `/v1/admin/*` | staff token with `admin` role | riders, adjustments, pricing, zones, staff, audit |
| `/v1/webhooks/chapa` | Chapa (signature verified) | payment events |
| `/internal/*` | IoT gateway ↔ API (service token, private network) | device events, command results |

Key rider endpoints (shapes defined in `packages/contracts`):
- `GET /v1/rider/scooters?near=lat,lng&radius=` 
- `POST /v1/rider/topups` → `{ amountSantim }` → `{ topupId, checkoutUrl }`
- `GET /v1/rider/topups/:id` → status (`pending|succeeded|failed|expired`)
- `GET /v1/rider/wallet` → `{ availableSantim, heldSantim, ledgerBalanceSantim }`
- `POST /v1/rider/rides` → `{ scooterCode }` (from QR), `Idempotency-Key` header → ride
- `GET /v1/rider/rides/:id`
- `POST /v1/rider/rides/:id/end` (`Idempotency-Key`)

Cross-cutting:
- **Idempotency-Key** required on all POSTs that create money movement or
  device commands; stored and replayed.
- Errors: `{ error: { code, message, details? } }` with stable codes
  (e.g. `INSUFFICIENT_BALANCE`, `SCOOTER_UNAVAILABLE`, `DEVICE_TIMEOUT`).
- Auth: short-lived access JWT + rotating refresh token stored hashed in DB.
  Token `aud` is `rider` or `staff`. Roles checked per route.
- Clients poll ride/top-up status; push/WebSocket deferred until needed.

## 6. Provider interfaces (ports)

Each external dependency is an interface with a real and a fake adapter:

| Port | Real adapter | Fake adapter (dev/staging only) |
|---|---|---|
| `PaymentProvider` | `ChapaProvider` | `FakePaymentProvider` |
| `OtpSender` (email) | SMTP/email API (provider TBD) | `LogOnlyEmailSender` (writes to dev outbox, code redacted in logs) |
| `OtpSender` (SMS) | `GeezSmsSender` | `LogOnlySmsSender` |
| `DeviceGateway` | `SupplierTcpAdapter` (**later**, from supplier docs) | `SimulatedDeviceAdapter` |
| `MapTiles` | Mapbox (client-side token) | – |

### Production safety guard (`packages/config`)
At process start, config is parsed with Zod. If `APP_ENV=production` and
any of these hold, the process **exits non-zero**:
- payment provider ≠ `chapa`, or a Chapa **test** key is configured;
- any OTP sender is a log-only/fake sender, or a fixed/dev OTP code is set;
- device adapter is `simulated`, or any device row with
  `is_simulated = true` is eligible for rental (checked at startup and
  enforced by query filter);
- any `DEV_*` / `ALLOW_FAKE_*` variable is set.
There is no override flag. Unit tests cover each rule.

### Chapa integration (verify again in Phase 8)
From Chapa developer docs (developer.chapa.co — **blocked by this cloud
environment's egress proxy**; details below came from search excerpts and
must be re-verified from the official docs before implementation):
- Initialize: `POST https://api.chapa.co/v1/transaction/initialize` with
  amount, currency `ETB`, `tx_ref`, callback/return URLs → `checkout_url`.
- Verify: `GET https://api.chapa.co/v1/transaction/verify/{tx_ref}`.
- Webhooks: HMAC-SHA256 signatures in `chapa-signature` /
  `x-chapa-signature` headers using the merchant's secret.
- Provider amount limits: unknown; read from docs/merchant account and
  surface provider errors. Captain enforces only the 500 ETB minimum.

### GeezSMS (verify in Phase 4)
GeezSMS publishes an HTTP API (Postman docs:
https://documenter.getpostman.com/view/11254016/TzK2YZ2J) including an OTP
endpoint. Exact request format to be confirmed from those docs when
implementing. Captain generates and verifies its own OTP codes (hashed in
DB) unless a decision says to use GeezSMS's hosted OTP.

## 7. Wallet ledger and payment verification

Model: **double-entry, append-only ledger** in santim (`bigint`).

Accounts (`ledger_accounts`): per-rider `rider_wallet`, plus system
accounts `chapa_clearing`, `ride_revenue`, `refunds_expense`,
`adjustments`.

Every money event is one `ledger_transactions` row with ≥2
`ledger_entries` whose signed amounts sum to zero (DB constraint via
deferred trigger + domain check).

| Event | Debit | Credit |
|---|---|---|
| Top-up verified | chapa_clearing | rider_wallet |
| Ride charge | rider_wallet | ride_revenue |
| Refund to wallet | refunds_expense | rider_wallet |
| Admin adjustment | adjustments ↔ rider_wallet | (reason + actor required) |

- **Ledger balance** = sum of entries for the rider wallet.
- **Holds** (`wallet_holds`) reserve funds while a ride is active, if the
  minimum-balance/hold policy requires it (**[OPEN D-MINBAL / D-LOWBAL]**).
- **Available balance** = ledger balance − active holds. Ride start
  requires available ≥ configured minimum.
- Balance checks and charges run in a single DB transaction with
  `SELECT … FOR UPDATE` on the rider's wallet account row, so concurrent
  ride starts/top-ups cannot double-spend.
- Negative balances: whether a final fare may take the wallet below zero
  is **[OPEN D-LOWBAL]**; schema allows it, policy decides.

Top-up / payment verification flow:
1. `POST /topups` validates amount ≥ 50 000 santim, creates `payments` row
   (`pending`, unique `tx_ref`), calls Chapa initialize, returns checkout URL.
2. Credit happens **only** after server-side verification: webhook with a
   valid signature **and** a `verify` call confirming status success,
   amount, and currency match the `payments` row.
3. Credit is idempotent: unique constraint on `ledger_transactions
   (source_type='payment', source_id)` — duplicate webhooks/polls do nothing.
4. A scheduled job verifies `pending` payments older than N minutes (webhook
   lost) and expires stale ones.
5. Mismatched amount/currency → `payments.status = 'review'`, no credit,
   admin alert.
6. Raw provider payloads stored in `payment_events` for reconciliation
   (no card data is ever received; Chapa hosts checkout).

## 8. Ride state machine and failure recovery

```
              start request (checks pass)
                     │
                     ▼
             ┌───────────────┐  ack fail / timeout  ┌───────────────┐
             │ unlock_pending├─────────────────────►│ unlock_failed │ (terminal, no charge)
             └──────┬────────┘                      └───────────────┘
                    │ unlock ack ok
                    ▼
             ┌───────────────┐ pause (if allowed)  ┌────────┐
             │    active     │◄───────────────────►│ paused │  [OPEN D-PAUSE]
             └──────┬────────┘                      └────────┘
                    │ end request
                    ▼
             ┌───────────────┐ lock ack ok        ┌─────────┐
             │ lock_pending  ├───────────────────►│  ended  │ (fare charged)
             └──────┬────────┘                    └─────────┘
                    │ retries exhausted
                    ▼
             ┌─────────────────┐ operator confirms ┌─────────┐
             │ end_unconfirmed ├──────────────────►│  ended  │
             └─────────────────┘                   └─────────┘
```

Rules:
- Every transition is a row in `ride_events` and is applied with an
  optimistic check (`UPDATE … WHERE status = <expected>`).
- One non-terminal ride per rider and per scooter (partial unique indexes).
- Billable time: from unlock ack timestamp to the rider's end request
  timestamp (not lock ack), so device slowness never costs the rider.
  Final rule under **[OPEN D-REFUND / D-PRICE]**.
- If an unlock ack arrives **after** the ride was marked `unlock_failed`,
  the gateway immediately sends a lock command and an operator alert is
  raised; the rider is not charged.
- If the device reports it is locked/moving inconsistently with ride
  state, raise an operator alert; never auto-charge on inferred events.
- API restart: pending commands and their deadlines are in PostgreSQL;
  the timeout worker resumes on boot.
- Rider app crash: ride state is server-side; app restores from
  `GET /rides/current`.

## 9. Device commands, acknowledgments and timeouts

The supplier protocol is unknown, so the internal contract is
protocol-neutral:

- `device_commands` row per command: `id` (UUID, used as correlation id if
  the protocol supports it), `device_id`, `type` (`unlock`, `lock`, …
  — final list only from supplier docs), `status`, `issued_by`, `ride_id?`,
  `attempt`, `sent_at`, `deadline_at`, `acked_at`, `result_payload`.
- Status: `queued → sent → acked | nacked | timed_out | failed`.
- The API writes the command, then the gateway delivers it. The gateway
  reports results via `/internal/device-commands/:id/result`.
- **Timeout**: worker (pg-boss scheduled job) marks `sent` commands past
  `deadline_at` as `timed_out` and drives the ride state machine.
  Initial deadline value is a placeholder (e.g. 15 s) to be tuned from
  supplier specs and field tests.
- **Retries**: lock retries a bounded number of times; unlock does **not**
  auto-retry (rider chooses), to avoid unlocking an abandoned scooter.
- **Never assume success.** Only an explicit ack from the real adapter (or
  the simulator in non-production) moves a ride forward.
- Device offline at command time → fail fast with `DEVICE_OFFLINE`.

Simulated hardware:
- `SimulatedDeviceAdapter` lives in `apps/iot-gateway/src/adapters/simulated`.
- Devices have `is_simulated` (immutable after creation). Simulated devices
  can only be served by the simulated adapter and are excluded from rider
  queries in production.
- Dashboards show a "SIMULATED" badge; logs include `adapter=simulated`.
- Simulator supports scripted outcomes (ack, nack, delay, silence) for tests.

Real hardware (later): `SupplierTcpAdapter` is written **only** from
supplier documentation; until then the directory does not exist.

## 10. Redis — not used initially

No current requirement justifies Redis:
- Job queue/timeouts → pg-boss on PostgreSQL.
- Rate limiting (OTP, login) → PostgreSQL counters or in-process limiter
  on a single API instance.
- Device presence → `devices.last_seen_at` column.

Revisit if: multiple API/gateway instances need low-latency pub/sub for
device events, or rate-limit write load becomes a measured bottleneck.
Recorded in `docs/decisions.md`.

## 11. Environments

| | Development | Staging | Production |
|---|---|---|---|
| Where | Claude Code cloud sessions + GitHub Actions | Hosted (provider **TBD**) | Hosted (provider **TBD**) |
| `APP_ENV` | `development` / `test` | `staging` | `production` |
| PostgreSQL | per-session local PG 16 cluster (see §12) | managed PG 16 | managed PG 16, backups + PITR |
| Payments | Fake or Chapa **test** keys | Chapa test keys | Chapa live keys |
| OTP | log-only senders allowed | real providers preferred; log-only allowed with banner | real providers only |
| Devices | simulator | simulator + real test devices (labelled) | real only |
| Mobile build | EAS `development` profile | EAS `preview` (internal distribution) | EAS `production` (store) |
| Deploy trigger | none | manual, from `main` | manual, tagged release, owner approval |

Secrets live in the hosting provider's secret store, GitHub Actions
secrets, and EAS environment variables — never in the repo. Each app has a
committed `.env.example` with placeholders.

Production deployment is never performed during development tasks.

## 12. Test database strategy (PostgreSQL)

Goal: identical PostgreSQL major version everywhere; no SQLite or fakes.

**Cloud sessions (Claude Code):** The cloud image ships the
`postgresql-16` **server** package (verified 2026-10-04: `initdb`,
`pg_ctl`, `postgres` present under `/usr/lib/postgresql/16/bin`; a
throwaway cluster started successfully). No server runs by default.
Phase 1 adds `scripts/db-local.sh` that:
- creates a cluster in a project-local, git-ignored dir
  (e.g. `.local/pg`) owned by the `postgres` OS user (initdb refuses root);
- starts it on a Unix socket + localhost port with `pg_ctl -w`;
- creates `captain_dev` and `captain_test` databases;
- is idempotent and invoked from a Claude Code SessionStart hook.
If the binaries are missing in a future image, the script installs
`postgresql-16` via apt (if network allows) or fails with a clear message.

**GitHub Actions:** `services: postgres:16` container with health check;
`DATABASE_URL` points at it. Same migrations, same tests.

**Tests:** integration tests run migrations once, then each test runs in a
transaction rolled back at the end (or uses a fresh schema per worker).
PostGIS: not required until zones are decided (**[OPEN D-ZONES]**); if
adopted, add `postgresql-16-postgis-3` (available in apt, not installed) and
use the `postgis/postgis:16-*` image in CI.

Rejected alternatives: SQLite (incompatible SQL/locking), PGlite (useful
but not identical to server behavior for locking/concurrency tests),
Testcontainers (requires Docker, unavailable).

## 13. Mobile cloud build strategy (EAS)

- Expo SDK 57, Expo Router, TypeScript; app in `apps/rider-mobile`.
- `@rnmapbox/maps` requires native code → **development builds** instead of
  Expo Go. Mapbox download token stored as an EAS secret.
- `eas.json` profiles: `development` (dev client, internal), `preview`
  (internal APK / ad-hoc or TestFlight), `production` (store).
- Builds triggered from cloud sessions (`eas build --non-interactive`) or
  GitHub Actions, authenticated with `EXPO_TOKEN` (GitHub/environment
  secret). JS-only changes via EAS Update channels per profile.
- Android first (no Apple account dependency); iOS requires an Apple
  Developer account and credentials managed by EAS.
- **Status:** Expo account and project access are **not verified**. No
  `EXPO_TOKEN` is present in the cloud environment and no EAS project ID
  exists. No build may be claimed submittable until verified (Phase 11).

## 14. Security baseline

- OTP codes: random 6 digits, stored as hash, 5-minute TTL, attempt limits,
  resend cooldown; never logged in full.
- Staff accounts separate from riders; admin actions audited.
- Webhook signature verification with constant-time compare.
- Rate limiting on auth and ride-start endpoints.
- PII minimization; HTTPS only; CORS restricted to known web origins.
