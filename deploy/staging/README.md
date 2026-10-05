# Captain staging on one Linux server

A kit for running the whole Captain **staging** system on one Ubuntu/Debian
VPS with Docker. One command builds and releases any branch.

It is **not production**:

- scooters are **SIMULATED** (labelled everywhere);
- there is **no payment provider** (Chapa is blocked, T-01). Testers get
  balance through an audited admin adjustment;
- the business rules for billing cutoff, end confirmation and parking use
  **staging test values** from `.env`. These are not decisions (D-BILLCUT,
  D-ENDCONF, D-PARK).

The production guard refuses this configuration under `APP_ENV=production`.

## What runs

| Service | Image | Notes |
|---|---|---|
| `postgres` | `postgres:16` | Data in the `pgdata` volume. No port is published. |
| `migrate` | API image | One-off release job (owner user). |
| `api`, `worker` | API image | Connect as `captain_api`, a member of the least-privilege `captain_app` role. |
| `gateway` | gateway image | Simulated devices only. Reaches the API over the private Docker network with the internal token. |
| `rider-web`, `staff-web` | web images | Built with `NEXT_PUBLIC_API_URL=https://$API_HOST`. |
| `caddy` | `caddy:2` | Ports 80/443 with automatic Let's Encrypt certificates. Blocks `/internal/*` on the public API host. |

## Before you start

1. **Server:** a VPS with Ubuntu 22.04/24.04, 2 vCPU, 4 GB RAM and 40 GB
   disk, with SSH access. Open ports 22, 80 and 443.
2. **DNS** (B8): create three `A` records pointing to the server IP:
   `staging.captain.et`, `api.staging.captain.et` and
   `staff.staging.captain.et`.
3. **Postmark** (B4, R-92): a server, a verified sender address for
   `EMAIL_FROM`, and its SMTP credentials. Sign-in only works with real
   email codes.
4. **GitHub read access** for the server's checkout: a read-only *deploy
   key* on the repository, or HTTPS with a fine-grained read-only token.

## First deployment

```bash
ssh youruser@your-server
sudo apt-get update && sudo apt-get install -y git
git clone git@github.com:emadshoge/Captain.git ~/Captain   # with the deploy key
cd ~/Captain
git checkout --detach origin/claude/staging-deploy-kit       # any ref that contains deploy/staging

sudo bash deploy/staging/setup.sh          # installs Docker, creates .env with generated secrets
sudo nano deploy/staging/.env              # fill ACME_EMAIL, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM
sudo bash deploy/staging/deploy.sh origin/claude/staging-deploy-kit
sudo bash deploy/staging/create-admin.sh you@example.com "Your Name"
```

The first build takes several minutes. Then:

1. Open `https://staff.staging.captain.et`. Sign in with the email code,
   then scan the TOTP QR code with an authenticator app (required in
   staging).
2. **Admin → Pricing:** create a plan (label it STAGING TEST) and activate
   it.
3. **Admin → Onboarding:** add a scooter and a **Simulated** device, then
   assign the device to the scooter. The gateway picks up new devices
   within about **60 seconds**. Then set the scooter to *available*.
4. Open `https://staging.captain.et`, sign in with your email and note the
   rider. **Admin → Riders → adjustment** (with a reason) gives the tester a
   balance. Ride with the scooter code.

## Updating to a new version (for example a UI change)

```bash
cd ~/Captain
sudo bash deploy/staging/deploy.sh origin/<branch-or-tag>
```

Each run:

1. fetches and checks out the commit;
2. builds the images tagged with the commit;
3. **backs up the database**;
4. runs migrations;
5. replaces the services;
6. checks `/ready`.

It refuses a server checkout with local changes, and refs that predate this
kit.

```bash
sudo bash deploy/staging/rollback.sh       # previous release's images (migrations are additive)
sudo bash deploy/staging/backup.sh         # on-demand backup → deploy/staging/backups/ (last 14 kept)
docker compose -p captain-staging ps       # status
docker compose -p captain-staging logs -f api
```

Restoring is always done **into a new database** (`docs/runbooks.md` R9).

## Secrets

- `deploy/staging/.env` lives only on the server: mode 600, ignored by git.
  The scripts print variable names, never values.
- Never paste these values into chat or commit them. To rotate a secret, edit
  `.env` and run `deploy.sh` again. Changing `AUTH_SECRET` signs everyone
  out and requires TOTP re-enrolment (`docs/runbooks.md` R7).

## Verified so far

- `pnpm --filter @captain/api staging-rehearsal` (also in CI) runs the built
  services with this configuration and walks the first-deployment path:
  migrations, the runtime user from `deploy.sh`'s own SQL, the staff CLI, an
  email code over SMTP with STARTTLS, TOTP enrolment, pricing, simulated
  onboarding, rider email sign-in, an audited credit, and a ride charged
  exactly once.
- **Not run:** Docker Compose itself, Caddy/Let's Encrypt and Postmark
  delivery. There is no Docker daemon or outbound SMTP in the development
  environment. The first real deployment is the test of those parts.
