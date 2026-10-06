set -euo pipefail

EXPECTED_BASE="5739601f2776cbcfce69e5ab115ebcbfa3da7dc0"
PATCH_FILE=""
REPO_ROOT=""
SCRIPT_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/$(basename -- "${BASH_SOURCE[0]}")"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$PATCH_FILE" && -f "$PATCH_FILE" ]]; then
    rm -f -- "$PATCH_FILE"
  fi
  if [[ -n "$REPO_ROOT" ]]; then
    git -C "$REPO_ROOT" restore --worktree -- apps/web/next-env.d.ts apps/web/tsconfig.tsbuildinfo >/dev/null 2>&1 || true
  fi
}

run_check() {
  local label="$1"
  shift
  printf '\n[RUN] %s\n' "$label"
  if "$@"; then
    printf '[PASS] %s\n' "$label"
  else
    printf '[FAIL] %s\n' "$label" >&2
    return 1
  fi
}

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Run this script inside a Git clone of NhatTiens/ttc."
REPO_ROOT="$(cd -- "$(git rev-parse --show-toplevel)" && pwd -P)"
cd "$REPO_ROOT"

ORIGIN_URL="$(git config --get remote.origin.url || true)"
case "$ORIGIN_URL" in
  https://github.com/*/ttc|https://github.com/*/ttc.git|git@github.com:*/ttc|git@github.com:*/ttc.git|ssh://git@github.com/*/ttc|ssh://git@github.com/*/ttc.git)
    ;;
  *)
    fail "Repository identity check failed. Expected NhatTiens/ttc or a GitHub fork named ttc; found '${ORIGIN_URL:-<none>}'."
    ;;
esac

printf 'Current branch: '
git branch --show-current
printf 'Current commit: '
git rev-parse HEAD

