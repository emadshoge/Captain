# Captain — Status report (master work order)

Date: 2026-10-04. Readiness: **demo** (see §5). Vocabulary as in
`CLAUDE.md`: *implemented* (code + passing automated tests), *simulated*
(fake provider/device only), *blocked* (external input needed),
*verified* (real-world evidence). **Nothing in this report is
"verified" in that sense yet.**

## 1. Implemented

| Area | What exists | Main evidence |
|---|---|---|
| Platform | pnpm monorepo, Node 22, TypeScript, strict config validation with a production guard, structured redacted logging, request ids, error envelope | `packages/config`, `packages/logging`; CI `checks` |
| Data | PostgreSQL 16 schema + 5 migrations, database-enforced rules (balanced journals, append-only ledger/audit/events, immutable prices and ride facts, least-privilege app role), schema-drift check | `packages/db`; db tests |
| Identity | Rider SMS/email OTP, rotating sessions (mobile tokens, web HttpOnly cookies + CSRF), staff email OTP + TOTP, rate limits | auth tests |
| Authorization | Fail-closed permission guard, roles in the database, audit trail | authz matrix, staff E2E |
| Fleet | Scooters, devices, zones, validated telemetry, alerts, command lifecycle with timeouts, late-ack incidents, motion safety, internal gateway API, worker | fleet tests |
| IoT gateway | Protocol-neutral adapter interface, labelled simulator, gateway loop | gateway tests, E2E, drills |
| Wallet/payments | Double-entry ledger, verify-before-credit top-ups, review on mismatch, reconciliation, idempotency, maker-checker refunds, audited adjustments, formula-safe CSV | wallet tests, staff E2E |
| Rides | Versioned pricing, ride engine (unlock gating, pause, end request, stationary check, configurable billing/parking/confirmation), exactly-once settlement, operator review, reservations, recovery sweeps | ride tests, E2E, load test |
| Rider mobile | Expo SDK 57 app: sign-in, nearby list, QR/manual scan, live ride, wallet, history, receipts; EAS profiles | jest (24), bundle export, expo-doctor |
| Rider web | Next.js app with the same flows (code entry) | Playwright E2E |
| Staff web | Operator and admin consoles incl. incidents, refunds, pricing, zones, staff, audit, TOTP enrolment | Playwright E2E |
| Operations | Load test, failure drills, backup/restore drill, container images, release migration command, deployment guide, runbooks, store checklist | CI `resilience`, `images` |

## 2. CI evidence per phase (all green on the latest commit of each PR)

| PR | Phase | Head | CI run |
|---|---|---|---|
| #1 | 0–1 foundation | `6c33449` | 37209327708 |
| #2 | 2 config/logging | `56591a7` | 37210235095 |
| #3 | 3 data model | `70ec1c1` | 37211222429 |
| #4 | 4 authentication | `cea9bf4` | 37212061513 |
| #5 | 5 authorization | `f926445` | 37212735971 |
| #6 | 6 fleet + simulator | `921d96c` | 37213641195 |
| #7 | 7 wallet/payments | `26afeb6` | 37214437782 |
| #8 | 8 pricing/rides | `d7feaab` | 37229454474 |
| #9 | 9 rider mobile | `2ed351b` | 37230185581 |
| #10 | 10 rider web + E2E | `0162989` | 37231219012 |
| #11 | 11 staff web | `c6802c7` | 37232482695 |
| #12 | 12 performance/resilience | `2267f18` | 37233209638 |
| #13 | 13 deployment preparation | `99e5586` | 37233807405 |

PRs are stacked (each based on the previous one) and **none is merged**;
merge in order #1 → #13 (→ this report's PR).

Test counts at the last full local run: API 149, db 33, config 41,
contracts 7, domain 41, logging 51, gateway 12, mobile 24, rider E2E 3, staff E2E 3,
drills 4/4, backup drill PASS, load test PASS.

## 3. Deployed environments

**None.** No staging or production environment exists; container images
are built and smoke-tested in CI but not pushed. Blocked on B7 (hosting
account + authorization) and B8 (DNS).

## 4. Simulated and blocked integrations

| Integration | State | Blocker |
|---|---|---|
| Chapa payments | **blocked**; a fake provider (SIMULATED) exercises the full verify-before-credit flow | T-01 docs unreachable, B1, B2 |
| GeezSMS OTP | **blocked**; log-only sender in development | T-02, B1, B3 |
| Email OTP | implemented (SMTP sender), **not verified** — no real message sent | B4 |
| Mapbox maps | **blocked**; list of nearby scooters instead | B1, B5 |
| Supplier IoT protocol | **blocked**; simulator only, real devices refused for lock/unlock | D-IOT, B6 |
| Native app builds | **blocked**; JS bundle export only (not a native build) | B9 (+ B10 for stores) |
| Hosting, DNS, staging | **blocked** | B7, B8 |

## 5. Readiness

**Demo.** The complete product works end to end in CI and in the
development environment against simulated devices, a fake payment
provider and log-only OTP, including failure handling and money
invariants. It is **not** staging-ready (nothing deployed, no real
provider in test mode), and far from pilot/production (no real scooters,
payments, SMS, phones). Launch checklist: `docs/launch-checklist.md`.

## 6. Defects found by the later phases and fixed

- Gateway dropped commands when it started before the API (R-81, E2E).
- Ending a ride hung when the browser location prompt was ignored (web).
- No `pg` pool error listener: a dropped DB connection crashed API/worker
  (R-87, drill) — also the cause of intermittent test noise.
- Audit page crashed on the paginated response (staff E2E).

## 7. Outstanding owner actions (grouped)

1. **Decisions** (`docs/user-actions.md` §A): login channels, prices and
   billing rules, minimum balance/holds, pause/reservations, low balance
   and unpaid debt, billing cutoff/parking/end confirmation, refunds,
   eligibility, zones, branding, languages, legal texts.
2. **Access for documentation** (B1): allow developer.chapa.co,
   GeezSMS docs, docs.mapbox.com, docs.expo.dev (or provide the docs).
3. **Accounts/credentials** in protected configuration (never in chat):
   Chapa test keys (B2), GeezSMS (B3), email provider (B4), Mapbox (B5),
   Expo/EAS (B9, B12), store accounts (B10).
4. **Hardware** (B6): supplier protocol documentation, one test scooter
   or device and a data SIM.
5. **Hosting and DNS** (B7, B8) with explicit staging authorization.
6. **Review and merge** the stacked PRs #1 → #13 (nothing is merged
   automatically).

## 8. Next steps (in order once unblocked)

1. Phase 14 per provider as each B-item arrives: email OTP (B4) → real
   message received; GeezSMS (B1, B3); Chapa test mode (B1, B2) with
   duplicate-webhook replay (L3).
2. Staging deploy (B7, B8): images, release migrations, backups, restore
   drill on staging data (L13), rollback rehearsal (L14).
3. Phase 15 with supplier docs (B6): adapter, framing/checksums/heartbeats,
   stationary semantics, recorded-fixture tests, then the test device
   (L5–L8).
4. EAS builds (B9) and installs on Android and iPhone (L10, L11).
5. Controlled pilot (L17) and production launch only on explicit
   instruction (L18).
