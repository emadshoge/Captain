# Captain — Progress

Update at the end of every task: what changed, how it was verified, what
was not tested, blockers, and the next task.

## Current status

- **Completed phase:** Phase 2 — Configuration hardening and logging
  (pending owner review; CI result below)
- **Next phase:** Phase 3 — Database schema and migrations
- **Branches:** Phase 0–1 `claude/optimistic-cannon-do0z8i` (PR #1, open,
  not merged); Phase 2 `claude/phase-2-config-logging`, stacked on PR #1.

## Log

### 2026-10-04 — Phase 2: Configuration hardening and logging
Preconditions:
- `main` does **not** contain Phase 1. PR #1 is an open draft and `main`
  has only the initial commit. With no owner preference, Phase 2 was
  branched from PR #1's head (`6c33449`) and its PR targets the PR #1
  branch (R-34). Merge PR #1 first, then retarget the Phase 2 PR to `main`.
- Startup hook: ran `.claude/hooks/session-start.sh` with
  `CLAUDE_CODE_REMOTE=true` after stopping PostgreSQL. It installed from
  the lockfile, restarted the cluster, waited for readiness, applied 0
  pending migrations, and exited 0. It did **not** run automatically at
  session start: sessions start from `main`, which lacks `.claude/`.

Changed:
- New `packages/logging`: pino 10 logger factory, layered redaction
  (`isSensitiveKey`, `redactString`, `redactDeep`, `redactUrl`), request
  ID resolution.
- API: Fastify uses the shared logger. Request IDs come from a safe
  `x-request-id` or a UUID and are returned in the header, logs and error
  bodies. Central error handler and 404 handler with the
  `{ error: { code, message, details?, requestId } }` envelope;
  `AppError` for client-safe errors. Redacted config summary at startup.
- IoT gateway: structured logs instead of `console.log`, request IDs on
  the health server, standard 404 envelope, explicit SIMULATED warning
  at startup. Still no protocol or commands.
- Config: production refuses `LOG_LEVEL=debug|trace`.
- Contracts: `ErrorResponseSchema` requires `requestId`;
  `COMMON_ERROR_CODES`.

Executed checks (cloud session):
- `pnpm check` exit 0: Prettier, ESLint (0 warnings), typecheck (10
  projects), 112 tests, builds, Expo check.
- Tests by package: config 28, contracts 7, db 7 (real PG 16.14),
  logging 51, api 14 (includes real-DB readiness), iot-gateway 5.
- Behaviour covered by tests:
  - **Redaction:** authorization/Bearer, cookies, passwords, OTP codes,
    tokens, API keys, `DATABASE_URL`, connection strings in messages and
    error messages, child-logger bindings, sensitive query parameters.
    Provider selections stay visible.
  - **Request bodies:** a POST with password/OTP produces no body content
    in logs.
  - **Request IDs:** generated, propagated when safe, replaced when unsafe
    (no injected text in logs), and present on request log lines and in
    error bodies, for both API and gateway.
  - **Errors:**
    - 500 returns a generic message, with the cause logged and redacted;
    - `AppError` passes its code and message through;
    - 404;
    - 400 validation responses contain paths only, never submitted values;
    - malformed JSON returns 400, an oversized body 413, and an unsupported
      media type 415.
  - **Config:** production guard rules plus debug/trace levels; invalid
    values never echoed in error messages; multiple issues reported together.
- Built bundles run from outside the repo:
  - **API:** JSON log lines with `requestId`; config summary shows
    `DATABASE_URL: [REDACTED]` and provider names; zero secret strings in
    the captured log; no deprecation warnings.
  - **Production guard:** `LOG_LEVEL=debug` in production exits 1.
  - **Gateway:** structured logs, the SIMULATED warning, and a 404 with
    `requestId`.
- The smoke test caught and fixed two issues before commit: OTP provider
  setting names were over-redacted, and the Fastify options
  `requestIdLogLabel`/`disableRequestLogging` were deprecated (replaced
  with `LogController`).

Skipped / not tested:
- **Log shipping and retention:** no log destination or aggregation
  service. Logs go to stdout, and the hosting provider is undecided
  (D-HOST).
- **Production-scale tests:** no load or performance testing of the
  redaction overhead.
- **`trustProxy` and client IP handling:** not configured; they depend on
  the hosting topology.
- **Authentication and authorization:** still none (Phase 4–5).
  `UNAUTHORIZED`/`FORBIDDEN` codes exist in the envelope but nothing
  produces them yet.
- **Mobile and web apps:** no logging changes (client-side logging is out
  of scope).

Blockers:
- None for Phase 3.
- The Phase 2 PR cannot target `main` cleanly until PR #1 is merged.

