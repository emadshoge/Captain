# Captain — Decisions

Record every decision here. Unresolved items must not be decided in code;
make them configurable and reference the ID.

## Resolved

| ID | Decision | Date | Rationale |
|---|---|---|---|
| R-01 | Captain is a dockless scooter-sharing rental platform in Ethiopia (not ride-hailing). | 2026-10-04 | Owner correction. |
| R-02 | TypeScript throughout, pnpm monorepo. Turborepo **not** adopted in Phase 1; `pnpm -r` runs tasks in topological order. | 2026-10-04 (revised) | Six workspaces don't need a task cache yet. Revisit if CI time grows. |
| R-03 | Mobile: Expo SDK 57 + Expo Router; web: Next.js 16 (App Router). Admin and operator share one Next.js app (`staff-web`) with `/admin` and `/operator` route areas. | 2026-10-04 (revised) | Owner architecture; shared staff auth and fleet views; the API will enforce roles (planned, Phase 5; not implemented in Phase 1). |
| R-04 | Backend: **Fastify 5** + `fastify-type-provider-zod`. | 2026-10-04 | Direct reuse of shared Zod contracts, low overhead, plugin boundaries; see architecture §4. |
| R-05 | PostgreSQL 16 for all persistent data; Drizzle ORM + drizzle-kit SQL migrations, `pg` driver. | 2026-10-04 | PG 16 server available in cloud image; SQL-first ORM with strong TS types. |
| R-06 | **No Redis** initially; pg-boss on PostgreSQL for jobs/timeouts. | 2026-10-04 | No concrete requirement; revisit per architecture §10. |
| R-07 | Shared Zod schemas in `packages/contracts` are the API source of truth. | 2026-10-04 | Owner requirement. |
| R-08 | Currency ETB; money stored as `bigint` santim. | 2026-10-04 | Avoid float errors. |
| R-09 | Payments via Chapa; minimum top-up 500 ETB; no business maximum (provider limits apply). | 2026-10-04 | Owner requirement. |
| R-10 | Ride start blocked when available balance is insufficient. | 2026-10-04 | Owner requirement (threshold open: D-MINBAL). |
| R-11 | Maps: Mapbox (`@rnmapbox/maps`, `mapbox-gl`). | 2026-10-04 | Owner requirement. Requires EAS dev builds (no Expo Go). |
| R-12 | OTP via provider interfaces: email sender + GeezSMS. | 2026-10-04 | Owner requirement. |
| R-13 | Separate rider vs staff accounts; staff roles `operator`, `admin`. | 2026-10-04 | Owner requirement. |
| R-14 | IoT via `DeviceGateway` interface; simulator only until supplier docs; never invent protocol. | 2026-10-04 | Owner requirement. |
| R-15 | Fake payments/OTP/unlock rejected at startup in production; no override flag. | 2026-10-04 | Owner requirement. |
| R-16 | Double-entry append-only wallet ledger. | 2026-10-04 | Auditability, idempotent credits. |
| R-17 | TypeScript `~6.0.3`, not 7.x. | 2026-10-04 | Expo SDK 57 template uses `~6.0.3`; `typescript-eslint` peer range `<6.1.0`. |
| R-18 | React versions per app. `rider-mobile` uses React 19.2.3 (Expo SDK 57 pin); the Next.js apps use React 19.3.0. Shared packages do not depend on React. | 2026-10-04 (revised) | Expo monorepo guide forbids duplicate React *within one app* and duplicate React Native in a monorepo, not different React versions across apps. |
| R-19 | Tests use real PostgreSQL 16: local cluster in cloud sessions, `postgres:16` service in GitHub Actions. No SQLite/PGlite substitution. | 2026-10-04 | Owner constraint; Docker unavailable in sessions. |
| R-20 | Mobile binaries built with EAS cloud builds; Android first. | 2026-10-04 | Owner requirement; no local machine. |
| R-21 | *(Withdrawn 2026-10-04)* The billing cutoff is not decided; see D-BILLCUT. | — | Owner correction: "End ride" is a completion request. |
| R-22 | Late unlock acknowledgments create an operator-review incident. No automatic lock or other physical command is sent. | 2026-10-04 | Owner correction; motion safety. |
| R-23 | No command that could lock wheels or disable propulsion is ever sent while a scooter may be moving. Such commands require a stationary-state check defined from supplier docs. Until then they exist only in the simulator. | 2026-10-04 | Owner requirement; rider safety. |
| R-24 | No automatic retries of physical device commands unless supplier docs state they are idempotent and safe. | 2026-10-04 | Motion safety; unknown protocol. |

