# Captain — Decisions

Record every decision here. Unresolved items must not be decided in code;
make them configurable and reference the ID.

## Resolved

| ID | Decision | Date | Rationale |
|---|---|---|---|
| R-01 | Captain is a dockless scooter-sharing rental platform in Ethiopia (not ride-hailing). | 2026-10-04 | Owner correction. |
| R-02 | TypeScript throughout, pnpm monorepo, Turborepo task runner. | 2026-10-04 | Owner architecture; Turborepo adds cached checks. |
| R-03 | Mobile: Expo SDK 57 + Expo Router; web: Next.js 16 (App Router). | 2026-10-04 | Owner architecture; current stable versions verified on npm. |
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
| R-17 | TypeScript pinned to **6.0.x**, not 7.x. | 2026-10-04 | `typescript-eslint` 8.71 peer range `<6.1.0`. |
| R-18 | React pinned repo-wide to the Expo SDK version (19.2.3 for SDK 57). | 2026-10-04 | Avoid duplicate/mismatched React in shared packages. |
| R-19 | Tests use real PostgreSQL 16: local cluster in cloud sessions, `postgres:16` service in GitHub Actions. No SQLite/PGlite substitution. | 2026-10-04 | Owner constraint; Docker unavailable in sessions. |
| R-20 | Mobile binaries built with EAS cloud builds; Android first. | 2026-10-04 | Owner requirement; no local machine. |
| R-21 | Billable ride time ends at the rider's end request, not at lock ack. | 2026-10-04 | Device delays must not cost riders. Subject to D-PRICE/D-REFUND review. |

## Unresolved (owner decisions required)

| ID | Question | Needed by phase | Notes / current handling |
|---|---|---|---|
| D-LOGIN | Primary login method: phone + SMS OTP (GeezSMS), email + email OTP, or both? | Phase 4 (auth) | Data model supports both identity types. |
| D-PRICE | Unlock fee and per-minute price (ETB). | Phase 9 (rides) | Stored in `pricing_plans`; no production defaults. |
| D-MINBAL | Minimum available balance to start a ride; whether a hold is placed. | Phase 9 | Configurable; ride start blocked below it. |
| D-PAUSE | Pause/hold during ride and reservation before ride: allowed? price? max duration? | Phase 9 | `paused` state designed; disabled until decided. |
| D-LOWBAL | Behaviour when balance runs low/out during a ride (notify, auto-end, allow negative balance?). | Phase 10 | Never auto-lock a moving scooter without a safety decision. |
| D-ZONES | Service area, parking/no-parking zones, out-of-zone fees, parking photo requirement. Adopt PostGIS? | Phase 9/10 | Zone checks feature-flagged off until decided. |
| D-REFUND | Refund rules: failed unlock, device faults, disputes; refund to wallet vs to original payment; approval workflow. | Phase 10 / admin | Admin adjustments with reason only; maker-checker recommended. |
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
| T-01 | Chapa docs (developer.chapa.co) are blocked by this environment's egress proxy; re-verify endpoints, webhook signature scheme, and amount limits from official docs before Phase 8 (ask owner to allow the domain or provide docs). |
| T-02 | GeezSMS API exact request/response format from its Postman documentation. |
| T-03 | Expo SDK 57 + pnpm monorepo Metro configuration (`node-linker` setting) validated in Phase 1. |
