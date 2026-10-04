# Captain — Progress

Update at the end of every task: what changed, how it was verified, what
was not tested, blockers, and the next task.

## Current status

- **Master work order** in progress (plan revision 2).
- **Completed phases:** 0–12 (Phase 12 = performance and resilience).
- **Next phase:** Phase 13 — Deployment preparation (staging deploy blocked)
- **Branches:** Phase 0–1 `claude/optimistic-cannon-do0z8i` (PR #1, open,
  not merged); Phase 2 `claude/phase-2-config-logging` (PR #2, stacked on
  PR #1); Phase 3 `claude/phase-3-data-model` (PR #3); Phase 4
  `claude/phase-4-auth` (PR #4); Phase 5 `claude/phase-5-authz` (PR #5);
  Phase 6 `claude/phase-6-fleet` (PR #6); Phase 7 `claude/phase-7-wallet`
  (PR #7); Phase 8 `claude/phase-8-rides` (PR #8); Phase 9
  `claude/phase-9-mobile` (PR #9); Phase 10 `claude/phase-10-rider-web`
  (PR #10); Phase 11 `claude/phase-11-staff-web` (PR #11); Phase 12
  `claude/phase-12-performance` (stacked on Phase 11).
  Merge order: PR #1 → #2 → Phase 3 PR → later phases.

## Log

### 2026-10-04 — Phase 12: Performance and resilience
CI for Phase 11: run 37232482695 on `c6802c7`, all jobs passed (rider and
staff E2E included).

Changed:
- `apps/api/perf/load.ts`: reproducible load test (built API + worker,
  throwaway DB, PERF scooters, riders via the real OTP flow, scripted
  gateway) with per-operation percentiles, ride lifecycle timings,
  invariants and acceptance thresholds (R-88).
- `apps/api/perf/drills.ts`: API SIGKILL mid-ride, silent device + worker
  killed, database connections terminated, invariants.
- Fix: pool `error` listener in `createPool` (R-87) + regression test.
- CI job `resilience` (drills + 20 s load smoke).
- `docs/performance.md` with measured results.

Executed checks:
- Full load run (300 scooters, 100 riders, 40 riding, 60 s): 0 unexpected
  responses, 440 rides completed, all p95 within the test thresholds,
  ledger balanced (details in `docs/performance.md`).
- Drills 4/4 pass after the fix (the database drill crashed the API
  process before it).
- `pnpm check` green (db tests 30 incl. the pool test).

Not verified: production-like infrastructure, real devices/providers,
soak tests (see `docs/performance.md` → Not tested).

Next: Phase 13 — deployment preparation (staging blocked on hosting).

### 2026-10-04 — Phase 11: Staff web (admin and operator)
CI for Phase 10: run 37231219012 on `0162989`, all jobs passed (including
the first CI run of the rider E2E suite).

Changed:
- API: incidents endpoints (R-85) with tests.
- `apps/staff-web` (Next.js 16): email-code sign-in (+ optional
  authenticator code), permission-aware navigation and page guards
  (R-83), overview counters, fleet list/detail (SIMULATED labels, status
  change, service commands with motion-safety confirmation, maintenance
  tasks, telemetry, commands), alerts (acknowledge/resolve), maintenance
  queue, rides (list, event log, send to review, resolve with
  confirmation), incidents (report/take/resolve), riders (search,
  detail, wallet history, adjustment, refund request,
  suspend/unsuspend), payments (filter, re-verify, CSV download),
  refunds (maker-checker approve/reject, record provider refund),
  onboarding (scooter, device, assignment), pricing plans (list, create
  draft, activate), zones (list, create from GeoJSON), staff (create,
  roles, status, authenticator reset), audit trail, account
  (authenticator enrolment). Confirmations for money/destructive actions
  (R-84).
- E2E harness shared by both web apps (R-86); CI `e2e` job runs both
  suites.

Executed checks:
- `pnpm check` green (API 149 incl. 2 incident tests).
- Staff E2E 3/3: operator sees fleet/incidents but no admin links, gets
  "No access" on `/admin/payments` and 403 from the API with their
  session; changes DEV-0005 to maintenance with a reason; reports, takes
  and resolves an incident. Admin A adjusts a rider wallet (+25 ETB;
  submit disabled until confirmed), an overdraw is refused, requests a
  10 ETB refund that A cannot approve; Admin B approves; balance 35 ETB;
  audit shows the adjustment. Admin C downloads the reconciliation CSV
  and enrols an authenticator (TOTP computed in the test).
- Rider E2E 3/3 still passing with the shared harness.

Bugs found by the E2E run and fixed: audit page expected an array
(API returns `{ entries, nextBefore }`).

Not verified:
- Map-based zone editing (Mapbox blocked); zone creation is GeoJSON text.
- Staff MFA enforcement in the UI flow is exercised only with
  `STAFF_MFA_REQUIRED=false` in E2E (API tests cover enforcement).

Next: Phase 12 — performance and resilience testing.

### 2026-10-04 — Phase 10: Rider web app
CI for Phase 9: run 37230185581 on `2ed351b`, all jobs passed (including
expo-doctor with network access).

Changed:
- `apps/rider-web` (Next.js 16, client components): cookie-session API
  client with in-memory CSRF token and shared refresh (R-78); sign-in
  (SMS/email code), home (current ride, start by scooter code with price
  confirmation and availability reasons), live ride (polling, timer,
  estimate, pause/resume/end with best-effort location), wallet (balance,
  top-up via checkout redirect, history), return page that only asks the
  server to verify (R-79), history and receipts, sign-out. SIMULATED and
  test-pricing labels; provisional styling with dark mode and focus rings.
- API: dev-only fake checkout page now has Pay/Fail links redirecting to
  `RIDER_RETURN_URL` (+ API test).
- IoT gateway fix: no command fetching before the device list is loaded
  (R-81, + regression test).
- Test DB drop made graceful (R-82).
- E2E harness and Playwright specs (R-80); new CI job `e2e`.

Executed checks:
- `pnpm check` green: API 147, gateway 12, mobile 24, others unchanged.
- E2E (local, Chromium from the cloud image): 3/3 passed —
  1. sign in by SMS code (dev outbox), reload keeps the session, top up
     500 ETB through the SIMULATED checkout (signed webhook → server
     verification) and see the balance, start a ride on `DEV-0001`, the
     simulated gateway acks the unlock, end the ride (simulated lock ack),
     charged amount equals the receipt total and the wallet balance;
  2. unknown scooter code and low balance messages;
  3. a cookie-authenticated POST without the CSRF token is refused (403
     CSRF_FAILED); sign-out invalidates the session (401).

Not verified:
- Mapbox map (blocked B1/B5); camera QR scanning on web (manual code
  only, per plan). Real payments/OTP/devices remain simulated.
- CI E2E job runs for the first time with this PR.

Next: Phase 11 — staff web (admin and operator tools).

### 2026-10-04 — Phase 9: Rider mobile app and EAS configuration
CI for Phase 8: run 37229454474 on `d7feaab`, both jobs passed.

Changed (`apps/rider-mobile`):
- API client with typed contracts (type-only), refresh rotation shared by
  concurrent requests, Idempotency-Key support, stable error mapping.
- SecureStore token storage (R-73); session context.
- Screens (expo-router): sign-in (SMS/email code), home (current ride,
  nearby list — map blocked, R-75), scan (QR via expo-camera + manual
  code, availability reasons, price confirmation), ride (polling, timer,
  estimate, pause/resume/end with location), wallet (balance, top-up via
  in-app browser, server verification only, R-74), history and receipt,
  account (sign out, environment label). SIMULATED / test-pricing labels.
- i18n scaffolding (English only; D-L10N), provisional theme tokens
  (D-UI), deep link scheme `captain://` (`wallet-return`).
- `app.json`: permissions text (camera, when-in-use location), microphone
  and background location blocked, plugins; `eas.json` profiles (R-77);
  `expo-dev-client` for development builds.
- Jest (jest-expo) with 24 tests: client refresh single-flight, sign-out
  on refresh failure, idempotency header, error envelope, network errors,
  token storage only after verification; formatting/QR parsing; ride
  model; components: RideCard, Receipt, SignIn flow, Scan flow (start
  with key, unavailable reason, balance error), Wallet (server-verified
  status only, minimum).

Executed checks:
- `pnpm check` green (includes the mobile jest suite and Expo config +
  Android/iOS JS bundle export). Lint/typecheck clean.
- `expo-doctor` locally: 19/21 — the two failures are network-blocked
  remote checks (schema fetch and React Native Directory: "Host not in
  allowlist"); CI runs them with network access.

Not verified:
- **No native build** has been produced; EAS access is unverified (B9).
  The JS bundle export is not a native build.
- Not run on a device/emulator; camera, location and SecureStore were
  exercised only through mocks.
- Map (Mapbox) blocked (B1, B5); payment checkout is the simulated
  provider in development.

Next: Phase 10 — rider web app with Playwright.

### 2026-10-04 — Phase 8: Pricing and ride engine
CI for Phase 7: run 37214437782 on `26afeb6`, both jobs passed.

Changed:
- `@captain/domain` pricing: `timeCharge`, `computeFare`, `chargeableAmount`
  (integer santim, round up to billing increment).
- Ride engine (`apps/api/src/rides/engine.ts`): start (R-64/R-65), unlock
  outcome handling, pause/resume (billing only), end request with parking
  policy and stationary check (R-66/R-67), settlement exactly once with
  floor and unpaid alert (R-69), operator review/resolve (R-71),
  reservations (R-72), recovery and alert sweeps (R-70/R-71).
- Rider API: pricing, start (Idempotency-Key, rate limit), current,
  history, receipt, pause, resume, end, reservations.
- Staff API: ride list/detail with events (rides.read), send to review /
  resolve (rides.review), pricing plans list/create/activate
  (pricing.manage); all mutations audited.
- Config: `RIDE_BILLING_CUTOFF`, `RIDE_END_CONFIRMATION`,
  `RIDE_PARKING_POLICY` (required in staging/production),
  `RIDE_COMPLETION_TIMEOUT_SECONDS`.
- Command listener registry moved into the fleet service so the timeout
  sweep and device results share one path.

Executed checks:
- `pnpm check` green: API tests 146 (22 new ride tests), domain 41
  (8 new pricing), config 41, db 29, gateway 11.
- Ride tests cover: no pricing → 503; plan versioning and permissions;
  production refuses fixture pricing and missing ride policy config;
  full lifecycle with exact event sequence, idempotent start replay,
  idempotent end, duplicate lock ack, single journal; billing cutoff at
  completion; immediate completion; pause billing with no device command;
  end refused while moving or with stale telemetry (no lock command);
  cross-rider 404; minimum balance; nack → no charge, scooter available;
  timeout → no charge, maintenance, incidents, late ack ignored, no
  automatic command; two riders one scooter; concurrent starts by one
  rider; lock nack → review → operator resolve with bounded cutoff;
  operator close without charge; supplier device → review without
  command; crash recovery (acked command, stuck end request); long ride
  and low balance → alerts only, then settlement to the floor with
  unpaid remainder; reservations (exclusive, converted, expired,
  cancelled); parking reject/flag; operator vs pricing permissions;
  ledger balanced.

Not verified / simulated:
- All ride flows use the **simulated** device adapter. Real supplier
  unlock/lock, stationary detection and parking accuracy are blocked
  (D-IOT). Pricing values are test/DEV FIXTURE data, not business prices
  (D-PRICE). Billing cutoff, end confirmation and parking rules remain
  open decisions (D-BILLCUT, D-ENDCONF, D-PARK) behind configuration.

Next: Phase 9 — rider mobile app and EAS configuration.

### 2026-10-04 — Phase 7: Wallet ledger and payments core
CI for Phase 6: run 37213641195 on `921d96c`, both jobs passed.

Changed:
- Ledger helpers: balanced journal posting (idempotent per reference),
  wallet row locks, balance/held/available figures, funds checks.
- `PaymentProvider` port (initialize / verify / parseWebhook) and a
  **simulated** `FakePaymentProvider` (dev/test only, R-62). **No Chapa
  adapter** — blocked (T-01, B1, B2).
- Payments: top-up creation (≥ 500 ETB, optional max, unguessable
  reference, expiry), `processPayment` verify-before-credit with
  exactly-once credit, review on mismatch, pending on provider outage,
  expiry and late success (R-57–R-59); worker reconciliation sweep.
- Rider API: wallet, transactions, top-up create (Idempotency-Key,
  rate limit), status, check. Webhook endpoint with raw-body signature
  check and event dedupe. Dev-only fake checkout page.
- Staff API (payments.read / wallet.adjust / refunds.*): payment list,
  detail with events, re-verify, bounded CSV export (formula-safe),
  rider wallet view, audited adjustments, maker-checker refunds (R-61).
- Migration 0004 adds the `payment_review` alert kind; global int8
  parsing (R-63).

Executed checks:
- `pnpm check` green: API tests 124 (24 new wallet tests), db 29,
  config 41, gateway 11, domain 33. Schema drift check clean.
- Wallet tests cover: minimum/validation, no provider → 503,
  idempotency replay and reuse, signed webhook credit once, replayed and
  re-sent events, webhook/redirect claims never credit, invalid
  signature 401 + recorded, tampered amount / currency / reference →
  review + alert, provider outage → pending then reconciled, expiry and
  late success, failure then success → review, 10 concurrent processors
  → one journal, rollback on DB failure, cross-rider 404, dev checkout,
  adjustments never below zero under concurrency, maker-checker refunds,
  original-payment refund completion, operator 403 matrix, CSV formula
  injection and range bound, ledger sums to zero.

Not verified / simulated:
- All payments are **simulated**; Chapa endpoints, signing and refunds
  are unverified (docs blocked). No real money moved.

Next: Phase 8 — pricing plans and ride engine.

### 2026-10-04 — Phase 6: Fleet, zones, devices and the simulator
CI for Phase 5: run 37212735971 on `f926445`, both jobs passed.

Changed:
- `@captain/domain` geometry: GeoJSON validation, point-in-polygon
  (holes, MultiPolygon), haversine, bounding boxes, coordinate checks.
- Fleet service: one availability rule (R-53), nearby search, QR/code
  lookup with plain-language reasons, zone status, alerts with dedupe,
  telemetry ingestion with validation (R-54), and the command lifecycle:
  queued → sent → acked/nacked/timed_out, with late and duplicate
  handling and a late-unlock incident.
- Rider routes: nearby, lookup, zones by bbox.
- Operator routes (fleet.read, fleet.status.update,
  device.command.service, maintenance.manage, alerts.manage): scooter
  list/filters/detail, status changes, service commands with motion
  safety (R-55), alerts, maintenance and repositioning tasks, zones.
- Admin routes (fleet.manage, zones.manage): scooter onboarding (random
  QR token), device registration (simulated refused in production),
  assign/unassign, retire, simulation scenarios (dev/test only), zone
  create/update with versioning. All audited.
- Internal API `/internal/v1/*` with service token (R-51).
- Worker process + sweeps behind an advisory lock (R-52); bundled as
  `dist/worker.js`.
- IoT gateway: `DeviceAdapter` interface (protocol-neutral),
  `SimulatedDeviceAdapter` (labelled; scenarios ack/nack/silence/delay,
  speed), internal API client, `Gateway` loop (command polling, result
  retry with 4xx drop, bounded telemetry buffer, device sync), health
  stats. No supplier protocol.
- Config: `INTERNAL_API_TOKEN` (required in staging/production, dev
  token refused in production), fleet thresholds, gateway poll/telemetry
  settings.
- Security fix found by tests: staff/rider authorization now runs at
  `onRequest`, before body validation (R-56).

Executed checks:
- API tests 100 (17 new fleet tests) on PostgreSQL 16.14:
  - discovery ordering/radius/stale/low/offline;
  - lookup by code/QR and reasons;
  - production hides simulated devices;
  - invalid telemetry stored but not applied;
  - out-of-order and low-battery alerts;
  - internal token enforcement;
  - command ack/duplicate;
  - timeout → late unlock ack → incident with no automatic command;
  - motion safety (moving, unknown speed, stationary, supplier device
    unsupported);
  - operator filters/status protection/audit;
  - maintenance and alerts;
  - retire/reassign;
  - simulation scenarios;
  - zones;
  - sweeps and the advisory lock;
  - the operator vs admin fleet permission matrix.
- Gateway tests 11: simulator scenarios and movement, gateway against a
  fake internal API (token, delivery, result retry/drop, telemetry
  buffer bounds).
- Domain tests 33 (geometry).
- **Three-process smoke** with the built bundles (API, worker, simulated
  gateway) on the local dev DB:
  - a queued command was acked by the simulator (`acked|SIM_OK`);
  - 37 telemetry rows in 10 s, labelled simulated, updated all 12
    fixture scooters;
  - zero error logs.
- A real ordering bug was found and fixed: the latest-telemetry
  tiebreaker for the stationary check.

Not tested / not done:
- **Real hardware:** BLOCKED on supplier protocol, device and SIM (B6,
  D-IOT). The gateway has no supplier adapter; production runs it with
  `DEVICE_ADAPTER=none`.
- **Mapbox rendering:** clients in Phases 9–10; tokens B5.
- **GPS accuracy:** not modelled. Parking validation and zone policy
  depend on D-ZONES/D-PARK.
- **Telemetry volume and nearby-search performance:** Phase 12.


### 2026-10-04 — Phase 5: Authorization, staff management, audit
CI for Phase 4: run 37212061513 on `cea9bf4`, both jobs passed.

Changed:
- **Fail-closed guard** (`apps/api/src/auth/guard.ts`): every staff route
  needs authenticated active staff plus the route's declared permission.
  A route with no declaration is denied. With `STAFF_MFA_REQUIRED`, only
  TOTP-verified sessions pass (except enrollment routes).
- **Permission catalogue** in `@captain/contracts`, kept in sync with the
  database by a test.
- **Staff TOTP** (migration `0003_staff_mfa`): RFC 6238 implementation,
  AES-256-GCM-encrypted secret, replay protection. Enrollment
  (setup/confirm), MFA at sign-in (`totpCode`), admin reset.
  `STAFF_MFA_REQUIRED` is mandatory in staging/production.
- **Staff management API:** list, create, status change, role
  replacement, MFA reset. All audited with reasons; no self-changes;
  last-admin protection; deactivation revokes sessions.
- **Rider administration API:** search (phone in any format, email, id,
  name), detail with wallet figures (audited view), suspend/unsuspend
  (sessions revoked), and complete deletion. Completion is blocked by an
  open ride, an active reservation, a non-zero balance, active holds, an
  open incident or an open refund. It removes personal data and keeps
  financial records.
- **Audit API:** filters and keyset pagination.

Executed checks:
- API tests 83 on PostgreSQL 16.14 (39 new):
  - **Matrix:** 11 staff routes × anonymous/rider/operator/admin.
  - **Fail-closed:** an injected undeclared `/v1/admin` or `/v1/operator`
    route is denied.
  - **Tampering:** an operator cannot self-promote, and forged
    headers/query params have no effect; staff cookie writes need CSRF.
  - **TOTP:** RFC 4226/6238 test vectors; enrollment gate; required,
    wrong and replayed codes; encrypted storage; reset.
  - **Staff management:** audit row with actor, reason and request ID;
    duplicates; self-change and last-admin protection; session revocation.
  - **Rider administration:** search formats, audited detail view,
    suspension lifecycle, deletion blocked by balance then completed after
    a compensating entry, ledger retained, contact freed for a new
    account.
  - **Audit:** filters and pagination.
- Config tests 37.

Not tested / not done:
- **Staff UI:** Phase 11.
- **Operator routes:** none exist yet (Phase 6 adds fleet routes under
  `/v1/operator`); the matrix must be extended with each new route.
- **WebAuthn:** not implemented (TOTP chosen; possible upgrade).
- **CLI-created first admin and TOTP:** a CLI-created admin must enroll
  TOTP on first sign-in when `STAFF_MFA_REQUIRED=true`. The flow is
  tested via the API; the real authenticator-app experience is not
  verified.


### 2026-10-04 — Phase 4: Authentication and request security
CI for Phase 3: run 37211222429 on `70ec1c1`, both jobs passed (incl. the
schema-drift check and runtime-role permission tests on CI PostgreSQL).

Changed:
- **Config:** `AUTH_SECRET` (required ≥32 chars in staging/production;
  labelled dev default refused in production), `AUTH_RIDER_CHANNELS`, OTP
  and session lifetimes, `CORS_ORIGINS` (required in staging/production),
  `COOKIE_SECURE` and `SMTP_REQUIRE_TLS` (must be true in
  staging/production), SMTP settings, `TRUST_PROXY`, `BODY_LIMIT_BYTES`.
  Every enabled rider channel must have a real provider in
  staging/production.
- **OTP:** request/verify for riders (SMS or email) and staff (email,
  web only). HMAC-hashed codes, attempts, expiry, single use, resend
  cooldown, PostgreSQL rate limits. Unknown staff emails get an identical
  response with nothing stored or sent. A failed delivery deletes the
  challenge.
- **Sessions:** opaque hashed tokens, rotating refresh tokens with reuse
  detection, absolute caps, logout, list/revoke own sessions, revoke all.
- **Browser:** HttpOnly SameSite=Strict cookies (`__Host-` when secure),
  session-bound CSRF token, Origin checks, explicit CORS, Helmet
  (CSP `default-src 'none'`, HSTS when secure).
- **Rider account:** profile, terms/age attestation, contact change with
  re-verification (409 if the contact belongs to another rider),
  deletion request (sessions revoked, audited); suspended accounts
  blocked.
- **Senders:** SMTP email adapter (nodemailer); log-only senders with a
  dev outbox registered only in development/test; GeezSMS **not
  implemented** (blocked on docs).
- **Staff:** provisioning CLI (`create/grant/disable`, reason required,
  audited, disable revokes sessions); staff login audited.

Executed checks:
- API tests 44 on PostgreSQL 16.14, including:
  - sign-up and sign-in, hash-only storage and no OTP in logs, invalid
    numbers;
  - attempt lockout, expiry, single use, cooldown with Retry-After, the
    per-destination limit, unavailable or unoffered channels, delivery
    failure cleanup;
  - refresh rotation and reuse revocation, access expiry, absolute
    session cap, logout, cross-rider session isolation, malformed tokens;
  - cookie attributes, `__Host-` names, CSRF/Origin enforcement, login
    CSRF, CORS allow and deny, security headers;
  - suspension, contact change and conflicts, deletion request;
  - staff CLI rules, staff web-only login and unknown-email behaviour,
    staff vs rider route separation, disable revoking sessions;
  - **SMTP adapter against a real local SMTP server** (auth, delivery,
    wrong password returns 503 without leaking it);
  - dev outbox absent in staging.
- Config tests 36.

Not tested / not done:
- **Real OTP delivery:** no message has reached a real phone or inbox.
  Launch checklist L1/L2 stay pending (B3, B4).
- **GeezSMS adapter:** blocked on official documentation (B1) and an
  account (B3).
- **Staff second factor:** planned before launch (R-44).
- **Deletion completion by staff:** Phase 5.
- **Rate limits on payment/ride endpoints:** Phases 7–8.
- **Cleanup of old `rate_limit_buckets` and expired tokens:** the worker
  in Phase 6.
- **Native secure storage (mobile):** Phase 9.


### 2026-10-04 — Master work order received; Phase 3: Data model and migrations
Reconciliation:
- Verified state: PR #1 (`6c33449`) and PR #2 (`56591a7`) are open
  drafts; `main` = initial commit only. Phase 2 CI run 37210235095 on
  `56591a7` passed both jobs (`expo-doctor` 21/21).
- Plan revision 2 replaces Phases 3–17 (implementation-plan.md).
  CLAUDE.md now allows sequential phases within one task and defines the
  implemented/simulated/blocked/verified vocabulary.
- New docs: `traceability.md`, `user-actions.md`, `launch-checklist.md`.
- Docs re-checked: Chapa, GeezSMS, Mapbox and Expo documentation domains
  are still blocked by the egress proxy. The `chapa-nodejs` SDK under the
  Chapa-Et GitHub organization is published by an individual npm
  maintainer, so it is not used as an authoritative source for webhook
  signing. User action B1 asks for the domains to be allowed.

Changed (Phase 3):
- 36-table schema split by area (`packages/db/src/schema/`), migration
  `0001_core_schema`.
- Custom migration `0002_db_rules`:
  - balanced-journal deferred constraint triggers;
  - append-only triggers (ledger, journals, audit, ride events, command
    acks; TRUNCATE blocked);
  - payment-event raw-field immutability;
  - pricing-plan immutability and transition rules;
  - ride identity/snapshot immutability and terminal-state protection;
  - device simulated-flag immutability;
  - seeded roles/permissions and system ledger accounts;
  - `captain_app` runtime role and grants.
- `packages/domain`: integer santim parsing, formatting and arithmetic;
  Ethiopia-local time.
- Development fixtures (`db:fixtures`), run by `cloud-setup.sh` on the
  local dev DB.

Executed checks:
- db tests 29 (24 rule tests + 3 fixture + 2 migration/helper suites) on
  PostgreSQL 16.14; domain tests 22; all other packages unchanged and
  passing (see CI).
- `cloud-setup.sh` applied migrations 0001–0002 and loaded fixtures on
  the existing local cluster.

Not tested / limitations:
- Runtime login wiring for the API (`captain_app` member user) is
  documented but the API still connects with the URL it is given;
  deployment docs in Phase 13.
- Schema-drift check added to CI (fails if `drizzle-kit generate` would
  create a migration); verified locally ("No schema changes").
- Balance computation performance (sum over lines) not load tested
  (Phase 12).


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