| R-25 | pnpm `autoInstallPeers: false`; Expo-required peers declared explicitly at SDK 57 versions. | 2026-10-04 | Auto-installed peers broke SDK 57 version alignment (architecture §3). |
| R-26 | API and IoT gateway ship as self-contained esbuild bundles. | 2026-10-04 | pnpm isolated layout; verified by running the bundle outside the repo. |
| R-27 | Local dev/test PostgreSQL cluster lives in `/var/tmp/captain-pg16` (outside the repo), port 54329, trust auth on 127.0.0.1 only. | 2026-10-04 | Throwaway container; no secrets needed; cannot collide with a system server. |
| R-28 | Each DB test file gets a fresh database via `createTestDatabase()`, which refuses staging/production and non-local hosts. | 2026-10-04 | Real PostgreSQL isolation without Docker. |
| R-29 | `APP_ENV` has no default and must be set explicitly. | 2026-10-04 | A missing value must never become `development` (which allows fakes) on a production host. |

| R-30 | Logging: pino 10 via `@captain/logging` for API and gateway; layered redaction (keys, strings, URLs, header paths); bodies and headers never logged. | 2026-10-04 | Fastify-native, structured JSON; redaction is tested. |
| R-31 | Request IDs: accept a safe `x-request-id`, otherwise generate a UUID; echo it in the header, error bodies and logs. | 2026-10-04 | Support traceability; blocks log injection. |
| R-32 | Error envelope carries a required `requestId`; unexpected errors return a generic 500 with no internal detail. | 2026-10-04 | Avoid leaking internals; let riders quote an ID to support. |
| R-33 | `LOG_LEVEL=debug/trace` refused in production. | 2026-10-04 | Verbose logs increase exposure risk. |
| R-34 | Phase 2 branched from PR #1's head and its PR targets the PR #1 branch (stacked), because PR #1 is not merged yet. | 2026-10-04 | Owner had no preference; keeps the Phase 2 diff reviewable and merges nothing. |

| R-35 | Phase 3 schema: business rules that protect money, safety and audit are enforced in PostgreSQL (constraints, deferred balance trigger, append-only triggers, immutability triggers, grants). | 2026-10-04 | Defence in depth; application bugs cannot corrupt the ledger. |
| R-36 | Runtime role `captain_app` (NOLOGIN group); runtime logins are members; migration owner separate. | 2026-10-04 | Least privilege (master order E). |
| R-37 | Development fixtures are labelled `DEV FIXTURE`, simulated, and refused outside development/test. | 2026-10-04 | Exercise flows without setting production policy. |
| R-38 | Zones stored as GeoJSON + bounding box with server-side point-in-polygon in the API; PostGIS deferred. | 2026-10-04 | Avoids an extension many hosts gate; revisit for large zone sets. |
| R-39 | Plan revision 2: master work order phases 3–16; stacked branch + PR per phase; merge in phase order. | 2026-10-04 | Owner master order. |

| R-40 | API runtime queries use parameterized SQL through `pg` (with explicit transactions/row locks); Drizzle remains the schema/migration source of truth. | 2026-10-04 | Locking and constraint-driven logic is clearer in SQL; every query is parameterized. |
| R-41 | Sessions: opaque random tokens (`cat_`/`crt_`, 256-bit), stored as SHA-256 hashes; 15-min access, rotating single-use refresh with reuse detection (revokes the session); absolute caps (riders 90 days, staff 12 hours). No JWTs. | 2026-10-04 | Instant revocation, no signing-key management. |
| R-42 | Mobile receives tokens in the body (stored in secure storage, Phase 9); web receives `HttpOnly`, `SameSite=Strict`, `Secure` (`__Host-`) cookies plus a session-bound HMAC CSRF token sent as `x-csrf-token`; Origin checked for cookie writes and web sign-in. | 2026-10-04 | Standard browser session hardening across subdomains of captain.et. |
| R-43 | OTP: 6 digits from the crypto RNG, HMAC-SHA256 with `AUTH_SECRET` stored instead of the code, 5-minute TTL, 5 attempts, 60 s resend cooldown, PostgreSQL rate limits per IP and per destination; challenge deleted when delivery fails. | 2026-10-04 | Abuse controls without Redis. |
| R-44 | Staff sign in only by email OTP on the web; provisioned only via the audited `staff` CLI (no public sign-up). Stronger staff authentication (TOTP/WebAuthn) is a planned follow-up before launch. | 2026-10-04 | Master order F; second factor tracked in launch checklist. |
| R-45 | Email OTP via standard SMTP (nodemailer), provider-neutral; SMS OTP via GeezSMS **blocked** (no adapter until official docs are reviewed). | 2026-10-04 | Never invent provider APIs. |
| R-46 | Ethiopian mobile numbers only for SMS OTP (`+2519…`, `+2517…`). | 2026-10-04 | Launch market; foreign numbers can use email. |

