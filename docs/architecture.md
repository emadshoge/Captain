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
  iot-gateway/    Device gateway process (no protocol until supplier docs)
  rider-mobile/   Expo app (Android/iOS)
  rider-web/      Next.js rider web app
  staff-web/      Next.js staff app: /admin and /operator route areas
packages/
  contracts/      Zod schemas + inferred types for API requests/responses
  config/         Typed env loading + production safety guard
  db/             Drizzle schema, SQL migrations, migration runner
  domain/         Pure business logic (added when first needed)
  tsconfig/       Shared tsconfig bases
scripts/          Cloud setup and local PostgreSQL scripts
docs/
```

**Admin and operator dashboards share one Next.js app (`staff-web`)**
with separate route areas (`/admin/*`, `/operator/*`). Why:
- Both are used by **staff accounts** (separate from riders) and share
  login, session handling, fleet map and list components.
- Operator capabilities are a subset of admin capabilities (product-spec
  §8), so one app avoids duplicating fleet views.
- One build and one deployment instead of two.
**Planned** separation (Phases 4–5, not implemented yet): route-area
guards in the app plus role checks on every `/v1/operator/*` and
`/v1/admin/*` API route. The API is the security boundary, not the UI.
**Current state (Phase 1):** no authentication or authorization exists
anywhere. The `/admin` and `/operator` pages are static placeholders
reachable by anyone, and the API has only `/health` and `/ready`. If the two need independent
release cycles or domains later, the route areas can be split into two
apps without changing the API.

Internal packages are consumed **as TypeScript source** (`exports` →
`src/index.ts`). They are compiled by each consumer's toolchain: Next.js
`transpilePackages`, Metro, and Vitest. The API and gateway are bundled
with esbuild into **self-contained** `dist/` files, including third-party
dependencies. This is needed because pnpm's isolated layout does not
expose a workspace package's dependencies (e.g. `drizzle-orm` used by
`@captain/db`) to the importing app at runtime. A smoke test of the built
API caught this. The API bundle also carries `dist/migrations` for the
readiness check.

## 3. Technology choices and verified versions

Rechecked on 2026-10-04. Most official documentation sites (docs.expo.dev,
nextjs.org, fastify.dev, orm.drizzle.team, zod.dev) are **blocked by this
environment's egress proxy**. Versions were therefore verified from
first-party sources that are reachable: the npm registry (published
package metadata: versions, `engines`, `peerDependencies`) and the
projects' own GitHub repositories (raw files).

| Concern | Choice | Version | Source & compatibility evidence |
|---|---|---|---|
| Runtime | Node.js 22 LTS | ≥22.12 (cloud image: 22.22.0) | pg-boss 12.36 `engines.node >=22.12.0`; Vitest 5 `^22.12.0 \|\| ^24 …`; Next.js installation doc: Node ≥20.9; Fastify `docs/Reference/LTS.md`: v5 supports Node 20/22/24/26 |
| Package manager | pnpm | 10.28.0 | Expo monorepo guide (`expo/expo` `docs/pages/guides/monorepos.mdx`): from SDK 54 Expo supports pnpm isolated installs; fallback `nodeLinker: hoisted` |
| Language | TypeScript | ~6.0.3 | Expo SDK 57 default template (`expo/expo@sdk-57` `templates/expo-template-default/package.json`) uses `~6.0.3`; typescript-eslint peer `>=4.8.4 <6.1.0`; Next.js minimum TS 5.1. **Not 7.x.** |
| Mobile | Expo SDK 57 + Expo Router | expo ~57.0.26, expo-router ~57.0.24 | `expo/expo@sdk-57` `packages/expo/bundledNativeModules.json` and default template |
| Mobile RN/React | react-native 0.86.3, react 19.2.3, @types/react ~19.2.2 | exact pins | Same SDK 57 files |
| Web | Next.js 16 (App Router) | 16.3.8 | npm: `peerDependencies.react ^18.2.0 \|\| ^19.0.0`, `engines.node >=20.9.0` |
| Web React | react / react-dom | 19.3.0 (latest stable) | npm `dist-tags.latest`; satisfies Next 16 peer range |
| API | Fastify | 5.12.5 | npm `dist-tags.latest` (6.x is alpha) |
| Validation | Zod | 4.6.5 | npm latest |
| Fastify ↔ Zod | fastify-type-provider-zod | 7.0.0 | npm peers: fastify ^5.5.0, zod >=4.1.5 |
| ORM / migrations | drizzle-orm / drizzle-kit, `pg` driver | 0.45.3 / 0.31.11 / 8.23.1 | npm `dist-tags.latest` (1.0 is still `rc`); drizzle-orm peer `pg >=8` |
| Jobs/timeouts | pg-boss | 12.36.0 | npm; requires Node ≥22.12. **Not installed until it is needed** (device timeouts phase) |
| Tests | Vitest | 5.0.3 | npm `engines`, peers |
| E2E web | Playwright | 1.63.0 | Chromium pre-installed in cloud image (later phases) |
| Mobile builds | EAS Build | eas-cli 24.10.0 | account access **not verified** |
| Maps | `@rnmapbox/maps` 10.3.5, `mapbox-gl` 3.32.0 | | added in UI phases, not Phase 1 |

**React versions are not forced to be identical across apps.** The Expo
monorepo guide states that duplicate React versions *within a single app*
cause runtime errors and that duplicate **React Native** versions in one
monorepo are unsupported. It does not require separate apps to share a
React version. Consequences:
- `rider-mobile` uses React 19.2.3 exactly as Expo SDK 57 pins.
- The Next.js apps use React 19.3.0.
- Shared packages (`contracts`, `config`, `db`) do not depend on React. If
  a shared React UI package is ever added, it must declare React as a
  `peerDependency` only.

Exact versions are pinned in every `package.json` (`save-exact`) and by
the committed `pnpm-lock.yaml`. pnpm `autoInstallPeers` is **off**:
otherwise pnpm pulled "latest" peers into the Expo app (react-dom 19.3.0,
react-native-worklets 0.13.0, @react-native/metro-config 0.87.1), which
conflict with SDK 57. Required peers are declared explicitly at the
versions in the SDK 57 template (react-dom 19.2.3, react-native-reanimated
4.5.1, react-native-worklets 0.10.1, react-native-gesture-handler 2.32.0,
@react-native/metro-config 0.86.3). `pnpm install` reports no peer
warnings.

Tooling (Phase 1): ESLint 10.12.0 (flat config), typescript-eslint
8.71.0, eslint-plugin-react-hooks 7.1.1, @next/eslint-plugin-next 16.3.8,
Prettier 3.9.9, Vitest 5.0.3 with Vite 8.3.2, esbuild 0.28.2, tsx
4.23.15, expo-doctor 1.20.4. GitHub Actions: `actions/checkout@v7`,
`actions/setup-node@v7`, `pnpm/action-setup@v6` (latest major tags).

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
| `/v1/webhooks/chapa` | Chapa (authenticity check per official docs — **unverified**, Phase 8) | payment events |
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
- payment provider ≠ `chapa`, or Chapa is configured in test mode
  (detection method to be defined from the official docs);
- any OTP sender is a log-only/fake sender, or a fixed/dev OTP code is set;
- device adapter is `simulated`, or any device row with
  `is_simulated = true` is eligible for rental (checked at startup and
  enforced by query filter);
- any `DEV_*` / `ALLOW_FAKE_*` variable is set.
There is no override flag. Unit tests cover each rule.

### Chapa integration — **UNVERIFIED, not designed yet**
The official Chapa developer documentation (developer.chapa.co) is
**blocked by this cloud environment's egress proxy**. The only
information so far comes from web-search excerpts, which **are not
sufficient to define the integration**. These points are
**unverified assumptions** to check, not specifications:
- a transaction initialize endpoint that returns a hosted checkout URL;
- a server-side transaction verify endpoint keyed by Captain's `tx_ref`;
- webhook authenticity via an HMAC-based signature header, with header
  name(s), signed content, secret, and algorithm all to be confirmed;
- provider amount limits are unknown.

Before Chapa work starts (Phase 8), the owner must allow access to the
official docs or provide them. The integration design (endpoints, signature
verification, retry/verify semantics, test-mode behavior) is then written
from those docs and recorded in `docs/decisions.md`. **No Chapa code is
written before then, and none in Phase 1.**

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
2. Credit happens **only** after server-side verification with the
   provider confirming success, amount, and currency match the `payments`
   row. The exact verification mechanism (webhook signature scheme, verify
   endpoint) is **unverified** until the official Chapa docs are reviewed
   (see §6).
3. Credit is idempotent: unique constraint on `ledger_transactions
   (source_type='payment', source_id)` — duplicate webhooks/polls do nothing.
4. A scheduled job verifies `pending` payments older than N minutes (webhook
   lost) and expires stale ones.
5. Mismatched amount/currency → `payments.status = 'review'`, no credit,
   admin alert.
6. Raw provider payloads stored in `payment_events` for reconciliation
   (no card data is ever received; Chapa hosts checkout).

## 8. Ride state machine and failure recovery

Tapping **"End ride" is a request to complete the ride**, not a final
billing event. Completion depends on parking validation and device
confirmation, whose exact rules are unresolved business decisions
(**[OPEN D-BILLCUT, D-PARK, D-ENDCONF, D-REFUND]** in `docs/decisions.md`).

```
   start request (checks pass)
          │
          ▼
  ┌────────────────┐ unlock nack / timeout ┌───────────────┐
  │ unlock_pending ├──────────────────────►│ unlock_failed │ terminal, no charge
  └───────┬────────┘                       └───────┬───────┘
          │ unlock ack                             │ late unlock ack → incident
          ▼                                        ▼
  ┌────────────────┐  pause/resume     ┌──────────────────┐
  │     active     │◄─────────────────►│ paused [D-PAUSE] │
  └───────┬────────┘                   └──────────────────┘
          │ rider taps "End ride"
          ▼
  ┌────────────────┐ parking rejected (policy D-PARK) → back to active
  │ end_requested  ├────────────────────────────────────────────┐
  └───────┬────────┘                                            │
          │ parking accepted / not required                     ▼
          ▼                                                  active
  ┌────────────────────┐ device confirms end        ┌───────────┐
  │ completion_pending ├───────────────────────────►│ completed │ fare finalized & charged
  └───────┬────────────┘                            └───────────┘
          │ timeout / nack / inconsistent telemetry       ▲
          ▼                                               │ operator resolves
  ┌─────────────────┐─────────────────────────────────────┘
  │ operator_review │ (also reachable from any state on incidents)
  └─────────────────┘
```

State meanings:
- `end_requested`: the rider's request time and location are recorded.
  Parking validation runs. Whether this time is the billing cutoff is
  **D-BILLCUT**.
- `completion_pending`: the system is waiting for the device to confirm
  the ride can be completed. The confirmation mechanism depends on the
  supplier protocol (**D-ENDCONF**, **D-IOT**).
- `completed`: completion confirmed by the device or by an operator. Fare
  computed from the pricing snapshot and the cutoff chosen under
  D-BILLCUT, then charged once (idempotent ledger posting).
- `operator_review`: a human must decide. Causes: completion timeout,
  device nack, telemetry inconsistent with ride state, late unlock ack,
  parking dispute. Every entry creates a `ride_incidents` row. The
  operator's resolution records the outcome. Billing and refund
  consequences follow **D-REFUND / D-BILLCUT**. Nothing is charged
  automatically while a ride is in review.

Rules:
- Every transition is a row in `ride_events` and is applied with an
  optimistic check (`UPDATE … WHERE status = <expected>`).
- One non-terminal ride per rider and per scooter (partial unique indexes).
  Terminal states are `unlock_failed` and `completed`.
- **Late unlock ack** (an ack arrives after the ride became
  `unlock_failed`): the system **does not** automatically send a lock or
  any other physical command. It raises a `late_unlock_ack` incident for
  operator review and does not charge the rider. Automated recovery may
  be added only after supplier documentation confirms safe behavior,
  including the stationary-state checks. Until then, any automated
  recovery exists only in the simulator and is labelled simulated.
- The device reporting a state that does not match the ride (for example
  moving after completion) raises an incident. The system never
  auto-charges on inferred events.
- API restart: pending commands and their deadlines are in PostgreSQL, and
  the timeout worker resumes on boot.
- Rider app crash: ride state is server-side; the app restores it from
  `GET /rides/current`.

## 9. Device commands, acknowledgments, timeouts and safety

The supplier protocol is unknown, so the internal contract is
protocol-neutral and **defines no supplier packet formats or command
codes**.

- `device_commands` row per command: `id` (UUID, used as correlation id if
  the protocol supports one), `device_id`, internal `type`, `status`,
  `issued_by`, `ride_id?`, `attempt`, `sent_at`, `deadline_at`, `acked_at`,
  `result_payload`. The set of internal types and their mapping to real
  commands is defined **only** from supplier documentation.
- Status: `queued → sent → acked | nacked | timed_out | failed`.
- The API writes the command and the gateway delivers it. The gateway
  reports results via `/internal/device-commands/:id/result`.
- **Timeout**: a worker marks `sent` commands past `deadline_at` as
  `timed_out` and drives the ride state machine (usually to
  `operator_review`). Deadline values are placeholders until supplier
  specs and field tests exist.
- **Retries**: no automatic retries of physical commands unless supplier
  documentation states the command is idempotent and safe to repeat.
- **Never assume success.** Only an explicit ack from the real adapter (or
  the simulator outside production) moves a ride forward.
- Device offline at command time → fail fast with `DEVICE_OFFLINE`.

### Motion safety (non-negotiable)
- **Never issue a command that could lock wheels or disable propulsion
  while a scooter is moving**, whether triggered by the system, an
  operator, or an admin.
- Any such command requires a stationary-state check whose method and
  data source come from supplier documentation (e.g. a documented
  speed/motion field). Until that exists, the real adapter does not
  implement these commands. The simulator models them only for testing
  and labels them simulated.
- Low balance, zone violations, and late acks never trigger an automatic
  lock or propulsion cut-off. They create incidents or notifications
  (policy **D-LOWBAL**, **D-ZONES**).

### Simulated hardware
- `SimulatedDeviceAdapter` lives in `apps/iot-gateway/src/adapters/simulated`.
- Devices have `is_simulated` (immutable after creation). Simulated
  devices can only be served by the simulated adapter and are excluded
  from rider queries in production.
- Dashboards show a "SIMULATED" badge, logs include `adapter=simulated`,
  and simulated outcomes are recorded with `simulated=true` in
  `device_commands.result_payload`.
- The simulator supports scripted outcomes (ack, nack, delay, silence) for
  tests.

### Real hardware (later)
`SupplierTcpAdapter` is written **only** from supplier documentation.
Until then that adapter does not exist.

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
`scripts/db-local.sh` (Phase 1):
- creates a cluster **outside the repository** (default
  `/var/tmp/captain-pg16`, override `CAPTAIN_PG_DIR`). If the script runs as
  root, the cluster is owned by the `postgres` OS user and the server runs
  through `runuser`, because PostgreSQL refuses to run as root;
- listens only on `127.0.0.1` and a socket in that directory (default port
  54329, so it can't collide with a system server);
- waits for `pg_isready` before reporting success;
- creates `captain_dev` and `captain_test` databases if missing;
- is idempotent: an existing cluster is reused, a running server is left
  running;
- is invoked by `scripts/cloud-setup.sh` from a Claude Code SessionStart
  hook (`.claude/settings.json`). See `docs/cloud-setup.md`.
If the binaries are missing in a future image, the script fails with a
clear message naming the package (`postgresql-16`).

**GitHub Actions:** `services: postgres:16` container with health check;
`DATABASE_URL` points at it. Same migrations, same tests.

**Tests:** `@captain/db/testing` `createTestDatabase()` creates a fresh,
uniquely named database per test file on the server named by
`TEST_DATABASE_ADMIN_URL` (default: the local cluster) and drops it
afterwards. It refuses `APP_ENV=staging|production` and non-local hosts.
Later phases may add per-test transactions on top.
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