### 2026-10-04 — Phase 1 final CI verification
- Run **37209327708** on commit **`6c33449`** (head of PR #1): both jobs
  passed.
  - Checks job: format, lint, typecheck, tests against `postgres:16`, and
    builds.
  - Mobile job: Expo bundles and `expo-doctor` "21/21 checks passed. No
    issues detected!".
- Earlier green runs: 37209133576 (`19013c4`), 37209243914 (`abd1409`).
- Phase 1 permission status unchanged: no authentication or authorization
  is implemented (see the Phase 1 entry).


### 2026-10-04 — Phase 1: Cloud setup, skeletons, automated checks
Changed:
- pnpm workspace with `apps/api`, `apps/iot-gateway`, `apps/rider-mobile`,
  `apps/rider-web`, `apps/staff-web` (`/admin`, `/operator`), and
  `packages/contracts`, `packages/config`, `packages/db`,
  `packages/tsconfig`. Committed `pnpm-lock.yaml`, exact versions.
- API: `GET /health` (liveness) and `GET /ready` (DB reachable + no
  pending migrations; 503 otherwise). No payment, OTP, ride or device code.
- IoT gateway: config + `GET /health` reporting
  `protocol: not_implemented`. No protocol, packets or commands.
- `@captain/config`: Zod env schemas, `APP_ENV` required, production guard
  (fake/log-only/simulated providers, `DEV_*`, `ALLOW_FAKE_*`, `FAKE_*`,
  `SIMULATED_*`, `OTP_FIXED_CODE`/`OTP_DEV_CODE`). Errors never include values.
- `@captain/db`: Drizzle schema (`app_settings`), SQL migration
  `0000_init`, migration runner + status, `db:migrate` CLI (refuses
  production), `createTestDatabase()` helper.
- `scripts/cloud-setup.sh`, `scripts/db-local.sh`, SessionStart hook in
  `.claude/settings.json`. Setup guide: `docs/cloud-setup.md`.
- GitHub Actions `ci.yml`: checks job with a `postgres:16` service, and a
  mobile job (Expo bundles + expo-doctor).

Executed checks (cloud session, 2026-10-04):
- Setup via the hook: run 1 (fresh: initdb, start, create DBs, migrate),
  run 2 (server running: reused, 0 migrations applied), run 3 (after
  `stop`: reused cluster, restarted). All exit 0.
- Safety: setup refuses `APP_ENV=production`; db-local refuses
  `APP_ENV=staging` and an in-repo data dir (checked before creating
  anything); hook is a no-op outside cloud sessions; cluster owned by
  `postgres`, data dir mode 0700.
- `pnpm check` exit 0: Prettier, ESLint (0 warnings), typecheck (9
  projects), tests, builds, Expo check.
- Tests: 35 passed. config 16, contracts 6, db 7 (real PG 16.14: version,
  pending → applied → idempotent re-run, jsonb round trip, PK and CHECK
  violations, helper refusals), api 3 (`/health`; `/ready` 503 with DB
  down; `/ready` 503 pending → 200 after migrating, real DB), iot-gateway 3.
- With the DB stopped, DB tests fail with a clear "cannot reach
  PostgreSQL … run `pnpm db:local start`" message (no silent skip).
- Builds: API and gateway esbuild bundles; `next build` for rider-web and
  staff-web (static routes `/`, `/admin`, `/operator`).
- Built API run from a copy **outside the repo**: `/health` 200, `/ready`
  200 against `captain_dev`. Built API with `APP_ENV=production
  PAYMENT_PROVIDER=fake` and gateway with `DEVICE_ADAPTER=simulated` both
  exit 1 with a guard message.
- Expo: `expo config` resolves (SDK 57.0.0); `expo export` produced
  Android and iOS Hermes bundles. `pnpm install` reports no peer warnings.
- `expo-doctor`: 19/21 checks passed; the 2 failures need `api.expo.dev` /
  `reactnative.directory`, which the egress proxy blocks. The full doctor
  runs in CI.
- Git: no `.env`, keys, `dist/`, `.next/`, `next-env.d.ts` or database
  files tracked. Only `.env.example` placeholders. Secret-pattern grep clean.

Permission enforcement status (accurate as of Phase 1):
- **Implemented:** none for users. There is no authentication, no
  sessions or tokens, and no rider/operator/admin authorization anywhere.
  The only access-related controls are:
  - the production config guard (refuses fake/simulated providers);
  - setup and test tooling refusing staging/production and non-local DBs;
  - API log redaction of `authorization` and `cookie` headers.
- **Placeholders:** `staff-web` `/admin` and `/operator` are static pages
  reachable by anyone. They contain no data or actions. The home page
  states that no sign-in or role checks exist yet.
- **Planned:** rider vs staff token audiences and OTP sign-in (Phase 4);
  role-based authorization on `/v1/operator/*` and `/v1/admin/*` with
  permission tests for the product-spec §8 matrix, plus audit log
  (Phase 5); staff-web route guards (Phases 13–14). The API is the
  intended security boundary.

Skipped / not tested:
- **Native mobile build (EAS)**: not attempted. No Expo account access
  (D-EXPO), no `eas.json`. Bundle export is not proof a native build works.
- `expo-doctor` schema and directory checks: blocked in the cloud session;
  covered by the full doctor run in CI (below).
- Mobile app on a device or simulator: not run.
- Next.js apps not exercised in a browser (build only; no E2E yet).

GitHub Actions (run 37209133576, commit 19013c4): **both jobs passed**.
- Checks job: format, lint, typecheck, tests against the `postgres:16`
  service (server 16.15), and builds.
- Mobile job: Expo config + Android/iOS bundle export; `expo-doctor`
  **21/21 checks passed** (including the two network checks blocked in the
  cloud session).

Blockers:
- None for Phase 2. Phase 2 not started (awaiting owner go-ahead).
- Phase 8 blocked on official Chapa docs (T-01). Phase 11 native builds
  blocked on Expo access (D-EXPO).
- Deprecation notices from drizzle-kit's transitive `@esbuild-kit/*`
  packages and an old `uuid` (dev tooling only); revisit on drizzle-kit 1.0.


### 2026-10-04 — Phase 0 corrections (owner review)
Changed:
- Ride completion remodelled: `end_requested → completion_pending →
  completed`, plus `operator_review` and `ride_incidents`. "End ride" is a
  completion request. Billing cutoff, parking validation, device
  confirmation, and failure/refund outcomes are recorded as unresolved
  (D-BILLCUT, D-PARK, D-ENDCONF, D-REFUND). R-21 withdrawn.
- Device safety: no automatic physical command after a late unlock ack
  (incident instead, R-22). Motion-affecting commands are never sent while
  a scooter may be moving (R-23). No automatic retries of physical
  commands (R-24).
- Chapa details marked unverified (T-01). Phase 8 blocked until the
  official docs are available. No Chapa code in Phase 1.
- Dependencies rechecked against npm registry metadata and the projects'
  GitHub repositories (official doc sites are proxy-blocked, T-04).
  TypeScript ~6.0.3 per the Expo SDK 57 template. React is now per app:
  mobile 19.2.3 (Expo pin), web 19.3.0. Turborepo dropped for now.
  Admin and operator share `staff-web`.
- Local PostgreSQL cluster moved outside the repository.


### 2026-10-04 — Phase 0: Documentation and rules
Changed:
- Added `CLAUDE.md`, `docs/product-spec.md`, `docs/architecture.md`,
  `docs/data-model.md`, `docs/implementation-plan.md`, `docs/decisions.md`,
  `docs/progress.md`, `.gitignore`.

Verified (in cloud session):
- Tool versions present: Node 22.22.0, pnpm 10.28.0, Python 3.11, Go 1.24,
  Rust 1.97, Java 21, Chromium 141 (Playwright), gh, gcloud, psql 16,
  redis-cli 7.
- PostgreSQL 16 **server** binaries are installed (not running). A
  throwaway cluster was created with `initdb` as the `postgres` OS user,
  started with `pg_ctl`, queried (`PostgreSQL 16.14`), stopped, and
  deleted.
- Docker CLI installed but **daemon not running** (`docker info` fails).
- Current npm versions checked: expo 57.0.26, next 16.3.8, fastify 5.12.5,
  zod 4.6.5, drizzle-orm 0.45.3, drizzle-kit 0.31.11, pg-boss 12.36.0,
  vitest 5.0.3, @playwright/test 1.63.0, turbo 2.11.7, eas-cli 24.10.0,
  @rnmapbox/maps 10.3.5, mapbox-gl 3.32.0, typescript 6.0.3 / 7.0.2.
- Expo SDK 57 `bundledNativeModules.json`: react-native 0.86.3,
  react 19.2.3, react-dom 19.2.3, react-native-web ~0.21.0.
- Peer ranges: typescript-eslint 8.71 requires TypeScript `<6.1.0`;
  fastify-type-provider-zod 7.0.0 requires fastify ^5.5 and zod ≥4.1.5;
  Next 16.3.8 requires Node ≥20.9 and React ^19.

Not verified / untested:
- Chapa documentation (developer.chapa.co) is **blocked by the egress
  proxy**; Chapa details come from search excerpts only (decision T-01).
- GeezSMS API format not reviewed in detail (T-02).
- Expo account / EAS project access: **not verified**; no `EXPO_TOKEN`
  in the environment (D-EXPO).
- Expo + pnpm monorepo Metro config not yet tried (T-03).
- No application code exists, so no tests were run.

Blockers:
- None for Phase 1.
- Later phases blocked by decisions listed in `docs/decisions.md`
  (D-LOGIN, D-PRICE, D-MINBAL, D-IOT, D-EXPO, D-HOST, …).
