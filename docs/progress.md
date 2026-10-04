# Captain — Progress

Update at the end of every task: what changed, how it was verified, what
was not tested, blockers, and the next task.

## Current status

- **Completed phase:** Phase 1 — Cloud setup, skeletons, automated checks
- **Next phase:** Phase 2 — Configuration hardening and logging
- **Branch:** `claude/optimistic-cannon-do0z8i`

## Log

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

Skipped / not tested:
- **Native mobile build (EAS)**: not attempted. No Expo account access
  (D-EXPO), no `eas.json`. Bundle export is not proof a native build works.
- `expo-doctor` schema and directory checks: blocked here (see above).
- Mobile app on a device or simulator: not run.
- Next.js apps not exercised in a browser (build only; no E2E yet).
- GitHub Actions result: see the PR checks. Recorded below once known.

Blockers:
- None for Phase 2.
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
