# Provider Workers

## Strategy

Work 06 uses PostgreSQL-backed durable jobs. It does not use an in-memory array and does not require a browser to remain open.

Work 07.1 adds strict shared parsing for worker/provider environment settings. In particular, `PROVIDER_JOB_LOCK_TIMEOUT_MS` must be greater than `TTC_HTTP_TIMEOUT_MS`, `PROVIDER_POLL_INITIAL_MS` must not exceed `PROVIDER_POLL_MAX_MS`, and batch/retry/poll values must be unsigned integers in their supported ranges. Invalid configuration stops the worker instead of being clamped or silently coerced.

`apps/worker` handles:

- `SUBMIT_ORDER`
- `POLL_ORDER_STATUS`
- `SYNC_SERVICES`
- `SYNC_BALANCE`
- `TEST_CONNECTION`

## Local commands

```bash
npm run dev:worker
npm run worker:start
npm run worker:once
```

`worker:once` is cross-platform and processes one due batch before exiting. It is useful for deterministic QA.

## Claiming and crash recovery

A worker:

1. reads due PENDING/RETRY jobs plus stale RUNNING jobs;
2. conditionally updates the row to RUNNING with `lockedAt/lockedBy`;
3. increments attempts only when the claim succeeds;
4. processes claimed rows sequentially within the process;
5. writes COMPLETED, RETRY, MANUAL_REVIEW or FAILED.

Stale locks become claimable after `PROVIDER_JOB_LOCK_TIMEOUT_MS`.

## Retry/backoff

Read-only/transient failures may use exponential backoff + jitter. Side-effecting `createOrder` is retried only if provider capabilities make it safe. An ambiguous create without provider idempotency becomes manual review.

Configuration:

- `PROVIDER_WORKER_POLL_MS`
- `PROVIDER_JOB_BATCH_SIZE`
- `PROVIDER_JOB_LOCK_TIMEOUT_MS`
- `PROVIDER_MAX_ATTEMPTS`
- `PROVIDER_POLL_INITIAL_MS`
- `PROVIDER_POLL_MAX_MS`

## Polling

Accepted non-terminal provider orders get a durable future poll job. Long-running orders are polled more slowly. Completed/failed/cancelled/refunded states do not receive normal ongoing polling.

## Deployment

Production should run the web process and at least one dedicated provider worker process. Multiple worker replicas may run because each job claim is conditional and database-backed. Provider outbound calls acquire `ProviderRequestLease` rows under Serializable transactions. `Provider.maxConcurrentRequests` and `Provider.minRequestIntervalMs` therefore provide a database-coordinated concurrency/rate gate across worker replicas. Provider-specific values must be tuned from the verified provider contract before enabling a live adapter at scale.

## Redis/BullMQ

Architecture documents previously recommended Redis/BullMQ. Work 06 intentionally chooses PostgreSQL durable jobs as the current production-safe baseline allowed by the Work 06 brief. Redis/BullMQ can replace/augment dispatch later without changing ProviderAdapter or provider-domain semantics.

## Standalone worker environment loading

The worker entry scripts run through `apps/worker/src/bootstrap.ts`. The bootstrap loads the repository-root `.env` before importing any worker module so `DATABASE_URL` and centralized provider/queue settings are available during module evaluation. Deployment-level environment variables remain authoritative and are not overwritten by `.env`.
