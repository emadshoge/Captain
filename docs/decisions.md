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
| D-UNPAID | Negative balances / unpaid debt handling and collection. | Phase 8 | `low_balance_floor_santim`; start blocked while balance below minimum. |
| D-LEGAL | Approved terms, privacy, support wording and translations. | Phase 9–11, launch | Placeholders marked DRAFT – NOT APPROVED. |
| D-DNS | Confirm captain.et ownership and DNS access. | Phase 13 | Instructions prepared; not applied. |
| D-REFUND | Refund rules: failed unlock, device faults, completion failures, operator-review outcomes, disputes; refund to wallet vs to original payment; approval workflow. | Phase 10 / admin | Admin adjustments with reason only; maker-checker recommended. |
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
