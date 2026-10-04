# Captain — Deployment preparation (Phase 13)

Status: **prepared, not deployed.** No staging or production environment
exists. Deploying needs a hosting account and an explicit owner
authorization (user action B7), DNS access for captain.et (B8) and the
provider credentials listed in `docs/user-actions.md`. Nothing in this
document has been executed against real infrastructure; the drills below
ran against throwaway databases in CI and the development container.

## 1. What runs

| Process | Image | Command | Scale | Notes |
|---|---|---|---|---|
| API | `captain-api` (`docker/node-service.Dockerfile`, `APP=api`) | `node dist/server.js` | ≥ 2 instances behind HTTPS | stateless; `/health` (liveness), `/ready` (DB + migrations) |
| Worker | `captain-api` | `node dist/worker.js` | 1–2 (advisory lock: one active sweeper) | command timeouts, ride recovery, reconciliation, purges |
| Migrations (release job) | `captain-api` | `node dist/cli/migrate.js` | one-off per release | see §4 |
| IoT gateway | `captain-iot-gateway` (`APP=iot-gateway`) | `node dist/main.js` | 1+ (supplier protocol decides) | **needs inbound TCP** from scooters once D-IOT is resolved; health on `HEALTH_PORT` |
| Rider web | `captain-rider-web` (`docker/web.Dockerfile`, `APP=rider-web`) | standalone Next.js server | ≥ 1 | `NEXT_PUBLIC_API_URL` is a **build** argument (one image per environment) |
| Staff web | `captain-staff-web` (`APP=staff-web`) | standalone Next.js server | ≥ 1 | staff only; consider IP allow-listing |
| PostgreSQL 16 | managed service | — | primary + backups (+ replica later) | PostGIS not required |

CI (`images` job) builds all four images on every PR and smoke-tests them:
migrations from the image, API `/ready`, worker running, gateway health,
both web apps serving, and the production guard refusing fake providers.
Images are **not pushed** anywhere until a registry is chosen with the
hosting provider.

## 2. Hosting requirements and evaluation (D-HOST)

Requirements (from the architecture):

1. Managed PostgreSQL 16 with automated backups, point-in-time recovery,
   encryption at rest, private networking to the app tier.
2. Container hosting for long-running processes (API, worker) — not only
   request-scoped functions, because the worker and gateway run loops.
3. **Inbound raw TCP** for the IoT gateway (supplier devices typically
   keep long-lived TCP connections). Many HTTP-only platforms cannot do
   this; it must be confirmed per provider and depends on the supplier
   protocol (D-IOT).
4. HTTPS termination with managed certificates for `captain.et`
   subdomains; HTTP/1.1 + HTTP/2.
5. Secrets management (environment variables injected at runtime, not in
   images), audit of who changed them.
6. Logs retained ≥ 30 days with search; metrics and alerting.
7. Latency to Ethiopian mobile networks: measure from Addis Ababa before
   choosing (no assumptions in this document).
8. Data residency / regulatory requirements for payment and identity data
   in Ethiopia: **to be confirmed by the owner** (legal question, D-LEGAL).

Evaluation matrix to fill in with real quotes and measurements (no
prices are invented here):

| Criterion | Candidate A | Candidate B | Candidate C |
|---|---|---|---|
| Managed PostgreSQL 16 + PITR | | | |
| Long-running containers | | | |
| Inbound TCP for gateway | | | |
| Region / measured RTT from Addis Ababa | | | |
| Private network DB ↔ app | | | |
| Managed TLS for custom domains | | | |
| Secrets management | | | |
| Logs / metrics / alerting | | | |
| Monthly cost estimate (from provider calculator) | | | |
| Support / SLA | | | |

Candidates worth evaluating include large clouds with African regions and
container platforms that support TCP services; the choice and the numbers
belong to the owner (B7).

## 3. Environments

| | development / test | staging | production |
|---|---|---|---|
| Purpose | cloud sessions, CI | full rehearsal, provider **test** modes | real riders and money |
| Database | throwaway / local cluster | own managed instance | own managed instance |
| Payments | `fake` (SIMULATED) | Chapa **test** mode (after T-01) | Chapa live (after L3/L4) |
| OTP | log-only | real SMS/email to testers | real |
| Devices | simulator | simulator + test scooter (after B6) | supplier devices only (simulated refused) |
| Pricing | DEV FIXTURE | approved draft | approved (D-PRICE) |
| Config guard | — | required vars enforced | required vars + production guard |

Rules: separate accounts/projects or at least separate databases and
secrets per environment; no production data in staging; staging may never
use live payment keys. The production guard (`packages/config`) refuses
fake/log-only/simulated providers, development secrets and verbose logs.

### Required configuration (names only; values live in the platform's secret store)

API/worker: `APP_ENV`, `DATABASE_URL`, `AUTH_SECRET`, `INTERNAL_API_TOKEN`,
`CORS_ORIGINS`, `COOKIE_SECURE=true`, `TRUST_PROXY`, `STAFF_MFA_REQUIRED=true`,
`OTP_SMS_PROVIDER`/`OTP_EMAIL_PROVIDER` (+ provider credentials),
`PAYMENT_PROVIDER` (+ provider credentials, `PUBLIC_API_URL`,
`RIDER_RETURN_URL`), `REFUNDS_REQUIRE_SECOND_APPROVER=true`,
`RIDE_BILLING_CUTOFF`, `RIDE_END_CONFIRMATION`, `RIDE_PARKING_POLICY`,
`DEVICE_ADAPTER`, fleet thresholds (defaults documented in
`apps/api/.env.example`).
Gateway: `APP_ENV`, `DEVICE_ADAPTER`, `API_INTERNAL_URL` (private
network), `INTERNAL_API_TOKEN`, `HEALTH_PORT`.
Web images: `NEXT_PUBLIC_API_URL` (build argument), `PORT`.