SCRIPT_RELATIVE=""
case "$SCRIPT_PATH" in
  "$REPO_ROOT"/*) SCRIPT_RELATIVE="${SCRIPT_PATH#"$REPO_ROOT"/}" ;;
esac

if [[ -n "$SCRIPT_RELATIVE" && "$(git status --porcelain --untracked-files=all -- "$SCRIPT_RELATIVE")" == "?? $SCRIPT_RELATIVE" ]]; then
  WORKTREE_STATUS="$(git status --porcelain --untracked-files=all -- . ":(exclude)$SCRIPT_RELATIVE")"
else
  WORKTREE_STATUS="$(git status --porcelain --untracked-files=all)"
fi

if [[ -n "$WORKTREE_STATUS" ]]; then
  git status --short >&2
  fail "Working tree must be clean before applying Work 07.1 (the untracked delivery script itself is allowed)."
fi

git cat-file -e "${EXPECTED_BASE}^{commit}" 2>/dev/null || fail "Expected base commit is not present: $EXPECTED_BASE"
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD || fail "Current HEAD is not based on expected commit $EXPECTED_BASE."

PATCH_FILE="$(mktemp "${TMPDIR:-/tmp}/apply_work07_1.XXXXXX.patch")"
trap cleanup EXIT

cat >"$PATCH_FILE" <<'WORK07_1_PATCH'
diff --git a/.env.example b/.env.example
index bf09912851730d309737eeb2085532871ca18ec8..663b80d1aef381841acb56d472d9b35415387fbf 100644
--- a/.env.example
+++ b/.env.example
@@ -8,7 +8,8 @@ AUTH_TRUST_HOST="true"
 # Optional when running behind a non-standard host/proxy.
 # AUTH_URL="http://localhost:3000"
 
-# Idempotent development seed account. Never use these values in production.
+# Idempotent development seed accounts. Never use these values in production.
+# Production defaults to no development accounts and rejects an explicit true flag.
 SEED_DEVELOPMENT_ACCOUNT="true"
 SEED_DEVELOPMENT_EMAIL="minh@example.com"
 SEED_DEVELOPMENT_PASSWORD="demo1234"
@@ -38,9 +39,9 @@ PROVIDER_POLL_MAX_MS=1200000
 TTC_API_BASE_URL="https://tuongtaccheo.com/api/v2"
 TTC_API_KEY=""
 TTC_HTTP_TIMEOUT_MS=10000
-# TTC service rates are reported in XU. Set the authoritative VND value of 1 XU
-# before syncing services or enabling provider routing. Example only: 1000 means 1 XU = 1000 VND.
-TTC_XU_TO_VND_RATE="0.0175"
+# TTC service rates are reported in XU. This intentionally has no default.
+# Set an authoritative positive VND value of 1 XU before enabling provider routing.
+TTC_XU_TO_VND_RATE=""
 # TTC rate is treated as the cost for this quantity unit; API v2 follows the standard per-1000 model.
 TTC_RATE_UNIT=1000
 
diff --git a/PROVIDER_WORKERS.md b/PROVIDER_WORKERS.md
index 184df76f5bbe37c70b88aa6ad7c4548bfb9fba33..4d9871147026a745a639eb451b0a273589388bf0 100644
--- a/PROVIDER_WORKERS.md
+++ b/PROVIDER_WORKERS.md
@@ -4,6 +4,8 @@
 
 Work 06 uses PostgreSQL-backed durable jobs. It does not use an in-memory array and does not require a browser to remain open.
 
+Work 07.1 adds strict shared parsing for worker/provider environment settings. In particular, `PROVIDER_JOB_LOCK_TIMEOUT_MS` must be greater than `TTC_HTTP_TIMEOUT_MS`, `PROVIDER_POLL_INITIAL_MS` must not exceed `PROVIDER_POLL_MAX_MS`, and batch/retry/poll values must be unsigned integers in their supported ranges. Invalid configuration stops the worker instead of being clamped or silently coerced.
+
 `apps/worker` handles:
 
 - `SUBMIT_ORDER`
diff --git a/TTC_INTEGRATION.md b/TTC_INTEGRATION.md
index 5e3ead85dea48c264ee6435e671e333d2ec5bc0a..448327dd4a28db1111ef126aab22a056fc83852b 100644
--- a/TTC_INTEGRATION.md
+++ b/TTC_INTEGRATION.md
@@ -87,6 +87,10 @@ The documented response contains `balance` and `currency`. The supplied document
 
 The application sells customer services in VND, while the TTC documentation reports provider balance/rates in XU. Work 06 does not assume an exchange value.
 
+Work 07.1 centralizes provider environment parsing. `TTC_XU_TO_VND_RATE` is intentionally blank in `.env.example`; routing fails closed until an authoritative positive decimal conversion, API key and rate-input unit are configured. Numeric values reject signs, whitespace, decimals where integers are required and exponent notation. Provider routing can remain disabled without TTC credentials for local development, builds and unit tests.
+
+Worker timing is validated before use. The job lock timeout must exceed the TTC HTTP timeout so a job cannot become stale while its provider request is still within the configured request window. Poll intervals, batch size and retry attempts must also be positive and internally consistent.
+
 Before syncing TTC services into authoritative provider economics, configure:
 
 ```env
@@ -134,15 +138,8 @@ npm run qa:ttc:order
 This can spend TTC provider balance. It must not be used with production customer data unintentionally.
 
 
-## TTC raw-rate normalization (verified 2026-09)
-
-Live TTC service audit returned rates such as Facebook Like = 1800 XU and TikTok View = 250 XU for one requested unit.
-For this deployment:
+## TTC raw-rate normalization
 
-- `TTC_XU_TO_VND_RATE=0.0175`
-- `TTC_RATE_INPUT_UNIT=1`
-- `TTC_RATE_UNIT=1000`
+The adapter normalizes provider XU cost to VND per internal rate unit before `ProviderService` persistence. The repository does not contain an authoritative XU-to-VND conversion. Configure `TTC_XU_TO_VND_RATE` only from verified account/provider evidence during Work 07.2, together with the provider's rate-input unit. Keep routing disabled until that evidence is recorded and the resulting margins are reviewed.
 
-The adapter normalizes provider cost to VND per 1,000 internal units before ProviderService persistence.
-Example: 1800 XU x 0.0175 VND/XU x 1000 = 31,500 VND per 1,000.
 Custom Comments services are synced but remain unavailable for automatic ordering until the customer Order input model carries the required comments/text payload.
diff --git a/apps/web/next.config.ts b/apps/web/next.config.ts
index 19cb2442d4c7aa3c0869d197895aefc104cab27d..c496bec1724c6b663bb96fda84d04a44085019bf 100644
--- a/apps/web/next.config.ts
+++ b/apps/web/next.config.ts
@@ -9,7 +9,7 @@ const nextConfig: NextConfig = {
   reactStrictMode: true,
   poweredByHeader: false,
   typedRoutes: false,
-  transpilePackages: ["@tuong-tac-pro/db", "@tuong-tac-pro/domain"]
+  transpilePackages: ["@tuong-tac-pro/db", "@tuong-tac-pro/domain", "@tuong-tac-pro/providers"]
 };
 
 export default nextConfig;
diff --git a/apps/web/package.json b/apps/web/package.json
index 976c40412d6f551c67ccde2f65eb3ca86ac2d5eb..f99daa344ab6890acb92d7d005b70910e4e3bd36 100644
--- a/apps/web/package.json
+++ b/apps/web/package.json
@@ -15,6 +15,7 @@
   "dependencies": {
     "@tuong-tac-pro/db": "*",
     "@tuong-tac-pro/domain": "*",
+    "@tuong-tac-pro/providers": "*",
     "argon2": "^0.45.1",
     "next": "^16.0.0",
     "next-auth": "5.0.0-beta.32",
diff --git a/apps/web/src/server/admin-queries.ts b/apps/web/src/server/admin-queries.ts
index 3c503ca639d435e630d949691b621ac568509ef7..da54c089cacdb041fa253fc8bc12f7048247b151 100644
--- a/apps/web/src/server/admin-queries.ts
+++ b/apps/web/src/server/admin-queries.ts
@@ -13,6 +13,7 @@ import {
   WalletTransactionType,
   getDb
 } from "@tuong-tac-pro/db";
+import { parseProviderRuntimeConfig } from "@tuong-tac-pro/providers";
 import { moneyToSafeNumber } from "@tuong-tac-pro/domain";
 import type {
   AdminAnalytics,
@@ -582,7 +583,7 @@ function providerBase(row: {
     enabled: row.enabled,
     priority: row.priority,
     baseUrlConfigured: Boolean(row.baseUrl),
-    credentialConfigured: row.code === "TTC" ? Boolean(process.env.TTC_API_KEY) : false,
+    credentialConfigured: row.code === "TTC" ? Boolean(parseProviderRuntimeConfig().ttc.apiKey) : false,
     balance: row.balanceMinor === null ? null : moneyToSafeNumber(row.balanceMinor),
     balanceCurrency: row.balanceCurrency ?? "",
     lastBalanceSyncAt: row.lastBalanceSyncAt?.toISOString() ?? null,
diff --git a/apps/web/src/server/customer-queries.ts b/apps/web/src/server/customer-queries.ts
index 9c67855313ae7d9783b59d2cbc081558b68d07c2..8c9def260dd076646d3e1c54b2d2f6918cbc51d0 100644
--- a/apps/web/src/server/customer-queries.ts
+++ b/apps/web/src/server/customer-queries.ts
@@ -1,5 +1,6 @@
 import { getDb, OrderStatus, Prisma, ProviderMappingStatus, ProviderServiceStatus, ProviderStatus, ServiceStatus, SocialPlatform } from "@tuong-tac-pro/db";
 import { getOwnedTicket, moneyToSafeNumber } from "@tuong-tac-pro/domain";
+import { isProviderRoutingEnabled } from "@tuong-tac-pro/providers";
 import { toCategory, toDeposit, toDepositMethod, toOrder, toProfile, toService, toSupportMessage, toTicket, toWallet, toWalletTransaction } from "./mappers";
 
 const platformToDb = {
@@ -21,7 +22,7 @@ const publicStatusToDb = {
 } as const;
 
 function providerRoutableServiceWhere(): Prisma.ServiceWhereInput {
-  if (process.env.PROVIDER_ROUTING_ENABLED !== "true") return {};
+  if (!isProviderRoutingEnabled()) return {};
   return {
     status: ServiceStatus.ACTIVE,
     providerMappings: {
@@ -115,7 +116,7 @@ export async function readServices(filters: { search?: string; platform?: string
 
 export async function readService(id: string) {
   const routable = providerRoutableServiceWhere();
-  const service = process.env.PROVIDER_ROUTING_ENABLED === "true"
+  const service = isProviderRoutingEnabled()
     ? await getDb().service.findFirst({ where: { id, ...routable } })
     : await getDb().service.findUnique({ where: { id } });
   return service ? toService(service) : null;
diff --git a/apps/web/tests/backend/work6.provider.integration.test.ts b/apps/web/tests/backend/work6.provider.integration.test.ts
index 2023f161c1cec55b8b7739de9ffe3fe63b42e308..497ca694019e2d6b15a96a89725c246808cdf63b 100644
--- a/apps/web/tests/backend/work6.provider.integration.test.ts
+++ b/apps/web/tests/backend/work6.provider.integration.test.ts
@@ -113,11 +113,17 @@ async function seedProvider() {
 
 beforeEach(async () => {
   process.env.PROVIDER_ROUTING_ENABLED = "false";
+  process.env.TTC_API_KEY = "work6-test-key";
+  process.env.TTC_XU_TO_VND_RATE = "1";
+  process.env.TTC_RATE_INPUT_UNIT = "1";
   await reset();
 });
 
 after(async () => {
   delete process.env.PROVIDER_ROUTING_ENABLED;
+  delete process.env.TTC_API_KEY;
+  delete process.env.TTC_XU_TO_VND_RATE;
+  delete process.env.TTC_RATE_INPUT_UNIT;
   await disconnectDb();
 });
 
diff --git a/apps/worker/src/index.ts b/apps/worker/src/index.ts
index e37c012b68825b25c51d43d673cae4ae80a157e6..66a0f6d7a6b9b84dd692ae863ce37aa0e1fbe460 100644
--- a/apps/worker/src/index.ts
+++ b/apps/worker/src/index.ts
@@ -1,11 +1,12 @@
 import { randomUUID } from "node:crypto";
 import { disconnectDb } from "@tuong-tac-pro/db";
-import { createDefaultProviderRegistry } from "@tuong-tac-pro/providers";
+import { createDefaultProviderRegistry, parseProviderRuntimeConfig } from "@tuong-tac-pro/providers";
 import { claimDueProviderJobs } from "./queue";
 import { processProviderJob } from "./provider-worker";
 
-const workerId = process.env.PROVIDER_WORKER_ID || `provider-worker-${randomUUID().slice(0, 8)}`;
-const pollMs = Math.max(250, Number(process.env.PROVIDER_WORKER_POLL_MS || 1000));
+const config = parseProviderRuntimeConfig();
+const workerId = config.workerId ?? `provider-worker-${randomUUID().slice(0, 8)}`;
+const pollMs = config.workerPollMs;
 const once = process.argv.includes("--once") || process.env.PROVIDER_WORKER_ONCE === "true";
 const registry = createDefaultProviderRegistry();
 
diff --git a/apps/worker/src/provider-worker.ts b/apps/worker/src/provider-worker.ts
index 091e1ae72b8a932dae649edd28aaac5700d0b355..29941cd2f0f296b4417ea2701ba32e3fc973b032 100644
--- a/apps/worker/src/provider-worker.ts
+++ b/apps/worker/src/provider-worker.ts
@@ -26,6 +26,7 @@ import {
   decideProviderRetry,
   grossMargin,
   hasSafeMargin,
+  parseProviderRuntimeConfig,
   sanitizeProviderErrorMessage,
   sanitizeProviderValue,
   toProviderAdapterError,
@@ -36,9 +37,6 @@ import {
 import { completeProviderJob, failProviderJob, manualReviewProviderJob, retryProviderJob } from "./queue";
 import { withProviderRequestLease } from "./rate-limit";
 
-const INITIAL_POLL_MS = Number(process.env.PROVIDER_POLL_INITIAL_MS || 60_000);
-const MAX_POLL_MS = Number(process.env.PROVIDER_POLL_MAX_MS || 20 * 60_000);
-
 const TERMINAL_INTERNAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
   OrderStatus.COMPLETED,
   OrderStatus.REFUNDED,
@@ -349,7 +347,9 @@ async function handleSubmitOrder(job: ProviderJob, registry: ProviderRegistry) {
     });
     await markProviderHealth(provider.id, ProviderHealth.HEALTHY);
     await operationLog({ providerId: provider.id, orderId: order.id, externalOrderId: result.externalOrderId, operation: "CREATE_ORDER", startedAt, result: "SUCCESS", attempt: attemptNo });
-    if (internalStatus !== OrderStatus.COMPLETED) await schedulePoll(providerOrder.id, provider.id, order.id, INITIAL_POLL_MS);
+    if (internalStatus !== OrderStatus.COMPLETED) {
+      await schedulePoll(providerOrder.id, provider.id, order.id, parseProviderRuntimeConfig().pollInitialMs);
+    }
   } catch (error) {
     const providerError = toProviderAdapterError(error, true);
     const decision = decideProviderRetry(providerError, job.attempts, job.maxAttempts, {
@@ -451,7 +451,8 @@ async function handlePoll(job: ProviderJob, registry: ProviderRegistry) {
       responsePayload: sanitizeProviderValue(result.raw) as object | undefined
     });
     const ageMinutes = Math.max(0, (Date.now() - providerOrder.createdAt.getTime()) / 60_000);
-    const delay = Math.min(MAX_POLL_MS, INITIAL_POLL_MS * Math.max(1, Math.ceil(ageMinutes / 30)));
+    const config = parseProviderRuntimeConfig();
+    const delay = Math.min(config.pollMaxMs, config.pollInitialMs * Math.max(1, Math.ceil(ageMinutes / 30)));
     await schedulePoll(providerOrder.id, providerOrder.providerId, providerOrder.orderId, delay);
   } catch (error) {
     const providerError = toProviderAdapterError(error, false);
diff --git a/apps/worker/src/queue.ts b/apps/worker/src/queue.ts
index e3724888c757fd7f1b032820210764a8584475cb..eec024dea304e7c343a10bcfb7fe97620828a341 100644
--- a/apps/worker/src/queue.ts
+++ b/apps/worker/src/queue.ts
@@ -1,12 +1,12 @@
 import { ProviderJobStatus, getDb, type ProviderJob } from "@tuong-tac-pro/db";
-import { computeBackoffMs } from "@tuong-tac-pro/providers";
+import { computeBackoffMs, parseProviderRuntimeConfig } from "@tuong-tac-pro/providers";
 
-const LOCK_TIMEOUT_MS = Number(process.env.PROVIDER_JOB_LOCK_TIMEOUT_MS || 5 * 60_000);
-
-export async function claimDueProviderJobs(workerId: string, batchSize = Number(process.env.PROVIDER_JOB_BATCH_SIZE || 10)): Promise<ProviderJob[]> {
+export async function claimDueProviderJobs(workerId: string, batchSize?: number): Promise<ProviderJob[]> {
   const db = getDb();
+  const config = parseProviderRuntimeConfig();
+  const effectiveBatchSize = batchSize ?? config.jobBatchSize;
   const now = new Date();
-  const stale = new Date(now.getTime() - LOCK_TIMEOUT_MS);
+  const stale = new Date(now.getTime() - config.jobLockTimeoutMs);
   const candidates = await db.providerJob.findMany({
     where: {
       OR: [
@@ -15,7 +15,7 @@ export async function claimDueProviderJobs(workerId: string, batchSize = Number(
       ]
     },
     orderBy: [{ runAt: "asc" }, { createdAt: "asc" }],
-    take: Math.max(1, Math.min(batchSize, 100))
+    take: effectiveBatchSize
   });
   const claimed: ProviderJob[] = [];
   for (const candidate of candidates) {
diff --git a/docs/AI_HANDOFF.md b/docs/AI_HANDOFF.md
new file mode 100644
index 0000000000000000000000000000000000000000..4560b6fd552a89136d64fac504c5b7a6a30f74a4
--- /dev/null
+++ b/docs/AI_HANDOFF.md
@@ -0,0 +1,59 @@
+# AI HANDOFF
+
+Current Work: Work 07 — TTC Provider Production Acceptance
+Completed Task: Work 07.1 — Provider configuration hardening
+Next Task: Work 07.2 — TTC read-only verification
+
+## Completed Works
+
+- Work 01 — Architecture baseline
+- Work 02 — Design System
+
+## Implemented but not fully accepted
+
+- Work 03 — Customer Application
+- Work 04 — Backend and database
+- Work 05 — Admin operations
+- Work 06 — Provider integration
+
+## Work 07.1 completed
+
+- Central provider/worker environment parsing uses strict booleans, integers and positive decimals.
+- Routing remains usable in the disabled state without TTC credentials.
+- Routing fails closed when TTC credentials, XU-to-VND conversion or rate-input configuration is missing or invalid.
+- Worker timing rejects lock expiry inside the configured TTC HTTP request window and inconsistent polling settings.
+- `.env.example` no longer presents an unverified TTC conversion as operational configuration.
+- Production development-account seeding is disabled by default and explicitly enabling it is rejected.
+- Configuration and seed-safety unit tests were added.
+
+## Remaining Tasks in Current Work
+
+- Work 07.2 — Perform read-only TTC verification with an authorized credential and authoritative conversion evidence.
+- Work 07.3 — Accept live catalog pricing and service mappings.
+- Work 07.4 — Harden provider submission/reconciliation safety.
+- Work 07.5 — Add worker heartbeat/fencing and multi-worker recovery tests.
+- Work 07.6 — Complete provider staging tests.
+- Work 07.7 — Complete production acceptance and rollback drill.
+
+## Known Issues
+
+- Work 03–06 final runtime/browser acceptance evidence remains incomplete.
+- TTC live behavior has not been verified in this Work environment.
+- TTC create-order API has no documented idempotency/client-reference field.
+- PostgreSQL integration tests require a local test database.
+
+## Manual Actions Required
+
+- Obtain and store the TTC API key only in the server secret environment.
+- Establish the authoritative `TTC_XU_TO_VND_RATE` and `TTC_RATE_INPUT_UNIT` before Work 07.2.
+- Keep `PROVIDER_ROUTING_ENABLED=false` until live read-only verification and mapping review pass.
+- Use a separate audited production account-provisioning process; do not enable development seeds in production.
+
+## Last Validation
+
+- lint: PASS — `npm run lint:web`
+- typecheck: PASS — `npm run typecheck:providers`, `npm run typecheck:worker`, `npm run typecheck:web`
+- tests: PASS — provider configuration/core (20), database seed configuration (4), Work 06 static contract; PostgreSQL integration suites BLOCKED because no client/database or `TEST_DATABASE_URL` is available
+- database schema: PASS — `npm run db:validate`
+- build: PASS — `npm run build:web`
+- live TTC: NOT RUN
diff --git a/package-lock.json b/package-lock.json
index 0d82e941c2f764ef62ce8c130d28eb007bd755d5..e502fab12da96ff33feab6918dd67512fac51bf1 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -22,6 +22,7 @@
       "dependencies": {
         "@tuong-tac-pro/db": "*",
         "@tuong-tac-pro/domain": "*",
+        "@tuong-tac-pro/providers": "*",
         "argon2": "^0.45.1",
         "next": "^16.0.0",
         "next-auth": "5.0.0-beta.32",
diff --git a/package.json b/package.json
index e9f820afb9fafd799a241923600d0f2164fdba36..64d6d24d84b35508761e50177b3c9c0b69d19c47 100644
--- a/package.json
+++ b/package.json
@@ -37,6 +37,7 @@
     "typecheck:providers": "npm --workspace @tuong-tac-pro/providers run typecheck",
     "typecheck:worker": "npm --workspace @tuong-tac-pro/worker run typecheck",
     "test:providers": "npm --workspace @tuong-tac-pro/providers run test",
+    "test:db-config": "npm --workspace @tuong-tac-pro/db run test:config",
     "test:worker": "npm run db:test:prepare && npm --workspace @tuong-tac-pro/worker run test",
     "test:work6": "npm run test:providers && npm run test:backend && npm run test:worker",
     "qa:work6:static": "node qa/work6-provider-contract-check.mjs",
diff --git a/packages/db/package.json b/packages/db/package.json
index 11d7efbf0833d939981bcf74cffc8014992c2571..d206b932f90e7fe656e80ad67626cffe86c0f89b 100644
--- a/packages/db/package.json
+++ b/packages/db/package.json
@@ -12,7 +12,8 @@
     "db:migrate": "prisma migrate deploy",
     "db:migrate:dev": "prisma migrate dev",
     "db:seed": "tsx prisma/seed.ts",
-    "db:studio": "prisma studio"
+    "db:studio": "prisma studio",
+    "test:config": "node --import tsx --test tests/*.test.ts"
   },
   "dependencies": {
     "@prisma/adapter-pg": "7.10.0",
diff --git a/packages/db/prisma/seed.ts b/packages/db/prisma/seed.ts
index 1c49cf09ef1e02a422f4e479edf1ba682bff7f88..9d4db4bab7f744feac76d7abcc3d01b7e503599e 100644
--- a/packages/db/prisma/seed.ts
+++ b/packages/db/prisma/seed.ts
@@ -2,6 +2,7 @@ import { existsSync } from "node:fs";
 import { fileURLToPath } from "node:url";
 import argon2 from "argon2";
 import { getDb } from "../src/client";
+import { resolveDevelopmentSeedConfig } from "../src/seed-safety";
 import { DepositStatus, OrderStatus, ProviderHealth, ProviderStatus, SocialPlatform, ServiceStatus, SupportSenderType, SupportTicketStatus, UserRole, UserStatus, DepositMethodType, WalletTransactionStatus, WalletTransactionType } from "../generated/prisma/client";
 
 const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
@@ -114,9 +115,10 @@ async function main() {
     }
   });
 
-  if (process.env.SEED_DEVELOPMENT_ACCOUNT !== "false") {
-    const email = (process.env.SEED_DEVELOPMENT_EMAIL ?? "minh@example.com").trim().toLowerCase();
-    const password = process.env.SEED_DEVELOPMENT_PASSWORD ?? "demo1234";
+  const developmentSeed = resolveDevelopmentSeedConfig();
+  if (developmentSeed.enabled) {
+    const email = developmentSeed.customerEmail;
+    const password = developmentSeed.customerPassword;
     const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
     const user = await db.user.upsert({
       where: { email },
@@ -159,8 +161,8 @@ async function main() {
       });
     }
 
-    const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.com").trim().toLowerCase();
-    const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "Admin1234";
+    const adminEmail = developmentSeed.adminEmail;
+    const adminPassword = developmentSeed.adminPassword;
     const adminPasswordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
     await db.user.upsert({
       where: { email: adminEmail },
@@ -168,8 +170,8 @@ async function main() {
       create: { email: adminEmail, passwordHash: adminPasswordHash, name: "Tương Tác Pro Admin", status: UserStatus.ACTIVE, role: UserRole.ADMIN }
     });
 
-    const secondEmail = (process.env.SEED_DEVELOPMENT_SECOND_EMAIL ?? "lan@example.com").trim().toLowerCase();
-    const secondPassword = process.env.SEED_DEVELOPMENT_SECOND_PASSWORD ?? "demo1234";
+    const secondEmail = developmentSeed.secondaryEmail;
+    const secondPassword = developmentSeed.secondaryPassword;
     const secondHash = await argon2.hash(secondPassword, { type: argon2.argon2id });
     const secondUser = await db.user.upsert({
       where: { email: secondEmail },
diff --git a/packages/db/src/index.ts b/packages/db/src/index.ts
index 1661c785ad722f060b0567a617c4515d5660650d..526466b185cc5db492347b19bce9a89b1d52da69 100644
--- a/packages/db/src/index.ts
+++ b/packages/db/src/index.ts
@@ -1,2 +1,3 @@
 export { getDb, disconnectDb } from "./client";
+export { resolveDevelopmentSeedConfig, type DevelopmentSeedConfig } from "./seed-safety";
 export * from "../generated/prisma/client";
diff --git a/packages/db/src/seed-safety.ts b/packages/db/src/seed-safety.ts
new file mode 100644
index 0000000000000000000000000000000000000000..6b92da4b38cd1ef65c98e601d61e91b11342651e
--- /dev/null
+++ b/packages/db/src/seed-safety.ts
@@ -0,0 +1,51 @@
+type SeedEnvironment = Record<string, string | undefined>;
+
+export type DevelopmentSeedConfig =
+  | { enabled: false }
+  | {
+      enabled: true;
+      customerEmail: string;
+      customerPassword: string;
+      adminEmail: string;
+      adminPassword: string;
+      secondaryEmail: string;
+      secondaryPassword: string;
+    };
+
+function parseSeedFlag(value: string | undefined, nodeEnvironment: string | undefined): boolean {
+  if (value === undefined || value === "") {
+    return nodeEnvironment === "development" || nodeEnvironment === "test";
+  }
+  if (value === "true") return true;
+  if (value === "false") return false;
+  throw new Error("SEED_DEVELOPMENT_ACCOUNT must be exactly true or false.");
+}
+
+function requiredDevelopmentPassword(env: SeedEnvironment, variable: string, fallback: string): string {
+  const value = env[variable] ?? fallback;
+  if (value.length < 8 || value.length > 200) {
+    throw new Error(`${variable} must contain between 8 and 200 characters for development seeding.`);
+  }
+  return value;
+}
+
+export function resolveDevelopmentSeedConfig(env: SeedEnvironment = process.env): DevelopmentSeedConfig {
+  const nodeEnvironment = env.NODE_ENV?.trim().toLowerCase();
+  const enabled = parseSeedFlag(env.SEED_DEVELOPMENT_ACCOUNT, nodeEnvironment);
+  if (!enabled) return { enabled: false };
+  if (nodeEnvironment === "production") {
+    throw new Error(
+      "Development seed accounts are disabled in production. Use a separate audited account-provisioning process."
+    );
+  }
+
+  return {
+    enabled: true,
+    customerEmail: (env.SEED_DEVELOPMENT_EMAIL ?? "minh@example.com").trim().toLowerCase(),
+    customerPassword: requiredDevelopmentPassword(env, "SEED_DEVELOPMENT_PASSWORD", "demo1234"),
+    adminEmail: (env.SEED_ADMIN_EMAIL ?? "admin@example.com").trim().toLowerCase(),
+    adminPassword: requiredDevelopmentPassword(env, "SEED_ADMIN_PASSWORD", "Admin1234"),
+    secondaryEmail: (env.SEED_DEVELOPMENT_SECOND_EMAIL ?? "lan@example.com").trim().toLowerCase(),
+    secondaryPassword: requiredDevelopmentPassword(env, "SEED_DEVELOPMENT_SECOND_PASSWORD", "demo1234")
+  };
+}
diff --git a/packages/db/tests/seed-safety.test.ts b/packages/db/tests/seed-safety.test.ts
new file mode 100644
index 0000000000000000000000000000000000000000..e4d8c2936bae024bbefc9be4b067aff740d19582
--- /dev/null
+++ b/packages/db/tests/seed-safety.test.ts
@@ -0,0 +1,29 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+import { resolveDevelopmentSeedConfig } from "../src/seed-safety";
+
+test("production does not enable development accounts by default", () => {
+  assert.deepEqual(resolveDevelopmentSeedConfig({ NODE_ENV: "production" }), { enabled: false });
+});
+
+test("production rejects explicitly enabled development accounts", () => {
+  assert.throws(
+    () => resolveDevelopmentSeedConfig({ NODE_ENV: "production", SEED_DEVELOPMENT_ACCOUNT: "true" }),
+    /disabled in production/
+  );
+});
+
+test("local development keeps explicit demo seeding convenient", () => {
+  const config = resolveDevelopmentSeedConfig({ NODE_ENV: "development", SEED_DEVELOPMENT_ACCOUNT: "true" });
+  assert.equal(config.enabled, true);
+  if (!config.enabled) return;
+  assert.equal(config.customerEmail, "minh@example.com");
+  assert.equal(config.adminEmail, "admin@example.com");
+});
+
+test("seed flag parsing is strict", () => {
+  assert.throws(
+    () => resolveDevelopmentSeedConfig({ NODE_ENV: "development", SEED_DEVELOPMENT_ACCOUNT: "TRUE" }),
+    /exactly true or false/
+  );
+});
diff --git a/packages/domain/src/customer-domain.ts b/packages/domain/src/customer-domain.ts
index f754f41ce88b37fdaef7132388970241a76e8a1b..2a06d1811db364eedd4eab30a96e319c4f27da90 100644
--- a/packages/domain/src/customer-domain.ts
+++ b/packages/domain/src/customer-domain.ts
@@ -19,6 +19,7 @@ import { DomainError } from "./errors";
 import { createPublicId } from "./id";
 import { calculateChargeMinor } from "./money";
 import { enqueueOrderSubmissionIfEnabled } from "./provider-domain";
+import { isProviderRoutingEnabled } from "@tuong-tac-pro/providers";
 
 export type OrderCreateInput = { serviceId: string; targetUrl: string; quantity: number };
 export type TicketCreateInput = { subject: string; category: string; message: string };
@@ -138,7 +139,8 @@ export async function createCustomerOrder(userId: string, input: OrderCreateInpu
       const service = await tx.service.findUnique({ where: { id: input.serviceId } });
       if (!service) throw new DomainError("SERVICE_NOT_FOUND", "Không tìm thấy dịch vụ.", 404);
       if (service.status !== ServiceStatus.ACTIVE) throw new DomainError("SERVICE_UNAVAILABLE", "Dịch vụ hiện không nhận đơn mới.", 409);
-      if (process.env.PROVIDER_ROUTING_ENABLED === "true") {
+      const providerRoutingEnabled = isProviderRoutingEnabled();
+      if (providerRoutingEnabled) {
         const mapping = await tx.serviceProviderMapping.findFirst({
           where: {
             serviceId: service.id,
@@ -202,7 +204,7 @@ export async function createCustomerOrder(userId: string, input: OrderCreateInpu
         data: {
           orderId: order.id,
           toStatus: OrderStatus.PENDING,
-          message: process.env.PROVIDER_ROUTING_ENABLED === "true"
+          message: providerRoutingEnabled
             ? "Đơn hàng đã được tạo và đang chờ worker gửi tới nhà cung cấp."
             : "Đơn hàng đã được tạo; provider routing hiện chưa được bật."
         }
diff --git a/packages/domain/src/provider-domain.ts b/packages/domain/src/provider-domain.ts
index 18668e7f6c6b388aa5d6a661a42a2a1f71e3b1bb..5db5138ca508464085c08daf3cc036d8b323bd97 100644
--- a/packages/domain/src/provider-domain.ts
+++ b/packages/domain/src/provider-domain.ts
@@ -16,6 +16,7 @@ import {
 import {
   calculateProviderCost,
   calculateSellingRate,
+  parseProviderRuntimeConfig,
   proportionalRefundTarget,
   sanitizeProviderValue,
   type NormalizedProviderService
@@ -109,14 +110,14 @@ export async function enqueueProviderJob(
       providerOrderId: input.providerOrderId ?? null,
       payload: input.payload,
       runAt: input.runAt ?? new Date(),
-      maxAttempts: input.maxAttempts ?? Number(process.env.PROVIDER_MAX_ATTEMPTS || 6)
+      maxAttempts: input.maxAttempts ?? parseProviderRuntimeConfig().maxAttempts
     },
     update: {}
   });
 }
 
 export async function enqueueOrderSubmissionIfEnabled(tx: Prisma.TransactionClient, orderId: string, publicId: string) {
-  if (process.env.PROVIDER_ROUTING_ENABLED !== "true") return null;
+  if (!parseProviderRuntimeConfig().routingEnabled) return null;
   return enqueueProviderJob(tx, {
     type: ProviderJobType.SUBMIT_ORDER,
     dedupeKey: `submit:${orderId}`,
diff --git a/packages/providers/src/adapters/ttc-provider-adapter.ts b/packages/providers/src/adapters/ttc-provider-adapter.ts
index 29d2ce084aa64631222097dda1d2b69cdc7bc949..200376c6c3d94ce22724efe8844511eab63d9469 100644
--- a/packages/providers/src/adapters/ttc-provider-adapter.ts
+++ b/packages/providers/src/adapters/ttc-provider-adapter.ts
@@ -13,11 +13,9 @@ import type {
 } from "../contracts";
 import { ProviderAdapterError } from "../errors";
 import { providerFetch } from "../http";
+import { parseProviderRuntimeConfig } from "../config";
 
-const DEFAULT_TTC_API_URL = "https://tuongtaccheo.com/api/v2";
 const TTC_ALLOWED_HOSTS = ["tuongtaccheo.com", "www.tuongtaccheo.com"] as const;
-const DEFAULT_TIMEOUT_MS = 10_000;
-const DEFAULT_RATE_UNIT = 1_000;
 const MAX_RESPONSE_BYTES = 2_000_000;
 const SUPPORTED_ORDER_TYPES = new Set(["default", "package"]);
 
@@ -184,12 +182,13 @@ export class TTCProviderAdapter implements ProviderAdapter {
   private readonly rateUnit: number;
 
   constructor(config: TTCProviderConfig = {}) {
-    this.baseUrl = (config.baseUrl ?? process.env.TTC_API_BASE_URL ?? DEFAULT_TTC_API_URL).trim();
-    this.apiKey = (config.apiKey ?? process.env.TTC_API_KEY ?? "").trim();
-    this.timeoutMs = config.timeoutMs ?? Number(process.env.TTC_HTTP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
-    this.xuToVndRate = (config.xuToVndRate ?? process.env.TTC_XU_TO_VND_RATE ?? "").trim();
-    this.rateInputUnit = config.rateInputUnit ?? Number(process.env.TTC_RATE_INPUT_UNIT || "");
-    this.rateUnit = config.rateUnit ?? Number(process.env.TTC_RATE_UNIT || DEFAULT_RATE_UNIT);
+    const runtime = parseProviderRuntimeConfig();
+    this.baseUrl = config.baseUrl ?? runtime.ttc.apiBaseUrl;
+    this.apiKey = config.apiKey ?? runtime.ttc.apiKey;
+    this.timeoutMs = config.timeoutMs ?? runtime.ttc.httpTimeoutMs;
+    this.xuToVndRate = config.xuToVndRate ?? runtime.ttc.xuToVndRate ?? "";
+    this.rateInputUnit = config.rateInputUnit ?? runtime.ttc.rateInputUnit ?? 0;
+    this.rateUnit = config.rateUnit ?? runtime.ttc.rateUnit;
   }
 
   private endpoint(): URL {
diff --git a/packages/providers/src/config.ts b/packages/providers/src/config.ts
new file mode 100644
index 0000000000000000000000000000000000000000..ee578c3b71a0a2c4240b8a1af313a89a021152b8
--- /dev/null
+++ b/packages/providers/src/config.ts
@@ -0,0 +1,154 @@
+import { ProviderAdapterError } from "./errors";
+
+const DEFAULT_TTC_API_URL = "https://tuongtaccheo.com/api/v2";
+const TTC_ALLOWED_HOSTS = new Set(["tuongtaccheo.com", "www.tuongtaccheo.com"]);
+
+export type Environment = Record<string, string | undefined>;
+
+export interface ProviderRuntimeConfig {
+  routingEnabled: boolean;
+  workerId?: string;
+  workerPollMs: number;
+  jobBatchSize: number;
+  jobLockTimeoutMs: number;
+  maxAttempts: number;
+  pollInitialMs: number;
+  pollMaxMs: number;
+  ttc: {
+    apiBaseUrl: string;
+    apiKey: string;
+    httpTimeoutMs: number;
+    xuToVndRate?: string;
+    rateUnit: number;
+    rateInputUnit?: number;
+  };
+}
+
+function configurationError(variable: string, requirement: string): ProviderAdapterError {
+  return new ProviderAdapterError(
+    "PROVIDER_CONFIGURATION_MISSING",
+    `${variable} ${requirement}.`
+  );
+}
+
+function parseBoolean(env: Environment, variable: string, fallback: boolean): boolean {
+  const value = env[variable];
+  if (value === undefined || value === "") return fallback;
+  if (value === "true") return true;
+  if (value === "false") return false;
+  throw configurationError(variable, "must be exactly true or false");
+}
+
+function parseInteger(
+  env: Environment,
+  variable: string,
+  fallback: number | undefined,
+  limits: { min: number; max: number }
+): number | undefined {
+  const value = env[variable];
+  if (value === undefined || value === "") return fallback;
+  if (!/^(0|[1-9]\d*)$/.test(value)) {
+    throw configurationError(variable, "must be an unsigned base-10 integer without spaces");
+  }
+  const parsed = Number(value);
+  if (!Number.isSafeInteger(parsed) || parsed < limits.min || parsed > limits.max) {
+    throw configurationError(variable, `must be between ${limits.min} and ${limits.max}`);
+  }
+  return parsed;
+}
+
+function parsePositiveDecimal(env: Environment, variable: string): string | undefined {
+  const value = env[variable];
+  if (value === undefined || value === "") return undefined;
+  if (!/^\d+(?:\.\d+)?$/.test(value)) {
+    throw configurationError(variable, "must be a positive decimal without signs, exponent notation or spaces");
+  }
+  const [whole, fraction = ""] = value.split(".");
+  if (BigInt(`${whole}${fraction}`) <= 0n) {
+    throw configurationError(variable, "must be greater than zero");
+  }
+  return value;
+}
+
+function parseWorkerId(env: Environment): string | undefined {
+  const value = env.PROVIDER_WORKER_ID;
+  if (value === undefined || value === "") return undefined;
+  if (value !== value.trim() || value.length > 120 || /[\r\n\0]/.test(value)) {
+    throw configurationError("PROVIDER_WORKER_ID", "must be 1-120 trimmed printable characters");
+  }
+  return value;
+}
+
+export function validateTtcApiBaseUrl(value: string): string {
+  let url: URL;
+  try {
+    url = new URL(value);
+  } catch {
+    throw configurationError("TTC_API_BASE_URL", "must be a valid URL");
+  }
+  if (url.protocol !== "https:" || !TTC_ALLOWED_HOSTS.has(url.hostname)) {
+    throw configurationError("TTC_API_BASE_URL", "must use an allowlisted tuongtaccheo.com HTTPS host");
+  }
+  if (url.username || url.password || url.search || url.hash) {
+    throw configurationError("TTC_API_BASE_URL", "must not contain credentials, query parameters or fragments");
+  }
+  return url.toString().replace(/\/$/, "");
+}
+
+export function parseProviderRuntimeConfig(env: Environment = process.env): ProviderRuntimeConfig {
+  const routingEnabled = parseBoolean(env, "PROVIDER_ROUTING_ENABLED", false);
+  const workerPollMs = parseInteger(env, "PROVIDER_WORKER_POLL_MS", 1_000, { min: 250, max: 60_000 })!;
+  const jobBatchSize = parseInteger(env, "PROVIDER_JOB_BATCH_SIZE", 10, { min: 1, max: 100 })!;
+  const jobLockTimeoutMs = parseInteger(env, "PROVIDER_JOB_LOCK_TIMEOUT_MS", 300_000, { min: 1, max: 3_600_000 })!;
+  const maxAttempts = parseInteger(env, "PROVIDER_MAX_ATTEMPTS", 6, { min: 1, max: 100 })!;
+  const pollInitialMs = parseInteger(env, "PROVIDER_POLL_INITIAL_MS", 60_000, { min: 1, max: 86_400_000 })!;
+  const pollMaxMs = parseInteger(env, "PROVIDER_POLL_MAX_MS", 1_200_000, { min: 1, max: 86_400_000 })!;
+  const httpTimeoutMs = parseInteger(env, "TTC_HTTP_TIMEOUT_MS", 10_000, { min: 500, max: 120_000 })!;
+  const rateUnit = parseInteger(env, "TTC_RATE_UNIT", 1_000, { min: 1, max: Number.MAX_SAFE_INTEGER })!;
+  const rateInputUnit = parseInteger(env, "TTC_RATE_INPUT_UNIT", undefined, { min: 1, max: Number.MAX_SAFE_INTEGER });
+  const xuToVndRate = parsePositiveDecimal(env, "TTC_XU_TO_VND_RATE");
+  const apiKey = env.TTC_API_KEY ?? "";
+
+  if (apiKey !== apiKey.trim() || /[\r\n\0]/.test(apiKey)) {
+    throw configurationError("TTC_API_KEY", "must not contain surrounding whitespace or control characters");
+  }
+  if (pollInitialMs > pollMaxMs) {
+    throw configurationError("PROVIDER_POLL_INITIAL_MS", "must be less than or equal to PROVIDER_POLL_MAX_MS");
+  }
+  // A stale job must not be reclaimed while its one provider HTTP request can still be in flight.
+  if (jobLockTimeoutMs <= httpTimeoutMs) {
+    throw configurationError("PROVIDER_JOB_LOCK_TIMEOUT_MS", "must be greater than TTC_HTTP_TIMEOUT_MS");
+  }
+  if (routingEnabled && !apiKey) {
+    throw configurationError("TTC_API_KEY", "is required when PROVIDER_ROUTING_ENABLED=true");
+  }
+  if (routingEnabled && !xuToVndRate) {
+    throw configurationError("TTC_XU_TO_VND_RATE", "is required when PROVIDER_ROUTING_ENABLED=true");
+  }
+  if (routingEnabled && rateInputUnit === undefined) {
+    throw configurationError("TTC_RATE_INPUT_UNIT", "is required when PROVIDER_ROUTING_ENABLED=true");
+  }
+
+  return {
+    routingEnabled,
+    workerId: parseWorkerId(env),
+    workerPollMs,
+    jobBatchSize,
+    jobLockTimeoutMs,
+    maxAttempts,
+    pollInitialMs,
+    pollMaxMs,
+    ttc: {
+      apiBaseUrl: validateTtcApiBaseUrl(env.TTC_API_BASE_URL ?? DEFAULT_TTC_API_URL),
+      apiKey,
+      httpTimeoutMs,
+      xuToVndRate,
+      rateUnit,
+      rateInputUnit
+    }
+  };
+}
+
+export function isProviderRoutingEnabled(env: Environment = process.env): boolean {
+  return parseProviderRuntimeConfig(env).routingEnabled;
+}
diff --git a/packages/providers/src/index.ts b/packages/providers/src/index.ts
index 0c449605d4750ed0320603c9d144bb97249615bb..c4de870739d05ce372633a1236d46057c21fdd99 100644
--- a/packages/providers/src/index.ts
+++ b/packages/providers/src/index.ts
@@ -5,4 +5,5 @@ export * from "./pricing";
 export * from "./retry";
 export * from "./registry";
 export * from "./http";
+export * from "./config";
 export * from "./adapters/ttc-provider-adapter";
diff --git a/packages/providers/tests/provider-config.test.ts b/packages/providers/tests/provider-config.test.ts
new file mode 100644
index 0000000000000000000000000000000000000000..b86da4acf09a65386f2b9d93c20dab3e914c1d8a
--- /dev/null
+++ b/packages/providers/tests/provider-config.test.ts
@@ -0,0 +1,101 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+import { ProviderAdapterError, parseProviderRuntimeConfig } from "../src/index";
+
+const enabledEnvironment = {
+  PROVIDER_ROUTING_ENABLED: "true",
+  TTC_API_KEY: "test-key",
+  TTC_XU_TO_VND_RATE: "0.0175",
+  TTC_RATE_INPUT_UNIT: "1",
+  TTC_RATE_UNIT: "1000"
+} as const;
+
+function assertConfigurationError(operation: () => unknown, variable: string) {
+  assert.throws(operation, (error: unknown) => {
+    if (!(error instanceof ProviderAdapterError)) return false;
+    assert.equal(error.code, "PROVIDER_CONFIGURATION_MISSING");
+    assert.match(error.message, new RegExp(`^${variable} `));
+    assert.equal(error.message.includes("test-key"), false);
+    return true;
+  });
+}
+
+test("routing disabled allows TTC credentials and conversion to be absent", () => {
+  const config = parseProviderRuntimeConfig({ PROVIDER_ROUTING_ENABLED: "false" });
+  assert.equal(config.routingEnabled, false);
+  assert.equal(config.ttc.apiKey, "");
+  assert.equal(config.ttc.xuToVndRate, undefined);
+});
+
+test("routing enabled rejects a missing TTC API key", () => {
+  const { TTC_API_KEY: _removed, ...environment } = enabledEnvironment;
+  assertConfigurationError(() => parseProviderRuntimeConfig(environment), "TTC_API_KEY");
+});
+
+test("routing enabled rejects a missing TTC conversion", () => {
+  const { TTC_XU_TO_VND_RATE: _removed, ...environment } = enabledEnvironment;
+  assertConfigurationError(() => parseProviderRuntimeConfig(environment), "TTC_XU_TO_VND_RATE");
+});
+
+test("TTC conversion must be a strict positive decimal", () => {
+  for (const value of ["0", "-1", "+1", "1e3", " 1", "1 "]) {
+    assertConfigurationError(
+      () => parseProviderRuntimeConfig({ ...enabledEnvironment, TTC_XU_TO_VND_RATE: value }),
+      "TTC_XU_TO_VND_RATE"
+    );
+  }
+});
+
+test("TTC HTTP timeout is strictly parsed and bounded", () => {
+  for (const value of ["0", "499", "120001", "1000ms", " 1000"]) {
+    assertConfigurationError(
+      () => parseProviderRuntimeConfig({ ...enabledEnvironment, TTC_HTTP_TIMEOUT_MS: value }),
+      "TTC_HTTP_TIMEOUT_MS"
+    );
+  }
+});
+
+test("TTC rate units must be positive integers", () => {
+  for (const variable of ["TTC_RATE_UNIT", "TTC_RATE_INPUT_UNIT"] as const) {
+    for (const value of ["0", "-1", "1.5", "1e3"]) {
+      assertConfigurationError(
+        () => parseProviderRuntimeConfig({ ...enabledEnvironment, [variable]: value }),
+        variable
+      );
+    }
+  }
+});
+
+test("worker timing rejects a lock that can expire during the TTC HTTP timeout", () => {
+  assertConfigurationError(
+    () => parseProviderRuntimeConfig({
+      ...enabledEnvironment,
+      TTC_HTTP_TIMEOUT_MS: "10000",
+      PROVIDER_JOB_LOCK_TIMEOUT_MS: "10000"
+    }),
+    "PROVIDER_JOB_LOCK_TIMEOUT_MS"
+  );
+});
+
+test("worker polling and retry controls reject malformed or unsafe values", () => {
+  assertConfigurationError(
+    () => parseProviderRuntimeConfig({ ...enabledEnvironment, PROVIDER_WORKER_POLL_MS: "0" }),
+    "PROVIDER_WORKER_POLL_MS"
+  );
+  assertConfigurationError(
+    () => parseProviderRuntimeConfig({ ...enabledEnvironment, PROVIDER_JOB_BATCH_SIZE: "1.5" }),
+    "PROVIDER_JOB_BATCH_SIZE"
+  );
+  assertConfigurationError(
+    () => parseProviderRuntimeConfig({ ...enabledEnvironment, PROVIDER_MAX_ATTEMPTS: "0" }),
+    "PROVIDER_MAX_ATTEMPTS"
+  );
+  assertConfigurationError(
+    () => parseProviderRuntimeConfig({
+      ...enabledEnvironment,
+      PROVIDER_POLL_INITIAL_MS: "2000",
+      PROVIDER_POLL_MAX_MS: "1000"
+    }),
+    "PROVIDER_POLL_INITIAL_MS"
+  );
+});
diff --git a/qa/work6-provider-contract-check.mjs b/qa/work6-provider-contract-check.mjs
index b4ba9db35389fad975396a503eb62b7cfe4f7a81..dfbe3b36d3aa91ccf21caca0050b710fd50d798b 100644
--- a/qa/work6-provider-contract-check.mjs
+++ b/qa/work6-provider-contract-check.mjs
@@ -19,7 +19,7 @@ for (const marker of ["refundedMinor", "providerRateSnapshotMinor", "providerCos
 
 for (const path of [
   "packages/providers/src/contracts.ts", "packages/providers/src/errors.ts", "packages/providers/src/pricing.ts", "packages/providers/src/retry.ts",
-  "packages/providers/src/sanitize.ts", "packages/providers/src/http.ts", "packages/providers/src/registry.ts", "packages/providers/src/adapters/ttc-provider-adapter.ts",
+  "packages/providers/src/sanitize.ts", "packages/providers/src/http.ts", "packages/providers/src/registry.ts", "packages/providers/src/config.ts", "packages/providers/src/adapters/ttc-provider-adapter.ts",
   "apps/worker/src/queue.ts", "apps/worker/src/rate-limit.ts", "apps/worker/src/provider-worker.ts", "apps/worker/src/index.ts", "packages/domain/src/provider-domain.ts"
 ]) required(path);
 
@@ -28,15 +28,21 @@ for (const method of ["testConnection()", "getBalance()", "getServices()", "crea
   assert(contract.includes(method), `ProviderAdapter missing ${method}`);
 }
 const ttc = read("packages/providers/src/adapters/ttc-provider-adapter.ts");
-assert(ttc.includes("https://tuongtaccheo.com/api/v2"), "Verified TTC API v2 base URL is missing");
 assert(ttc.includes('Content-Type": "application/x-www-form-urlencoded"'), "TTC adapter must use documented form-urlencoded requests");
 for (const action of ['"services"', '"add"', '"status"', '"cancel"', '"balance"']) {
   assert(ttc.includes(action), `TTC adapter missing documented action ${action}`);
 }
 assert(ttc.includes("providerFetch"), "TTC adapter must use the hardened provider HTTP boundary");
-assert(ttc.includes("TTC_XU_TO_VND_RATE"), "TTC provider price conversion guard is missing");
+assert(ttc.includes("parseProviderRuntimeConfig"), "TTC adapter must use centralized provider configuration");
 assert(ttc.includes("supportsCreateIdempotency: false"), "TTC create idempotency must remain false because the documented API has no idempotency/reference field");
 
+const providerConfig = read("packages/providers/src/config.ts");
+assert(providerConfig.includes("https://tuongtaccheo.com/api/v2"), "Verified TTC API v2 base URL is missing");
+for (const key of ["PROVIDER_ROUTING_ENABLED", "PROVIDER_JOB_LOCK_TIMEOUT_MS", "PROVIDER_POLL_INITIAL_MS", "PROVIDER_POLL_MAX_MS", "TTC_HTTP_TIMEOUT_MS", "TTC_XU_TO_VND_RATE", "TTC_RATE_UNIT", "TTC_RATE_INPUT_UNIT"]) {
+  assert(providerConfig.includes(key), `Centralized provider configuration is missing ${key}`);
+}
+assert(providerConfig.includes("jobLockTimeoutMs <= httpTimeoutMs"), "Provider configuration must prevent reclaiming a job during a provider HTTP request");
+
 const queue = read("apps/worker/src/queue.ts");
 assert(queue.includes("providerJob.findMany") && queue.includes("providerJob.updateMany"), "Worker queue must be PostgreSQL-backed and claim jobs conditionally");
 assert(queue.includes("lockedAt") && queue.includes("RETRY"), "Durable queue lock/retry policy missing");
@@ -49,7 +55,7 @@ const limiter = read("apps/worker/src/rate-limit.ts");
 assert(limiter.includes("providerRequestLease") && limiter.includes("maxConcurrentRequests") && limiter.includes("minRequestIntervalMs"), "Centralized provider outbound concurrency/rate limiting is missing");
 
 const customerDomain = read("packages/domain/src/customer-domain.ts");
-assert(customerDomain.includes("PROVIDER_ROUTING_ENABLED") && customerDomain.includes("serviceProviderMapping.findFirst"), "Customer order admission must require a routable mapping when provider routing is enabled");
+assert(customerDomain.includes("isProviderRoutingEnabled") && customerDomain.includes("serviceProviderMapping.findFirst"), "Customer order admission must require a routable mapping when provider routing is enabled");
 assert(customerDomain.includes("enqueueOrderSubmissionIfEnabled"), "Customer order transaction must enqueue durable provider submission work");
 const customerQueries = read("apps/web/src/server/customer-queries.ts");
 assert(customerQueries.includes("providerRoutableServiceWhere"), "Customer catalog must filter to routable services when provider routing is enabled");
WORK07_1_PATCH

printf '\nChecking patch applicability...\n'
git apply --check "$PATCH_FILE"
printf '[PASS] git apply --check\n'

git apply --3way "$PATCH_FILE"
# --3way updates the index; leave the delivered changes unstaged for review.
git restore --staged -- .
printf '[PASS] git apply --3way\n'

if command -v npm >/dev/null 2>&1 && [[ -d node_modules ]]; then
  run_check "Prisma schema validation" npm run db:validate
  run_check "Provider typecheck" npm run typecheck:providers
  run_check "Worker typecheck" npm run typecheck:worker
  run_check "Provider tests" npm run test:providers
  run_check "Development-seed configuration tests" npm run test:db-config
  run_check "Work 06 static provider contract" npm run qa:work6:static
  run_check "Web lint" npm run lint:web
  run_check "Web typecheck" npm run typecheck:web
  run_check "Web production build" npm run build:web
else
  printf '\n[BLOCKED] Node validations: npm and installed dependencies (node_modules) are required. Run npm ci, then execute the validation commands listed in this script.\n'
fi

if [[ -n "${TEST_DATABASE_URL:-}" && -d node_modules ]]; then
  run_check "Backend PostgreSQL integration tests" npm run test:backend
  run_check "Worker PostgreSQL integration tests" npm run test:worker
else
  printf '[BLOCKED] PostgreSQL integration tests: TEST_DATABASE_URL is not configured in the script environment.\n'
fi

printf '[SKIPPED] Live TTC checks: intentionally not run; no provider order will be submitted.\n'

# Validation can update these tracked framework-generated files; they are not part of Work 07.1.
git restore --worktree -- apps/web/next-env.d.ts apps/web/tsconfig.tsbuildinfo

printf '\n========================================\n'
printf 'WORK 07.1 APPLIED SUCCESSFULLY\n'
printf '========================================\n\n'
git status --short
git diff --stat

printf '\nSuggested commands only (not executed):\n'
printf '%s\n' 'git diff'
if [[ -n "$SCRIPT_RELATIVE" && "$(git status --porcelain --untracked-files=all -- "$SCRIPT_RELATIVE")" == "?? $SCRIPT_RELATIVE" ]]; then
  printf 'git add -A -- . ":(exclude)%s"\n' "$SCRIPT_RELATIVE"
else
  printf '%s\n' 'git add .'
fi
printf '%s\n' 'git commit -m "work(07): harden provider configuration"'
printf '%s\n' 'git push'
