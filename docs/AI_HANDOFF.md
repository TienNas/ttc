# AI HANDOFF

Current Work: Work 07 — TTC Provider Production Acceptance
Completed Task: Work 07.1 — Provider configuration hardening
Next Task: Work 07.2 — TTC read-only verification

## Completed Works

- Work 01 — Architecture baseline
- Work 02 — Design System

## Implemented but not fully accepted

- Work 03 — Customer Application
- Work 04 — Backend and database
- Work 05 — Admin operations
- Work 06 — Provider integration

## Work 07.1 completed

- Central provider/worker environment parsing uses strict booleans, integers and positive decimals.
- Routing remains usable in the disabled state without TTC credentials.
- Routing fails closed when TTC credentials, XU-to-VND conversion or rate-input configuration is missing or invalid.
- Worker timing rejects lock expiry inside the configured TTC HTTP request window and inconsistent polling settings.
- `.env.example` no longer presents an unverified TTC conversion as operational configuration.
- Production development-account seeding is disabled by default and explicitly enabling it is rejected.
- Configuration and seed-safety unit tests were added.

## Remaining Tasks in Current Work

- Work 07.2 — Perform read-only TTC verification with an authorized credential and authoritative conversion evidence.
- Work 07.3 — Accept live catalog pricing and service mappings.
- Work 07.4 — Harden provider submission/reconciliation safety.
- Work 07.5 — Add worker heartbeat/fencing and multi-worker recovery tests.
- Work 07.6 — Complete provider staging tests.
- Work 07.7 — Complete production acceptance and rollback drill.

## Known Issues

- Work 03–06 final runtime/browser acceptance evidence remains incomplete.
- TTC live behavior has not been verified in this Work environment.
- TTC create-order API has no documented idempotency/client-reference field.
- PostgreSQL integration tests require a local test database.

## Manual Actions Required

- Obtain and store the TTC API key only in the server secret environment.
- Establish the authoritative `TTC_XU_TO_VND_RATE` and `TTC_RATE_INPUT_UNIT` before Work 07.2.
- Keep `PROVIDER_ROUTING_ENABLED=false` until live read-only verification and mapping review pass.
- Use a separate audited production account-provisioning process; do not enable development seeds in production.

## Last Validation

- lint: PASS — `npm run lint:web`
- typecheck: PASS — `npm run typecheck:providers`, `npm run typecheck:worker`, `npm run typecheck:web`
- tests: PASS — provider configuration/core (20), database seed configuration (4), Work 06 static contract; PostgreSQL integration suites BLOCKED because no client/database or `TEST_DATABASE_URL` is available
- database schema: PASS — `npm run db:validate`
- build: PASS — `npm run build:web`
- live TTC: NOT RUN
