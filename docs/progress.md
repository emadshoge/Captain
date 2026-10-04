# Captain — Progress

Update at the end of every task: what changed, how it was verified, what
was not tested, blockers, and the next task.

## Current status

- **Completed phase:** Phase 0 — Documentation and rules
- **Next phase:** Phase 1 — Cloud setup, skeletons, automated checks
- **Branch:** `claude/optimistic-cannon-do0z8i`

## Log

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
