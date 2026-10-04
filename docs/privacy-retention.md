# Account deletion and data retention

Status: **DRAFT — NOT APPROVED.** Engineering proposal. Legal review is
required before launch (decision D-LEGAL). Ethiopian data-protection and
financial record-keeping obligations must be confirmed by counsel.

## Rider-initiated deletion (implemented, Phase 4)

`POST /v1/rider/me/deletion-request` (requires `{ "confirm": true }`):
- sets `riders.status = 'deletion_requested'` and `deletion_requested_at`;
- revokes every session immediately;
- writes an audit row (`rider.deletion_requested`).

The rider can no longer sign in. Signing in again with the same contact
is refused while the request is pending (account not active).

## Staff completion (Phase 5)

A staff member with `riders.manage` completes the deletion when:
- there is no open ride or reservation;
- there is no open dispute or incident;
- the wallet balance is zero, or the remaining balance has been settled
  per the refund policy (D-REFUND, D-UNPAID).

Completion:
| Data | Action |
|---|---|
| `riders.display_name`, preferred language | cleared |
| `rider_contacts` (phone/email) | deleted, freeing the contact for a new account |
| `otp_challenges` destinations for the rider | deleted |
| `auth_sessions` / `session_tokens` | revoked (and later purged) |
| `riders.status` | `deleted`, `deleted_at` set |
| Rides, ride events, receipts | **retained**: financial and safety records, linked only to the pseudonymous rider id |
| Ledger, payments, refunds, adjustments | **retained**: append-only financial records (cannot be altered by design) |
| Incidents and audit log | **retained**: free-text fields reviewed for personal data |

Retention periods for retained records: **[OPEN D-LEGAL]**.
