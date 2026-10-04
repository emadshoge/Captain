# Captain — Operational runbooks (DRAFT)

Status: written before any environment exists. Each runbook names the
tools that already exist in the code. Rehearse them in staging (launch
checklist L13, L14) and update them with what actually happens.

Golden rules:
- **Never send device commands to "fix" a ride automatically**; a person
  checks the scooter (R-22/R-23).
- **Never credit money from a redirect, screenshot or client claim**;
  verify with the provider (R-57).
- Every manual money action has a reason and is audited; refunds need a
  second administrator.
- Record every incident: timeline, impact, actions, follow-ups.

## R1. API down or not ready

1. Check `/health` (process) and `/ready` (database + migrations).
2. `/ready` → `migrations: pending`: a release step was skipped; run the
   release migration job (deployment §4) — do not hand-edit tables.
3. `/ready` → `database: error`: see R2.
4. Process crash loop: read the last error logs (request id, `err.type`);
   roll back to the previous image (deployment §4 Rollback).
5. Riders mid-ride are safe: ride state is in PostgreSQL; the drill
   "API killed during an active ride" shows the ride continues after a
   restart and is charged once.

## R2. Database unavailable or failing over

1. Confirm in the provider console (status, failover, storage full,
   connection limit).
2. The API and worker survive dropped connections and reconnect (R-87);
   expect 5xx while the database is unreachable.
3. Storage full: increase storage; do not delete ledger/audit data.
4. After recovery: `/ready`, then check the worker resumed (sweep logs),
   open `operational_alerts`, payments in `pending`.

## R3. Payment in review / rider says "I paid but my balance did not change"

1. Staff web → Payments → filter `review` or the rider's payments.
2. Open the payment events: status, verified amount/currency/reference.
3. Click **Re-verify** (asks the provider again; never credits on its
   own). If it moves to `succeeded`, the wallet is credited exactly once.
4. Still `review` (mismatch, success after failure): compare with the
   provider dashboard. Resolve by refund or adjustment with a reason; a
   second admin approves refunds.
5. Never credit based on the rider's screenshot alone.

## R4. Unlock acknowledged late / scooter state unknown (`late_unlock_ack`, `unlock_failed`)

1. Staff web → Incidents; the ride is `start_failed` and the rider was
   not charged; the scooter is in `maintenance`.
2. Send someone to the scooter or contact the rider. Check physically
   whether it is unlocked/being ridden.
3. If a ride actually happened, create a manual charge only with an
   approved policy (D-REFUND/D-BILLCUT) — otherwise resolve as no charge.
4. Return the scooter to `available` with a reason once checked.

## R5. Ride stuck in operator review (completion not confirmed)

1. Staff web → Rides → `operator_review` → open the ride and event log.
2. Check where the scooter is (telemetry) and whether it is parked.
3. Resolve: **Complete and charge** with a billing cutoff (end request
   time by default) or **Complete without charge**; both need a reason.
4. Never lock the scooter remotely unless it is confirmed stationary;
   supplier devices have no lock path until the protocol is known.

## R6. IoT gateway down / devices offline

1. Gateway `/health`: API errors, buffered telemetry, device count.
2. Restart the gateway; it reloads the device list before taking any
   command (R-81). Commands that time out meanwhile fail safe (no charge;
   scooter to maintenance; incident).
3. Many `device_offline` alerts at once usually mean the gateway or the
   mobile network, not the scooters.

## R7. Suspected leaked secret

1. Rotate the secret in the provider (payment, SMS, email, Mapbox) and in
   the secret store; redeploy.
2. `AUTH_SECRET` rotation invalidates sessions and CSRF tokens (riders and
   staff sign in again); TOTP secrets are encrypted with a key derived
   from it — plan a TOTP re-enrolment or keep the old key for decryption
   (follow-up: dedicated TOTP key, R-48).
3. `INTERNAL_API_TOKEN`: rotate on API and gateway together.
4. Review the audit log and provider logs for misuse; record the incident.

## R8. Bad release

1. Roll back app images (deployment §4); migrations are additive.
2. If data was written incorrectly: stop the writer, assess with read-only
   queries, fix forward with a reviewed migration or audited staff
   actions; restore to a new instance only with owner approval.

## R9. Restore from backup

1. Create a **new** database instance from the backup/PITR point (never
   overwrite the live database in place).
2. Recreate roles (`captain_app`), restore with privileges.
3. Run `node dist/cli/migrate.js --status` and `/ready` against it.
4. Verify: ledger sum = 0, payment/ride counts against expectations,
   latest audit entries.
5. Switch `DATABASE_URL` only with owner approval; reconcile payments that
   happened after the restore point with the provider.
