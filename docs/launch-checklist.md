# Launch checklist

Captain is **not** production-ready because tests pass. Each item needs
real evidence: what was done, by whom, when, and a link or record. Items
needing real users, phones, hardware or provider accounts stay
**pending** until actually performed.

Readiness levels: foundation → demo (simulated end-to-end) → staging
(deployed, real providers in test mode) → pilot (real scooters, limited
riders) → production.

**Current readiness (2026-10-04): demo.** The whole rider/staff/payment/
ride flow works end to end against SIMULATED devices, a fake payment
provider and log-only OTP, verified in CI. Nothing is deployed; no real
provider, phone build or scooter has been exercised. See
`docs/status-report.md`.

| # | Evidence required | Depends on | Status | Evidence |
|---|---|---|---|---|
| L1 | A real OTP SMS received on an Ethiopian number (GeezSMS) | B3, D-LOGIN | pending | — |
| L2 | A real OTP email received | B4 | pending | — |
| L3 | Controlled payment in Chapa test mode credits the wallet exactly once (with duplicate webhook replay) | B1, B2, staging | pending | — |
| L4 | Controlled **live** payment credits exactly once and reconciles with the Chapa dashboard | L3, explicit owner instruction | pending | — |
| L5 | Real scooter telemetry (location, battery) visible in the operator dashboard | B6, Phase 15 | pending | — |
| L6 | Real unlock: command acknowledged and the scooter physically unlocks | B6 | pending | — |
| L7 | Safe ride completion with correct charge per approved pricing | L6, D-PRICE, D-BILLCUT | pending | — |
| L8 | Recovery drills: app killed mid-ride, phone offline, device offline, gateway restart, API restart | L6 | pending on real hardware; **simulated** drills pass in CI (API SIGKILL mid-ride, silent device + worker killed, DB connections dropped, gateway restart before API) | `apps/api/perf/drills.ts`, `docs/performance.md`, R-81 |
| L9 | Backend permission enforcement reviewed (automated matrix + manual attempt as operator) | Phase 5 | partial: automated matrix (API tests) and browser attempts as an operator (staff E2E: admin pages refused, API 403 with the operator session); a human review on staging remains | `apps/api/test/authz.test.ts`, `apps/staff-web/e2e/staff.spec.ts` |
| L10 | Android app installed from an EAS build and tested on a real phone | B9 | pending | — |
| L11 | iPhone app installed via TestFlight/internal and tested | B9, B10 | pending | — |
| L12 | Web rider and staff flows tested on staging in real browsers | staging | pending (Playwright E2E passes in CI against a local stack with simulated providers) | CI `e2e` job |
| L13 | Database backup restored into a scratch instance and verified | staging | pending (procedure automated: `backup-drill` in CI on throwaway data; staging restore still required) | — |
| L14 | Release rollback rehearsed | staging | pending (procedure in `docs/deployment.md` §4; requires staging) | — |
| L15 | Payment ↔ ledger reconciliation report matches provider records | L3 | pending (CSV export and re-verify implemented; needs real provider records) | — |
| L16 | Approved pricing, zones, legal text, branding in production config | Section A of user-actions | pending | — |
| L17 | Small controlled operational pilot completed with incident review | all above | pending | — |
| L18 | Production launch explicitly authorized by the owner | L1–L17, L19 | pending | — |
| L19 | Every production staff account has enrolled TOTP (implemented Phase 5, R-48) | production staff list | pending | — |
