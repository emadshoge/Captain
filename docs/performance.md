# Captain — Performance and resilience (Phase 12)

Status: **measured in a cloud development container with SIMULATED devices
and a fake payment provider.** These numbers describe this test on this
machine. They are not a capacity guarantee for production, which depends on
the hosting choice (D-HOST), database size, network latency in Ethiopia and
real device behaviour (D-IOT).

## How to reproduce

```bash
pnpm build
TEST_DATABASE_ADMIN_URL=postgres://… pnpm --filter @captain/api perf     # load test
TEST_DATABASE_ADMIN_URL=postgres://… pnpm --filter @captain/api drills   # failure drills
```

Both scripts (`apps/api/perf/`) create a throwaway PostgreSQL 16 database
(migrated, DEV FIXTURE pricing, labelled PERF scooters), run the **built**
API and worker bundles, and drop the database afterwards. The load script
plays the device gateway itself (batched telemetry, command
acknowledgments after ~150 ms). Workload size is set with
`PERF_SCOOTERS`, `PERF_RIDERS`, `PERF_RIDING`, `PERF_DURATION_SECONDS`,
`PERF_RIDE_SECONDS`. CI (`resilience` job) runs all drills and a 20-second
load smoke test (150 scooters, 50 riders, 20 riding).

## Documented workload (full run)

| Parameter | Value |
|---|---|
| Scooters reporting telemetry every 10 s (batches of 100) | 300 |
| Riders signed in through the real OTP flow | 100 |
| Riders browsing (nearby + wallet every 5 s) | 100 |
| Riders riding continuously (start → ride 5 s → end) | 40 |
| Duration | 60 s |
| Machine | cloud container, 4 vCPU, Node 22.22.0, PostgreSQL 16.14 on the same machine |

## Results — 2026-10-04 (full run)

All requests answered with the expected status (0 unexpected responses).
Latencies in milliseconds, measured by the client (includes local HTTP).

| Operation | Count | p50 | p95 | p99 | max | Acceptance p95 |
|---|---:|---:|---:|---:|---:|---:|
| GET nearby scooters | 1,200 | 9 | 207 | 287 | 300 | 500 |
| GET wallet | 1,200 | 10 | 135 | 198 | 218 | 300 |
| POST ride start | 440 | 62 | 468 | 491 | 495 | 800 |
| GET ride (polling) | 3,212 | 5 | 38 | 70 | 92 | 300 |
| POST ride end | 440 | 28 | 66 | 83 | 128 | 800 |
| POST telemetry (batch of 100) | 21 | 226 | 398 | 795 | 795 | 1,500 |
| GET pending commands (gateway) | 312 | 3 | 10 | 38 | 99 | 500 |
| POST command result (gateway) | 880 | 22 | 53 | 62 | 75 | 500 |

Ride lifecycle (client view, including the simulated device's ~150 ms ack
delay and 100 ms polling):

| Measure | Value |
|---|---|
| Rides completed | 440 |
| Start refused | 0 |
| Start request → ride active, p50 / p95 | 399 / 741 ms |
| End request → completed, p50 / p95 | 315 / 448 ms |
| Rides left in operator review | 0 |
| Ledger sum after the run | 0 (balanced) |
| API and worker processes alive at the end | yes |

Observations:
- Telemetry ingestion is the heaviest write path (~2–4 ms per report: each
  report is validated, stored and may move the scooter). At 300 scooters
  every 10 s this is ~10 % of one core; much larger fleets will need
  batched inserts or a dedicated ingestion path — to be revisited with the
  real supplier protocol (D-IOT), whose reporting interval is unknown.
- Ride start p95 (~470 ms) is dominated by lock waits when many requests
  arrive together (scooter row, wallet row), by design (R-65).

## Failure drills (`pnpm --filter @captain/api drills`)

| Drill | Result (2026-10-04) |
|---|---|
| API killed with SIGKILL during an active ride, restarted | PASS — ready again in ~0.3 s; ride still active; retried start with the same Idempotency-Key returned the same ride; ride ended and was charged exactly once |
| Device never acknowledges the unlock, and one of two workers is killed | PASS — remaining worker timed the command out; ride `start_failed`, no charge, scooter set to maintenance, incident opened; a late ack changed nothing and no automatic command was sent |
| All database connections terminated under the running API | PASS — process stayed up; next request succeeded (~12 ms) |
| Invariants after the drills | PASS — ledger balanced, no ride charged twice |

**Defect found and fixed by the database drill:** no `pg` pool had an
`error` listener, so a server-side termination of an idle connection
(database restart, failover, maintenance) crashed the API/worker process.
`createPool` now always attaches a listener (logged by the API and worker);
covered by `packages/db/test/pool.test.ts` (decision R-87).

## Not tested

- Real network conditions (mobile networks in Ethiopia), TLS, a separate
  database host, connection poolers, multiple API instances behind a load
  balancer (hosting not chosen, D-HOST).
- Real supplier devices and their TCP protocol (D-IOT); real Chapa and SMS
  latency (blocked).
- Long-duration soak tests and database growth (telemetry retention is a
  pending privacy/retention decision).
