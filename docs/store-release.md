# Captain — App store release checklist (DRAFT)

Status: preparation only. No build has been produced (EAS access B9) and no
store accounts exist (B10). Store policies change; confirm each item
against the current Google Play and Apple App Store documentation before
submitting (documentation sites are not reachable from the development
environment, T-04).

## Both stores
- [ ] EAS `production` build succeeds for the target platform (B9) — a JS
      bundle export is **not** a native build.
- [ ] App identifiers fixed: `et.captain.rider` (Android package / iOS
      bundle id) — confirm before the first upload; they cannot change later.
- [ ] Version and build numbers: `version` in `app.json`; build numbers
      auto-incremented remotely (`eas.json` → `production.autoIncrement`).
- [ ] Production API URL set in EAS environment variables (B12).
- [ ] Privacy policy URL and support contact (approved text, D-LEGAL).
- [ ] In-app account deletion path works end to end (API:
      `POST /v1/rider/me/deletion-request` + admin completion).
- [ ] Permission texts match actual use: camera (QR scan), location when
      in use (nearby scooters, parking check). No microphone, no
      background location (blocked in `app.json`).
- [ ] Payments: wallet top-ups go through the payment provider's checkout
      for a real-world service; confirm the store's rules for physical
      services/top-ups with the current policy text.
- [ ] Screenshots and descriptions with approved branding (B11); no
      SIMULATED/test data visible.
- [ ] Test accounts for store review (a reviewer phone/email that can
      receive codes, and a funded test wallet in a non-production
      environment or clear review notes).
- [ ] Crash/error reporting decision (none integrated yet).

## Google Play
- [ ] Play Console account and app created (B10).
- [ ] Data safety form: phone/email, approximate and precise location
      (in use), payment info handled by the provider, purchase history
      (rides, top-ups).
- [ ] Internal testing track first; then closed testing.
- [ ] Target API level requirement for new apps (check current policy).

## Apple App Store
- [ ] Apple Developer Program membership and App Store Connect app (B10).
- [ ] App privacy "nutrition label" answers consistent with the Play data
      safety form.
- [ ] Export compliance: `usesNonExemptEncryption: false` is set in
      `app.json` (standard HTTPS only) — confirm.
- [ ] TestFlight internal testing before review.