| R-47 | Authorization is enforced by one fail-closed `preHandler` for every `/v1/admin`, `/v1/operator` and `/v1/staff` route. Each route declares `config.permission`; a missing declaration denies access. Permissions are loaded from the database per request. | 2026-10-04 | A forgotten check cannot open a route; role changes apply immediately. |
| R-48 | Staff second factor: TOTP (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step), secret encrypted with AES-256-GCM (HKDF from `AUTH_SECRET`), replay blocked by last-used step. With `STAFF_MFA_REQUIRED` (mandatory in staging/production) staff APIs require a session that verified TOTP; unenrolled staff can only reach enrollment. Admins reset lost authenticators (audited, sessions revoked). | 2026-10-04 | Supersedes the "planned" part of R-44; WebAuthn remains a possible upgrade. |
| R-49 | Staff lockout protections: no self status/role/MFA changes; at least one active admin must always remain. | 2026-10-04 | Prevents accidental or malicious loss of administration. |
| R-50 | Viewing a rider's personal data (`GET /v1/admin/riders/:id`) is audited. | 2026-10-04 | Privacy accountability. |

| R-51 | Gateway↔API: the API owns command state in PostgreSQL; the gateway pulls queued commands (`FOR UPDATE SKIP LOCKED`), pushes results and batched telemetry to `/internal/v1/*` with a shared service token (constant-time compare, required in staging/production, private network only). | 2026-10-04 | Simple, restart-safe, no message broker; idempotent results. |
| R-52 | Background work runs in a separate `worker` process: periodic sweeps (command timeouts, offline devices, stale telemetry, purges) behind a session advisory lock (one active sweeper). pg-boss not adopted. | 2026-10-04 | Few periodic jobs; avoids an extra schema/dependency. |
| R-53 | Rentable = status available + assigned online device + fresh location (≤ `FLEET_TELEMETRY_STALE_SECONDS`) + battery ≥ `FLEET_MIN_RIDEABLE_BATTERY`; simulated devices are never rentable in production. One rule shared by map, QR lookup and ride start. | 2026-10-04 | Consistent availability; honest about stale data. |
| R-54 | Telemetry validation: coordinate ranges, null island, lat/lng pairing, battery/speed ranges, clock skew (≤ 60 s ahead, ≤ 24 h old). Invalid reports are stored (for diagnosis) but never move a scooter; out-of-order reports never move it backwards. | 2026-10-04 | Untrusted device data. |
| R-55 | Staff service lock/unlock require a confirmed stationary state (fresh telemetry with speed 0) and are refused for real supplier devices until a documented stationary check exists; service unlock also requires maintenance/charging status. Late unlock acks open an incident; nothing is sent automatically. | 2026-10-04 | Implements R-22/R-23. |
| R-56 | Authorization hooks run at `onRequest` (before body parsing/validation). | 2026-10-04 | Unauthorized callers cannot probe schemas (found by tests). |
| R-57 | Top-ups are credited only by server-side verification with the provider (verify-before-credit). Webhooks and rider "check" calls only trigger verification; redirects and client claims never credit. Provider calls happen outside database transactions; the outcome is applied under a row lock, and the ledger's unique `(reference_type, reference_id)` makes a second credit impossible. | 2026-10-04 | Master order G. |
| R-58 | Any verified success whose reference, amount, currency or provider reference differs from what Captain created — or a success after a recorded failure — moves the payment to `review` with a critical alert; it is never credited automatically. | 2026-10-04 | Never accept an arbitrary provider reference. |
| R-59 | Provider unreachable → payment stays pending (event `verify_unavailable`); the worker reconciles open/expired payments (≤ 7 days old). A late success on an expired payment is credited (`late_success`), because the rider's money has moved. | 2026-10-04 | Webhook loss tolerance. |
| R-60 | Money-moving POSTs (top-up creation, staff adjustments) require an `Idempotency-Key`; replays return the stored response, reuse with a different body is refused (422). | 2026-10-04 | Safe client retries. |
| R-61 | Staff adjustments require a reason, are audited and can never take a wallet below zero (row lock + funds check). Refunds are maker-checker (`REFUNDS_REQUIRE_SECOND_APPROVER`, default on): wallet refunds credit on approval; refunds to the original payment are debited only when finance records the provider reference (no automated provider refund until Chapa refund capability is verified). | 2026-10-04 | Partial resolution of D-REFUND mechanics; business rules still open. |
| R-62 | A `fake` payment provider exists for development/test only (labelled SIMULATED in journal descriptions, refused by the production config guard); worker reconciliation skips it because its state is per-process. | 2026-10-04 | Never fake payments in production. |
| R-63 | PostgreSQL `int8` values are parsed to JS numbers globally and throw beyond `Number.MAX_SAFE_INTEGER`. | 2026-10-04 | Santim amounts compared reliably. |
| R-64 | Ride engine state flow: start → `unlock_pending` (unlock command queued) → `active` only on the device unlock ack; nack → `start_failed` (scooter available), timeout → `start_failed` with the scooter set to `maintenance` and an `unlock_failed` incident (state unknown). Nothing is charged before the unlock ack. Late acks never change a ride; they are noted and the fleet layer opens an incident. | 2026-10-04 | Failed unlock never charges; no automatic physical recovery (R-22). |
| R-65 | Start concurrency: scooter row lock first, then wallet lock; partial unique indexes (one open ride per rider/scooter) are the final arbiter and map to 409. Start requires an `Idempotency-Key`. | 2026-10-04 | Double start / two riders one scooter. |
| R-66 | Ride policies that are open business decisions are configuration: `RIDE_BILLING_CUTOFF` (end_request \| completion_confirmed), `RIDE_END_CONFIRMATION` (none \| device_lock), `RIDE_PARKING_POLICY` (off \| flag \| reject). Required in staging/production; development/test fall back to labelled DEV FIXTURE values. | 2026-10-04 | D-BILLCUT, D-ENDCONF, D-PARK stay open. |
| R-67 | With `device_lock`, a lock command is only queued after a confirmed stationary state (fresh valid telemetry with speed 0); otherwise the end request is refused (409, ride continues). Supplier devices (no documented stationary check) go to operator review with no command. Lock nack/timeout → operator review + incident. | 2026-10-04 | R-23. |
| R-68 | Pause changes billing only — no device command. Pause time beyond `max_pause_minutes` is billed at the riding rate; plans without a pause price do not offer pause. | 2026-10-04 | D-PAUSE still open (whether the scooter should be locked while paused needs supplier docs). |
| R-69 | Fares: unlock fee + time rounded up to the billing increment then up to whole santim (integer math, `@captain/domain` `computeFare`). Charged once per ride (ledger reference ('ride', id)); never below the plan's `low_balance_floor_santim`; the remainder is recorded as unpaid with an alert (D-UNPAID open). | 2026-10-04 | Exactly-once settlement. |
| R-70 | Low balance and maximum duration during a ride produce alerts only — never hardware actions. | 2026-10-04 | D-LOWBAL / D-MAXRIDE; R-23. |
| R-71 | Operators (rides.review) can send open rides to review and resolve them as `complete` (chosen billing cutoff between start and now) or `complete_no_charge`; both audited. Recovery sweep moves rides stuck in `end_requested` to review and re-applies already-resolved commands. | 2026-10-04 | Disconnect/restart recovery. |
| R-72 | Reservations exist only when the active plan defines `reservation_minutes`; the fee (if any) is charged at reservation; expiry/cancel frees the scooter (no fee refund — D-RESERVE open). Pricing plans: admins create drafts and activate them (previous plan retired atomically); development fixture pricing is refused for rides in production. | 2026-10-04 | Versioned pricing. |
| R-73 | Rider mobile: tokens only in SecureStore (keychain/keystore, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`); one shared refresh for concurrent 401s; local sign-out when refresh fails. API shapes come from `@captain/contracts` as type-only imports. | 2026-10-04 | Phase 9. |
| R-74 | Mobile money/ride actions send an `Idempotency-Key` per user action (reused on retry). After checkout the app only calls the server's verify endpoint and shows the server's answer; the return from the browser never changes the balance. | 2026-10-04 | R-57. |
| R-75 | Until Mapbox is available (token + docs, B1/B5) the home screen lists nearby scooters instead of a map; `@rnmapbox/maps` is not added yet. | 2026-10-04 | No map SDK integration without docs/token. |
| R-76 | Mobile tests: jest-expo 57 + React Native Testing Library 13 (jest 29, as required by jest-expo). | 2026-10-04 | Component tests without emulators. |
| R-77 | EAS profiles: `development` (dev client, internal), `preview` (internal APK, staging), `production` (store, remote auto-increment). `EXPO_PUBLIC_API_URL` per profile is set in EAS environment variables once staging/production hosts exist (D-HOST). Microphone and background location are blocked permissions. | 2026-10-04 | Phase 9 EAS config; builds not run (B9). |
| R-78 | Rider web: client components call the API directly with `credentials: 'include'`; tokens stay in HttpOnly SameSite=Strict cookies; the CSRF token is fetched from `/v1/auth/session` and held in memory only; one shared refresh on 401. Web and API must be same-site (e.g. captain.et / api.captain.et; D-DNS). | 2026-10-04 | Phase 10. |
| R-79 | The web return page after checkout only asks the server to verify the remembered payment id (sessionStorage) and displays the server's answer. The dev-only fake checkout page offers Pay/Fail links that send the signed fake webhook and redirect to `RIDER_RETURN_URL`. | 2026-10-04 | R-57; never credit from a redirect. |
| R-80 | E2E harness (`apps/rider-web/e2e/run.ts`): throwaway database (migrated + labelled dev fixtures), built API, worker, SIMULATED gateway and rider web, then Playwright (Chromium). Runs as its own CI job. | 2026-10-04 | No Docker needed. |
| R-81 | The IoT gateway never fetches commands before it has loaded the device list (fetching marks them sent; an empty adapter would drop them). Found by the E2E run when the API started after the gateway. | 2026-10-04 | Robustness fix. |
| R-82 | Test databases are dropped without FORCE first (short retries), forcing only as a last resort, to avoid terminating sockets that `pool.end()` is still closing. | 2026-10-04 | Removes an intermittent unhandled 57P01 in tests. |
| R-83 | Staff web uses the same cookie/CSRF client pattern as rider web; navigation and page guards follow the session's permissions, but the API remains the only enforcement point (forbidden pages show "No access"; direct API calls get 403). | 2026-10-04 | Phase 11. |
| R-84 | Financial and destructive staff actions (wallet adjustments, refund approval/completion, ride resolution, suspensions, staff status and authenticator resets, service lock/unlock) need an explicit confirmation tick in the UI plus a reason that the API audits. | 2026-10-04 | Master order L. |
| R-85 | Incidents API (`/v1/operator/incidents`: list, report, take, resolve with resolution + note; audited). Handling an incident never sends a device command; money is settled only through ride review. | 2026-10-04 | Missing piece found while building the staff UI. |
| R-86 | One E2E harness (`apps/rider-web/e2e/harness.ts`) serves both web apps; staff accounts are created through the staff CLI against the throwaway database. | 2026-10-04 | No duplicated orchestration. |

## Unresolved (owner decisions required)

| ID | Question | Needed by phase | Notes / current handling |
|---|---|---|---|
| D-LOGIN | Primary login method: phone + SMS OTP (GeezSMS), email + email OTP, or both? | Phase 4 (auth) | Data model supports both identity types. |
| D-PRICE | Unlock fee and per-minute price (ETB). | Phase 9 (rides) | Stored in `pricing_plans`; no production defaults. |
| D-MINBAL | Minimum available balance to start a ride; whether a hold is placed. | Phase 9 | Configurable; ride start blocked below it. |
| D-PAUSE | Pause/hold during ride and reservation before ride: allowed? price? max duration? | Phase 9 | `paused` state designed; disabled until decided. |
| D-LOWBAL | Behaviour when balance runs low/out during a ride (notify, allow negative balance, end-on-park?). | Phase 10 | Never auto-lock or cut propulsion on a moving scooter (R-23). |
| D-BILLCUT | Billing cutoff: rider's end request, parking acceptance, device confirmation, or another rule? How is time in `completion_pending` / `operator_review` billed? | Phase 10 | `billing_cutoff_at` stored separately; computed by a configurable policy. |
| D-PARK | Parking validation: what is checked (zone, photo, GPS accuracy), what happens when parking is outside allowed areas (reject end, fee, allow with flag). | Phase 10 | Feature-flagged; depends on D-ZONES. |
| D-ENDCONF | Device completion confirmation: what signal counts (lock state, ignition off, other), timeout values, and whether a rider may start another ride while a previous one is in operator review. | Phase 10 + supplier docs | Depends on D-IOT. |
| D-ZONES | Service area, parking/no-parking zones, out-of-zone fees, parking photo requirement. Adopt PostGIS? | Phase 9/10 | Zone checks feature-flagged off until decided. |
| D-ROUND | Billing rounding (per started minute vs per second) and pause charge. | Phase 8 | `billing_increment_seconds`, `pause_per_minute_santim` per plan. |
| D-RESERVE | Reservations: allowed? window? fee? | Phase 8 | `reservation_minutes`/`reservation_fee_santim` per plan (null = off). |
| D-MAXRIDE | Maximum ride duration and action at the limit. | Phase 8 | `max_ride_minutes`; alert/notify only, never hardware action. |
| D-TOPMAX | Maximum single top-up / wallet balance limits (regulatory?). | Phase 7 | `TOPUP_MAX_SANTIM` optional, unset = no limit. |
| D-UNPAID | Negative balances / unpaid debt handling and collection. | Phase 8 | `low_balance_floor_santim`; start blocked while balance below minimum. |
| D-LEGAL | Approved terms, privacy, support wording and translations. | Phase 9–11, launch | Placeholders marked DRAFT – NOT APPROVED. |
| D-DNS | Confirm captain.et ownership and DNS access. | Phase 13 | Instructions prepared; not applied. |
| D-REFUND | Refund rules (mechanics implemented per R-61; policy still open): failed unlock, device faults, completion failures, operator-review outcomes, disputes; refund to wallet vs to original payment; approval workflow. | Phase 10 / admin | Admin adjustments with reason only; maker-checker recommended. |
| D-ELIG | Rider eligibility: minimum age, ID verification, terms. | Phase 4 | `eligibility_status` field reserved. |
| D-UI | Brand colors, logo, app icon, splash, typography. | Phase 11 (mobile UI) | Neutral placeholder theme tokens. |
| D-HOST | Hosting provider for staging/production API, DB, web apps. | Phase 15 (staging) | Must offer managed PG 16 and region suitable for Ethiopia latency. |
| D-EMAIL | Email OTP provider (SMTP/API vendor). | Phase 4 | Interface only until chosen. |
| D-L10N | Languages at launch (Amharic, English, others?). | Phase 11 | i18n scaffolding planned. |
| D-IOT | Supplier, device model, and protocol documentation. | IoT phase | Blocks real hardware work entirely. |
| D-EXPO | Expo account/organization and EAS project ownership; Apple/Google developer accounts. | Phase 11 | Access not verified; no `EXPO_TOKEN` in environment. |

## Open technical items to verify

| ID | Item |
|---|---|
| T-01 | **Chapa integration is unverified.** Official docs (developer.chapa.co) are blocked by the egress proxy; search excerpts are not sufficient. Endpoints, webhook signing/verification, test mode, and amount limits must come from the official docs before Phase 8. The owner must allow the domain or provide the docs. |
| T-02 | GeezSMS API exact request/response format from its Postman documentation. |
| T-03 | Expo SDK 57 + pnpm monorepo Metro configuration (`nodeLinker` setting) validated in Phase 1. |
| T-04 | Official documentation sites (docs.expo.dev, nextjs.org, fastify.dev, orm.drizzle.team, zod.dev, reactnative.dev) are blocked by the egress proxy. Versions are verified via npm registry metadata and the projects' GitHub repositories. Allowing these domains would let future sessions read the docs directly. |