## 4. Release process

1. CI green on the release commit (all jobs: checks, mobile, e2e,
   resilience, images).
2. Build images tagged with the commit SHA; push to the registry (once
   chosen).
3. **Backup**: trigger an on-demand database backup (or confirm a PITR
   window) and note its identifier in the release record.
4. **Migrations** (release job, before new API instances start):
   - `node dist/cli/migrate.js --status` — review the pending list;
   - production only: set `CAPTAIN_MIGRATE_CONFIRM_DATABASE=<database
     name>` for this run (refused otherwise), then
     `node dist/cli/migrate.js`.
   Migrations must be **backward compatible** with the previous API
   version (expand → deploy → contract in a later release), so a rollback
   of the app never needs a schema rollback.
5. Deploy worker and API (rolling); `/ready` must report `ready` before an
   instance receives traffic.
6. Deploy web apps; deploy gateway last (it reconnects to devices).
7. Smoke checks: `/ready`, sign-in on staging accounts, a SIMULATED ride
   in staging, payment test mode (staging only).
8. Record the release (commit, images, migration list, backup id) in the
   release log.

### Rollback

- App rollback: redeploy the previous image tags. Possible because
  migrations are additive (step 4).
- Schema problems: do not hand-edit production. Write a forward fix
  migration; if data was damaged, restore to a new instance from the
  pre-release backup / PITR and reconcile (see runbooks).
- Rehearse once in staging before launch (launch checklist L14).

## 5. DNS and HTTPS (captain.et, B8)

Proposed records (to be created only after B7/B8):

| Name | Purpose |
|---|---|
| `captain.et` / `www` | rider web (and landing page) |
| `api.captain.et` | API (HTTPS only; HSTS) |
| `staff.captain.et` | staff web (consider IP allow-list / VPN) |
| `gw.captain.et` | IoT gateway TCP endpoint (only if the supplier needs a hostname; TLS per supplier capability) |
| `api.staging.captain.et`, `staging.captain.et`, `staff.staging.captain.et` | staging |

Rider web and API must stay **same-site** (both under `captain.et`):
session cookies are `SameSite=Strict` and `__Host-` prefixed (R-78).
`CORS_ORIGINS` lists the exact web origins.

## 6. Webhook endpoints

- `POST https://api.captain.et/v1/webhooks/chapa` (once the Chapa adapter
  exists; T-01). Webhooks only trigger server-side verification
  (R-57); signature verification follows the official docs.
- Development-only routes (`/v1/dev/*`, fake checkout) are not registered
  outside development/test.

## 7. Gateway networking

- Gateway ↔ API over the **private network** (`/internal/v1`, service
  token; never exposed publicly — block `/internal` at the edge).
- Scooters ↔ gateway: inbound TCP on a dedicated port; exact protocol,
  keep-alive, TLS and authentication depend on supplier docs (D-IOT,
  B6). Plan for a static IP or hostname that the devices are configured
  with, and for draining connections during deploys.

## 8. Monitoring and alerting

| Signal | Source | Alert when |
|---|---|---|
| API liveness/readiness | `/health`, `/ready` | not ready for > 2 min |
| Error rate | structured logs (`level` ≥ error, `statusCode` 5xx) | > 1 % of requests over 5 min |
| Latency | request logs (`responseTime`) | p95 above the levels in `docs/performance.md` for 10 min |
| Worker | worker logs (`sweep` results) / process up | no sweep for 5 min |
| Gateway | `/health` on `HEALTH_PORT` (connected devices, buffered telemetry, API errors) | down, or API errors rising |
| Operational alerts | `operational_alerts` table (staff web) | critical alerts (e.g. `payment_review`) open > 15 min |
| Payments | `payment_attempts` in `review`/`pending` older than 1 h | any |
| Database | provider metrics | CPU > 80 %, storage > 80 %, connections near the limit, replication lag |
| Backups | provider | backup failed or older than 24 h |

Logs are JSON via `@captain/logging` with request ids and redaction;
never log request bodies or secrets.

## 9. Backups and restore

- Managed daily backups + PITR (provider setting), retention per the
  privacy/retention policy (draft, `docs/privacy-retention.md`).
- Restore drill (automated, CI `resilience` job and
  `pnpm --filter @captain/api backup-drill`): `pg_dump --format=custom`,
  `pg_restore` into a fresh database, then verify row counts, the ledger
  sum, the migration record, and that the append-only trigger and
  balanced-journal check are present. Result (2026-10-04, development
  container): PASS — dump 112 ms, restore 300 ms for a small labelled
  dataset (62 scooters, 20 riders).
- Production restores keep ownership and privileges (the drill uses
  `--no-owner --no-privileges` because it restores into a throwaway
  database): create the `captain_app` role first, restore with
  privileges, run `/ready`.
- Staging restore from a real staging backup is launch checklist L13.

## 10. Runbooks

See `docs/runbooks.md`.
