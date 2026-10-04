# Captain — Product Specification

Status: Phase 0 draft. Items marked **[OPEN Dxx]** depend on unresolved
decisions in `docs/decisions.md`.

## 1. Summary

Captain is a dockless electric scooter rental platform operating in
Ethiopia. A rider funds a prepaid wallet in Ethiopian Birr (ETB) through
Chapa, locates a scooter on a map, scans the QR code on the scooter,
unlocks it, rides, parks it, and ends the rental. The ride cost is
deducted from the wallet.

Captain is **not** ride-hailing: there are no drivers, passengers, or
trip matching.

## 2. Products

| # | Product | Users | Tech |
|---|---------|-------|------|
| 1 | Rider mobile app (Android, iOS) | Riders | Expo / React Native |
| 2 | Rider web app | Riders | Next.js |
| 3 | Admin web dashboard | Captain staff (admins) | Next.js (`staff-web`, `/admin` routes) |
| 4 | Operator web dashboard | Field/fleet operators | Next.js (shares the `staff-web` app with admin, separate `/operator` routes) |
| 5 | Backend API | All apps | Node.js (Fastify) + PostgreSQL |
| 6 | IoT gateway | Scooters (IoT modules) | Node.js; **implemented later from supplier docs** |

## 3. Fixed requirements

- Brand name: **Captain**. Colors and assets: **[OPEN D-UI]**.
- Currency: **ETB** only. Stored internally as integer santim.
- Payments: **Chapa**.
- Minimum wallet top-up: **500 ETB**. No business maximum; Chapa's
  provider limits apply and are surfaced to the rider as errors.
- Ride start is **blocked** when available balance is insufficient
  (threshold: **[OPEN D-MINBAL]**).
- Maps: **Mapbox** (mobile and web).
- Identity verification channels: **email OTP** and **SMS OTP via
  GeezSMS**, both behind provider interfaces. Primary login method:
  **[OPEN D-LOGIN]**.
- Separate permission sets for **rider**, **operator**, and **admin**.
- IoT: supplier may provide a TCP protocol. No packet formats or commands
  are defined until supplier documentation arrives.
- Simulated hardware, payments, and OTP exist only for development and
  staging and are clearly labelled. They cannot run in production.

## 4. Rider journeys

### J1 — Onboarding and sign-in
1. Open app → welcome screen.
2. Enter identifier (phone or email, per **[OPEN D-LOGIN]**).
3. Receive OTP (GeezSMS or email) → enter code.
4. First time: profile (name), accept terms and privacy policy; eligibility
   checks per **[OPEN D-ELIG]** (e.g. age confirmation).
5. Land on map home.

Failure cases: OTP not delivered (resend with cooldown), wrong code
(limited attempts, then lockout window), expired code, provider outage
(show error; never auto-accept).

### J2 — Wallet top-up
1. Wallet screen shows available balance, held amount, and history.
2. Tap "Top up" → enter amount (≥ 500 ETB; validated client- and
   server-side).
3. Backend creates a pending payment and initializes a Chapa transaction →
   rider is sent to Chapa checkout (in-app browser / redirect).
4. Rider returns to app → "Payment processing" until the backend verifies
   the transaction with Chapa (webhook and/or verify call).
5. On verification, wallet is credited; rider sees the new balance.

Failure cases: rider abandons checkout (payment stays pending then
expires), Chapa reports failure, webhook arrives before return, webhook
never arrives (backend polls verify), duplicate webhook (idempotent).

### J3 — Find a scooter
1. Map home shows rider location and available scooters (battery level,
   distance), plus zones per **[OPEN D-ZONES]**.
2. Tap scooter → details card: battery/range estimate, pricing
   (**[OPEN D-PRICE]**), "Scan to ride".
3. Optional reservation per **[OPEN D-PAUSE]**.

### J4 — Unlock and start ride
1. Tap "Scan to ride" → camera QR scanner (manual code entry fallback).
2. Backend checks: rider eligible, no other active ride, available balance
   ≥ minimum (**[OPEN D-MINBAL]**), scooter available and online, inside
   service zone (if zones enabled).
3. If any check fails → clear message (e.g. "Top up to ride"); no ride is
   created. Insufficient balance links to top-up.
4. Backend creates ride in `unlock_pending`, sends unlock command to the
   device gateway, waits for acknowledgment.
5. Ack success → ride `active`, timer starts, rider sees "Ride in progress".
6. Ack failure/timeout → ride `unlock_failed`; rider is not charged; offered
   retry or another scooter.

### J5 — Riding
- Ride screen: elapsed time, running cost estimate, battery, map with
  rider/scooter position, zone warnings, "End ride".
- Pause/hold per **[OPEN D-PAUSE]**. Any physical lock while paused is
  allowed only when the scooter is documented as stationary.
- Low balance during ride per **[OPEN D-LOWBAL]**. It never triggers an
  automatic lock or propulsion cut-off while the scooter is moving.
- Help/report problem button.

### J6 — Park and end ride
Tapping "End ride" **requests** completion. It is not by itself the final
billing event.
1. Rider taps "End ride" → ride moves to `end_requested`; the request time
   and location are recorded.
2. Parking validation per **[OPEN D-PARK]** (zones, photo, outcome when
   outside allowed parking). If parking is rejected, the rider is told
   where to move and the ride stays active.
