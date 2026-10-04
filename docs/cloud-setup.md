# Cloud development setup

All Captain development, tests, and builds run in Claude Code cloud sessions
and GitHub Actions. Nothing runs on a laptop.

## What happens automatically

`.claude/settings.json` registers a **SessionStart hook**
(`.claude/hooks/session-start.sh`). In a cloud session
(`CLAUDE_CODE_REMOTE=true`) it runs `scripts/cloud-setup.sh` synchronously
before the session starts working:

1. Refuses to run if `APP_ENV` is `staging` or `production`.
2. Checks Node.js ≥ 22.12 and the pnpm version in `package.json`
   (`packageManager`), activating it with corepack if needed.
3. `pnpm install --frozen-lockfile`: installs exactly what
   `pnpm-lock.yaml` records and fails if the lockfile is out of date.
4. `scripts/db-local.sh start`: creates (first time) or reuses an isolated
   PostgreSQL 16 cluster in `/var/tmp/captain-pg16`, **outside the
   repository**. As root, the server runs as the `postgres` OS user
   (PostgreSQL refuses root). It listens only on `127.0.0.1:54329`, waits
   for `pg_isready`, and creates `captain_dev` and `captain_test`.
5. Applies migrations to the **local** `captain_dev` database only. The
   URL is built from the local cluster settings, never from an inherited
   `DATABASE_URL`. `db:migrate` also refuses `APP_ENV=production`.
6. Exports `APP_ENV=development`, `DATABASE_URL`,
   `TEST_DATABASE_ADMIN_URL` and telemetry opt-outs into the session.

Every step is idempotent. Re-running reuses the installed packages and the
existing cluster, and leaves a running server alone. On failure the
script prints the step name and exit code, and the hook tells you to
re-run `bash scripts/cloud-setup.sh`.

Outside cloud sessions the hook does nothing.

> The hook takes effect for new sessions once `.claude/` is on the branch
> the session starts from, normally `main` after this PR merges. Until
> then, run `bash scripts/cloud-setup.sh` at the start of a session.

## What you must configure in the cloud environment dashboard

Open the cloud environment menu in the session's title bar, then **Edit**.
See https://code.claude.com/docs/en/cloud-environments.

**Required for Phase 1: nothing.** The default network access already
allows the npm registry, and the hook handles everything else.

Do **not** set these as environment variables: `APP_ENV=staging`,
`APP_ENV=production`, or any production `DATABASE_URL`. The setup script
refuses to run with them.

**Recommended (optional)**: set Network access to **Custom**, keep the
default package-manager list, and add these allowed domains. This lets
sessions read official documentation and run every Expo check:

| Domain | Why |
|---|---|
| `docs.expo.dev` | Expo documentation |
| `api.expo.dev`, `cdp.expo.dev` | `expo-doctor` schema check; EAS later |
| `reactnative.directory` | `expo-doctor` package metadata check |
| `nextjs.org`, `fastify.dev`, `orm.drizzle.team`, `zod.dev`, `reactnative.dev` | official framework docs |
| `developer.chapa.co` | **required before Phase 8** (Chapa docs) |
| `api.chapa.co` | Chapa API, from Phase 8 (test keys only) |

**Later phases** (not needed now):
- Phase 11 (EAS builds): add an `EXPO_TOKEN` environment variable (an
  Expo access token for the Captain Expo account). Never paste it into
  chat.
- Phase 8: Chapa **test** secret key as an environment variable. Its name
  will be defined from the official docs.

## GitHub Actions

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`:
- **checks**: format, lint, typecheck, tests against a `postgres:16`
  service container (throwaway CI credentials), and builds of the API,
  IoT gateway, and both Next.js apps.
- **mobile**: Expo config and Android/iOS JS bundle export, plus
  `expo-doctor`. This is not a native build. Native builds need EAS
  (Phase 11).

No repository secrets are needed.

## Useful commands

```bash
bash scripts/cloud-setup.sh      # full setup (idempotent)
pnpm db:local status|start|stop  # local PostgreSQL 16 cluster
pnpm check                       # format, lint, typecheck, test, build, Expo check
pnpm --filter @captain/api dev   # API on 127.0.0.1:3000 (needs session env)
```
