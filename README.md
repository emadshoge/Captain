# Captain

Scooter-sharing rental platform for Ethiopia: find a scooter, scan its QR
code, unlock, ride, park, end the rental.

| Path | What |
|---|---|
| `apps/api` | Backend API (Fastify, PostgreSQL) |
| `apps/iot-gateway` | Device gateway skeleton (no protocol until supplier docs) |
| `apps/rider-mobile` | Rider app (Expo SDK 57, Android/iOS) |
| `apps/rider-web` | Rider web app (Next.js) |
| `apps/staff-web` | Admin (`/admin`) and operator (`/operator`) areas (Next.js; placeholders, no auth yet) |
| `packages/contracts` | Shared Zod API contracts |
| `packages/config` | Env config + production safety guard |
| `packages/db` | Drizzle schema, SQL migrations, test DB helper |

Start here: [`CLAUDE.md`](CLAUDE.md), [`docs/`](docs/), and
[`docs/cloud-setup.md`](docs/cloud-setup.md) for the cloud environment.
