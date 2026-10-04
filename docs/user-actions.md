# Owner actions required

Things only the owner can do: decisions, accounts, credentials, hardware.
**Never paste secrets into chat.** Secrets go into the protected
configuration named below: Claude cloud environment variables, GitHub
Actions secrets, EAS environment variables, or the hosting provider's
secret store. Claude checks presence without printing values.

Status: **open**, **done** (with date and evidence), or **n/a**.

## A. Business decisions (grouped; see `docs/decisions.md`)

| ID | Decision needed | Blocks | Current handling | Status |
|---|---|---|---|---|
| D-LOGIN | Primary launch login: phone + SMS OTP, email + email OTP, or both offered | Phase 9–10 copy and default flow; real OTP verification | Both channels implemented behind config `AUTH_RIDER_CHANNELS` | open |
| D-PRICE | Unlock fee (ETB) and per-minute price (ETB) | Production pricing plan | Pricing is versioned config; dev fixture plan labelled `DEV FIXTURE` | open |
| D-ROUND | Billing rounding (per started minute? per second?) and pause charge | Production pricing | Configurable `rounding` and `pause_per_minute` fields | open |
| D-MINBAL | Minimum available balance to start; wallet hold amount | Production pricing | Configurable; ride start blocked below it | open |
| D-RESERVE | Reservations allowed? Window length? Fee? | Production config | Configurable; disabled unless a plan enables it | open |
| D-PAUSE | Pause allowed? Max pause? | Production config | Configurable; disabled by default | open |
| D-LOWBAL | Behaviour when balance runs out mid-ride (notify only, allow negative, end-on-park request) | Production config | Notify + allow negative up to configured floor; **never** a hardware action | open |
| D-MAXRIDE | Maximum ride duration and what happens at the limit | Production config | Configurable; triggers rider notification + operator alert only | open |
| D-ZONES | Service area, parking, restricted zones for launch city | Real zone data | Zones editable by admins; none seeded for production | open |
| D-BILLCUT / D-PARK / D-ENDCONF | Billing cutoff, parking validation, what device signal confirms completion, timeouts | Production config, real IoT | Configurable policy; default for development only | open |
| D-REFUND / D-UNPAID | Refunds, cancellations, penalties, negative balances/unpaid debt | Production policy | Staff refund/adjustment tools with reasons; no automatic penalties | open |
| D-ELIG | Rider eligibility (age, ID verification, terms) | Onboarding | Terms acceptance + configurable minimum age attestation | open |
| D-UI / D-L10N / D-LEGAL | Palette, logo, launch languages, approved terms/privacy/support wording | Store listings, public launch | Provisional style; English strings; legal text placeholders marked **DRAFT – NOT APPROVED** | open |

## B. Accounts, credentials and access

| # | Action | Why | Where | Names (no values) | Blocks | Verified by | Status |
|---|---|---|---|---|---|---|---|
| B1 | Allow official docs domains (or provide the docs) | Integrations must follow official docs; currently proxy-blocked | Claude cloud environment → Network access → Custom (keep defaults) | `developer.chapa.co`, `api.chapa.co`, `documenter.getpostman.com`, `geezsms.com`, `docs.mapbox.com`, `api.mapbox.com`, `docs.expo.dev`, `api.expo.dev`, `expo.dev` | Phases 7 (Chapa), 4 (GeezSMS), 9 (Mapbox) | Claude fetches the pages in a new session | open |
| B2 | Chapa merchant **test** account and keys | Implement + test payments | Chapa dashboard → API keys; store as env vars | `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET` (final names fixed after docs review) | Phase 14 Chapa | Test top-up credited exactly once in staging | open |
| B3 | GeezSMS account + API token, approved sender ID | SMS OTP | GeezSMS dashboard; env vars | `GEEZSMS_API_TOKEN`, `GEEZSMS_SENDER_ID` | Real SMS OTP | Owner receives a real OTP SMS | open |
| B4 | Choose email provider and create SMTP credentials | Email OTP | Provider dashboard; env vars | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Real email OTP | Owner receives a real OTP email | open |
| B5 | Mapbox account: public token (URL-restricted) and secret download token | Maps on web/mobile; native SDK download | Mapbox account → Tokens; EAS env + web env | `NEXT_PUBLIC_MAPBOX_TOKEN`, `EXPO_PUBLIC_MAPBOX_TOKEN`, `RNMAPBOX_MAPS_DOWNLOAD_TOKEN` (EAS secret) | Real maps | Map renders in staging web + dev build | open |
| B6 | IoT supplier protocol docs, one test scooter/device, SIM with data | Real hardware integration | Upload docs to the repo or share via a protected location | — | Phase 15 | Recorded fixtures + live device test | open |
| B7 | Hosting account (with long-lived TCP support) and explicit staging authorization | Staging deploy | Chosen provider | provider-specific | Phase 13 deploy | Staging health checks green | open |
| B8 | DNS access for captain.et (confirm ownership) | HTTPS, webhooks | Registrar / DNS host | records documented in `docs/deployment.md` | Staging/production domains | `dig` + TLS check | open |
| B9 | Expo account/organization; `EXPO_TOKEN` | EAS builds | expo.dev → Access tokens; Claude env var + GitHub secret | `EXPO_TOKEN` | Phase 9 native builds | EAS build succeeds and installs | open |
| B12 | EAS environment variables per profile | Mobile builds must point at the right API | expo.dev → Project → Environment variables (after B9) | `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_APP_ENV` (public, not secret); later `EXPO_PUBLIC_MAPBOX_TOKEN` | Phase 9 preview/production builds | Installed preview build signs in against staging | open (needs staging host, D-HOST) |
| B10 | Google Play Console and Apple Developer accounts | Store distribution | Respective consoles | — | Store submission | Internal test track / TestFlight install | open |
| B11 | Approve brand assets and legal/support content | Store listing, launch | Commit to `apps/*/assets` / content files or share | — | Public launch | Owner sign-off recorded | open |