3. Ride moves to `completion_pending` while the system waits for the
   device to confirm completion. The mechanism comes from the supplier
   protocol (**[OPEN D-ENDCONF]**).
4. Confirmation → ride `completed`; fare computed using the billing cutoff
   chosen under **[OPEN D-BILLCUT]**; wallet charged once; receipt shown.
5. Timeout, failure, or inconsistent device data → ride
   `operator_review`; rider sees that the end request was recorded and the
   ride is being checked. No automatic charge happens while a ride is in
   review. Billing and refund outcome per **[OPEN D-BILLCUT, D-REFUND]**.

### J7 — History, receipts, support
- Ride history with route summary, duration, fare breakdown.
- Wallet transactions (top-ups, ride charges, refunds/adjustments).
- Report a problem (damaged scooter, billing dispute) → creates a support
  ticket visible to admins.

### J8 — Account
- Profile, sign-out, delete account request, language (Amharic/English —
  localization scope to be confirmed, see decisions).

## 5. Rider screens (mobile and web)

| Screen | Mobile | Web | Notes |
|---|---|---|---|
| Welcome / sign-in | ✓ | ✓ | |
| OTP entry | ✓ | ✓ | |
| Profile setup & terms | ✓ | ✓ | |
| Map home (scooters, zones) | ✓ | ✓ | Mapbox |
| Scooter details card | ✓ | ✓ | |
| QR scanner | ✓ | ✓ (camera if permitted) | manual code fallback on both |
| Unlocking (progress) | ✓ | ✓ | shows waiting for device ack |
| Active ride | ✓ | ✓ | |
| End ride / parking check | ✓ | ✓ | |
| Ride receipt | ✓ | ✓ | |
| Wallet & top-up | ✓ | ✓ | Chapa checkout |
| Payment result / processing | ✓ | ✓ | |
| Ride history | ✓ | ✓ | |
| Support / report problem | ✓ | ✓ | |
| Account & settings | ✓ | ✓ | |

Web rider app limitation: background location and some camera behavior
are browser-dependent. The web app must work without QR camera access via
manual scooter code entry.

## 6. Operator responsibilities (Operator dashboard)

Operators run the physical fleet. They can:
- View fleet map: scooter location, battery, status, online/offline,
  simulated vs real badge.
- Change operational status: `available`, `maintenance`, `charging`,
  `retired`, `missing` (not ownership/pricing).
- Issue device commands allowed for operators, limited to commands the
  supplier protocol actually documents. Motion-affecting commands require
  the documented stationary-state check. Each command is logged with
  operator identity.
- Handle field tasks: rebalancing, battery swap/charging, retrieve
  badly-parked scooters, repair tickets.
- Work the `operator_review` queue: rides whose completion was not
  confirmed, late unlock acknowledgments, telemetry inconsistent with
  ride state, parking disputes. Confirm physical state on site and record
  a resolution. Device commands are never sent automatically to resolve
  these, and commands that could lock wheels or cut propulsion are never
  sent while a scooter may be moving (architecture §9).
- Cannot: change prices, change zones, adjust wallets, manage staff.

## 7. Admin responsibilities (Admin dashboard)

Admins run the business. They can:
- Manage riders: view, suspend/unsuspend, view ride and wallet history.
- Wallet adjustments and refunds (append-only ledger entries with reason,
  maker-checker approval recommended — **[OPEN D-REFUND]**).
- View payments and reconcile with Chapa.
- Configure pricing plans (**[OPEN D-PRICE]**), minimum balance
  (**[OPEN D-MINBAL]**), zones (**[OPEN D-ZONES]**).
- Manage staff accounts and assign roles (admin, operator).
- Register scooters and IoT devices (QR code ↔ scooter ↔ device binding).
- View audit log of all staff actions.
- Reports: rides, revenue, fleet utilization.
- Everything operators can see (read-only by default; admin may act).

## 8. Permissions overview

| Capability | Rider | Operator | Admin |
|---|---|---|---|
| Own profile, rides, wallet | ✓ | – | – |
| Start/end own ride | ✓ | – | – |
| View fleet (all scooters, devices) | – | ✓ | ✓ |
| Change scooter operational status | – | ✓ | ✓ |
| Send service device commands | – | ✓ | ✓ |
| Resolve rides in operator review | – | ✓ | ✓ |
| View any rider's data | – | limited (ride context) | ✓ |
| Wallet adjustments / refunds | – | – | ✓ |
| Pricing, zones, minimum balance | – | – | ✓ |
| Staff and role management | – | – | ✓ |
| Audit log | – | – | ✓ |

Riders and staff are separate account types; a rider token can never be
used against staff endpoints and vice versa.

## 9. Non-functional requirements

- Mobile networks in Ethiopia can be slow/intermittent: APIs idempotent,
  clients retry safely, unlock/lock flows tolerate delays.
- All money operations are auditable and reproducible from the ledger.
- Time stored in UTC; displayed in Africa/Addis_Ababa (EAT, UTC+3).
- Ethiopian phone numbers normalized to E.164 (+251…).
- Observability: structured logs with request IDs; no secrets or full OTP
  codes in logs.

## 10. Out of scope (for now)

- Real IoT protocol implementation (blocked on supplier documentation).
- Subscriptions/passes, promo codes, referral programs.
- Multiple cities/currencies.
- Ride-hailing features of any kind.
