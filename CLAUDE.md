# CLAUDE.md — Working rules for Captain

Captain is a scooter-sharing rental platform for Ethiopia. Riders find a
scooter, scan its QR code, unlock it, ride, park, and end the rental.
It is **not** a ride-hailing (driver/passenger) platform.

Read these before starting any task:

- `docs/product-spec.md` — what we are building
- `docs/architecture.md` — how it is built
- `docs/data-model.md` — entities and invariants
- `docs/implementation-plan.md` — phases and acceptance criteria
- `docs/decisions.md` — resolved and **unresolved** decisions
- `docs/progress.md` — current state, blockers, untested behavior
- `docs/traceability.md` — requirement → code → tests → status
- `docs/user-actions.md` — what the owner must do (accounts, decisions)
- `docs/launch-checklist.md` — evidence required before public launch

## Working environment

- All development, tests, and builds run in remote cloud sessions. The
  owner's laptop is only a browser. Never tell the owner to run something
  locally.
- Docker is **not** available unless verified in the current session
  (`docker info`). Do not design steps that depend on it.
- No PostgreSQL or Redis server runs by default. Client tools (`psql`,
  `redis-cli`) do not mean a server exists. Use the documented test
  database strategy (`docs/architecture.md` → "Test database strategy").
- Never substitute an incompatible database (SQLite, in-memory fakes,
  etc.) to make tests pass. Tests that need PostgreSQL run against
  PostgreSQL.
- Mobile binaries are built with Expo EAS cloud builds. Do not claim a
  build can be submitted until Expo account/project access is verified in
  that session.

## Task rules

1. **One phase at a time.** Implement and verify one phase from
   `docs/implementation-plan.md` before starting the next. A single task
   (for example a master work order) may complete several phases
   *sequentially*. Each phase gets its own commit(s), checks, progress
   entry, and (stacked) branch/PR before the next begins. Do not mix work
   from a later phase into an earlier one. Record out-of-phase needs in
   `docs/progress.md`.
2. **Meaningful checks before declaring a phase complete.** Run the
   repository checks (format, lint, typecheck, tests, build — whatever the
   phase's acceptance criteria list) and confirm each acceptance criterion
   with evidence. "It compiles" is not enough when behavior is in scope.
3. **Report untested behavior and blockers explicitly.** Every task ends
   with a report that lists: what was verified and how, what was not
   tested and why, and any blocker. Mirror this in `docs/progress.md`.
4. **No secrets committed or printed.** Never commit `.env` files, keys,
   tokens, or credentials. Never echo secret values in logs, commands, or
   reports — refer to them by variable name only. Commit `.env.example`
   files with placeholder values.
5. **Save progress and decisions in the repository.** Update
   `docs/progress.md` at the end of every task. Record any decision (or
   newly discovered open question) in `docs/decisions.md`. Chat history is
   not a record.
6. **No production deployment during development tasks.** Never deploy to
   production, run production migrations, or use production credentials.
   Staging deploys only when the phase explicitly calls for it.

## Status vocabulary (use it exactly)

- **Implemented**: code exists and automated tests pass.
- **Simulated**: works only against a fake/simulated provider or device.
- **Blocked**: needs an external input (docs, account, decision, hardware).
- **Verified**: confirmed with real evidence (real OTP received, real
  payment credited once, real scooter unlocked…). Compiling, mock tests
  and inaccessible documentation are never verification.

## Product safety rules (non-negotiable)

- **Never invent supplier IoT packet formats or commands.** The IoT
  protocol will come from supplier documentation. Until then, only the
  internal `DeviceGateway` interface and a clearly labelled simulator exist.
- **Simulated hardware must be clearly distinguishable from real
  hardware**: separate adapter, `is_simulated` flag on devices, visible
  "SIMULATED" labels in dashboards, and logs tagged with the adapter name.
- **Never issue a device command that could lock wheels or disable
  propulsion while a scooter may be moving.** Such commands need a
  stationary-state check defined from supplier documentation. Never send
  physical commands automatically to recover from errors (for example a
  late unlock acknowledgment). Raise an operator-review incident instead.
  Any automated recovery exists only in the simulator, labelled simulated.
- "End ride" is a completion **request**. Billing cutoff, parking
  validation, and device confirmation rules are unresolved decisions
  (D-BILLCUT, D-PARK, D-ENDCONF). Do not hard-code them.
- The Chapa integration details are **unverified** until the official
  docs are reviewed (decision T-01). Do not implement Chapa from search
  snippets.
- **Never enable fake payments, fake OTP, or fake unlock success in
  production.** Fake/simulated providers must be rejected at startup when
  `APP_ENV=production` (see the configuration guard in
  `docs/architecture.md`). Do not add bypass flags.
- Money is stored as integer **santim** (1 ETB = 100 santim) in `bigint`
  columns. Never use floating point for money.
- The wallet ledger is append-only. Corrections are new reversing entries,
  never updates or deletes.
- Do not decide unresolved business rules (pricing, zones, refunds, etc.).
  Make them configurable and leave them listed in `docs/decisions.md`.

## Conventions

- TypeScript everywhere, `strict` mode. pnpm workspaces. Node.js 22 LTS.
- Log only through `@captain/logging`. Never log request bodies or
  headers, and never pass secrets to a log call. Redaction is a safety net,
  not permission. Throw `AppError` for client-safe errors; anything else
  becomes a generic 500.
- Schema changes: edit `packages/db/src/schema/*`, run
  `pnpm --filter @captain/db db:generate`, commit the SQL. A migration
  that adds a history table must add append-only triggers and
  `REVOKE UPDATE, DELETE ... FROM captain_app`.
- Shared request/response schemas live in `packages/contracts` (Zod) and
  are the single source of truth for API shapes.
- Commit messages: imperative mood, describe the phase and change.
- Work on the branch the task names. Do not open pull requests unless asked.
