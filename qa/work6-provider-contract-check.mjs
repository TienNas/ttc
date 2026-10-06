import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const required = (path) => assert(existsSync(join(root, path)), `Missing Work 06 file: ${path}`);

const schemaPath = "packages/db/prisma/schema.prisma";
const migrationPath = "packages/db/prisma/migrations/202609160003_work6_provider/migration.sql";
required(schemaPath); required(migrationPath);
const schema = read(schemaPath);
for (const model of ["Provider", "ProviderService", "ServiceProviderMapping", "ProviderPriceHistory", "ProviderOrder", "ProviderOrderAttempt", "ProviderJob", "ProviderOperationLog", "ProviderBalanceSnapshot", "ProviderRequestLease"]) {
  assert(schema.includes(`model ${model} {`), `Missing Prisma model ${model}`);
}
for (const marker of ["refundedMinor", "providerRateSnapshotMinor", "providerCostMinor", "customerChargeMinor", "grossMarginMinor", "UNKNOWN_SUBMISSION", "PRICE_REVIEW_REQUIRED"]) {
  assert(schema.includes(marker), `Missing Work 06 schema marker ${marker}`);
}

for (const path of [
  "packages/providers/src/contracts.ts", "packages/providers/src/errors.ts", "packages/providers/src/pricing.ts", "packages/providers/src/retry.ts",
  "packages/providers/src/sanitize.ts", "packages/providers/src/http.ts", "packages/providers/src/registry.ts", "packages/providers/src/config.ts", "packages/providers/src/adapters/ttc-provider-adapter.ts",
  "apps/worker/src/queue.ts", "apps/worker/src/rate-limit.ts", "apps/worker/src/provider-worker.ts", "apps/worker/src/index.ts", "packages/domain/src/provider-domain.ts"
]) required(path);

const contract = read("packages/providers/src/contracts.ts");
for (const method of ["testConnection()", "getBalance()", "getServices()", "createOrder(input", "getOrderStatus(input", "cancelOrder?", "refillOrder?"]) {
  assert(contract.includes(method), `ProviderAdapter missing ${method}`);
}
const ttc = read("packages/providers/src/adapters/ttc-provider-adapter.ts");
assert(ttc.includes('Content-Type": "application/x-www-form-urlencoded"'), "TTC adapter must use documented form-urlencoded requests");
for (const action of ['"services"', '"add"', '"status"', '"cancel"', '"balance"']) {
  assert(ttc.includes(action), `TTC adapter missing documented action ${action}`);
}
assert(ttc.includes("providerFetch"), "TTC adapter must use the hardened provider HTTP boundary");
assert(ttc.includes("parseProviderRuntimeConfig"), "TTC adapter must use centralized provider configuration");
assert(ttc.includes("supportsCreateIdempotency: false"), "TTC create idempotency must remain false because the documented API has no idempotency/reference field");

const providerConfig = read("packages/providers/src/config.ts");
assert(providerConfig.includes("https://tuongtaccheo.com/api/v2"), "Verified TTC API v2 base URL is missing");
for (const key of ["PROVIDER_ROUTING_ENABLED", "PROVIDER_JOB_LOCK_TIMEOUT_MS", "PROVIDER_POLL_INITIAL_MS", "PROVIDER_POLL_MAX_MS", "TTC_HTTP_TIMEOUT_MS", "TTC_XU_TO_VND_RATE", "TTC_RATE_UNIT", "TTC_RATE_INPUT_UNIT"]) {
  assert(providerConfig.includes(key), `Centralized provider configuration is missing ${key}`);
}
assert(providerConfig.includes("jobLockTimeoutMs <= httpTimeoutMs"), "Provider configuration must prevent reclaiming a job during a provider HTTP request");

const queue = read("apps/worker/src/queue.ts");
assert(queue.includes("providerJob.findMany") && queue.includes("providerJob.updateMany"), "Worker queue must be PostgreSQL-backed and claim jobs conditionally");
assert(queue.includes("lockedAt") && queue.includes("RETRY"), "Durable queue lock/retry policy missing");
const worker = read("apps/worker/src/provider-worker.ts");
for (const marker of ["UNKNOWN_SUBMISSION", "PRICE_REVIEW_REQUIRED", "calculateProviderCost", "refundProviderOrderToTarget", "POLL_ORDER_STATUS", "sanitizeProviderValue"]) {
  assert(worker.includes(marker), `Provider worker missing ${marker}`);
}
assert(!worker.includes("setInterval("), "Provider worker must not depend on in-memory interval scheduling");
const limiter = read("apps/worker/src/rate-limit.ts");
assert(limiter.includes("providerRequestLease") && limiter.includes("maxConcurrentRequests") && limiter.includes("minRequestIntervalMs"), "Centralized provider outbound concurrency/rate limiting is missing");

const customerDomain = read("packages/domain/src/customer-domain.ts");
assert(customerDomain.includes("isProviderRoutingEnabled") && customerDomain.includes("serviceProviderMapping.findFirst"), "Customer order admission must require a routable mapping when provider routing is enabled");
assert(customerDomain.includes("enqueueOrderSubmissionIfEnabled"), "Customer order transaction must enqueue durable provider submission work");
const customerQueries = read("apps/web/src/server/customer-queries.ts");
assert(customerQueries.includes("providerRoutableServiceWhere"), "Customer catalog must filter to routable services when provider routing is enabled");

const adminRoutes = [
  "apps/web/src/app/api/v1/admin/providers/route.ts",
  "apps/web/src/app/api/v1/admin/providers/[id]/route.ts",
  "apps/web/src/app/api/v1/admin/providers/[id]/actions/route.ts",
  "apps/web/src/app/api/v1/admin/provider-mappings/route.ts",
  "apps/web/src/app/api/v1/admin/provider-mappings/[id]/disable/route.ts",
  "apps/web/src/app/api/v1/admin/provider-jobs/route.ts"
];
for (const route of adminRoutes) {
  required(route);
  const source = read(route);
  assert(source.includes("requireAdmin"), `Provider admin route missing requireAdmin: ${route}`);
  if (/export async function (POST|PATCH)/.test(source)) assert(source.includes("requireSameOrigin"), `Provider mutation missing same-origin guard: ${route}`);
}
required("apps/web/src/app/admin/providers/page.tsx");
required("apps/web/src/app/admin/providers/[id]/page.tsx");
const providerPages = read("apps/web/src/app/admin/providers/page.tsx") + read("apps/web/src/app/admin/providers/[id]/page.tsx");
assert(!/TTC_API_KEY|Authorization\s*:/i.test(providerPages), "Provider secret leaked into Admin client page");
assert(!/fetch\s*\(|axios/i.test(providerPages), "Admin provider UI must use internal repository/service, not direct provider HTTP");

const adminQuery = read("apps/web/src/server/admin-queries.ts");
assert(adminQuery.includes("credentialConfigured") && !adminQuery.includes("apiKey:"), "Admin provider read model must return configuration indicator, not raw secret");
const env = read(".env.example");
for (const key of ["PROVIDER_ROUTING_ENABLED", "PROVIDER_MAX_ATTEMPTS", "PROVIDER_POLL_INITIAL_MS", "TTC_API_BASE_URL", "TTC_API_KEY", "TTC_XU_TO_VND_RATE", "TTC_RATE_UNIT"]) assert(env.includes(`${key}=`), `Missing ${key} in .env.example`);
assert(!env.includes("NEXT_PUBLIC_TTC"), "Provider secret must never be NEXT_PUBLIC");

for (const testFile of ["packages/providers/tests/provider-core.test.ts", "apps/web/tests/backend/work6.provider.integration.test.ts", "apps/worker/tests/provider-worker.integration.test.ts"]) required(testFile);
for (const doc of ["WORK6_PROVIDER.md", "PROVIDER_ADAPTER.md", "PROVIDER_PRICING.md", "PROVIDER_WORKERS.md", "TTC_INTEGRATION.md", "TTC_INTEGRATION_GAPS.md", "WORK6_QA_REPORT.md"]) required(doc);

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry); const full = join(root, rel);
    if (statSync(full).isDirectory()) out.push(...collect(rel));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry)) out.push(rel);
  }
  return out;
}
const runtimeProviderCode = [...collect("packages/providers/src"), ...collect("apps/worker/src")].map(read).join("\n");
assert(!runtimeProviderCode.includes("NEXT_PUBLIC_TTC"), "TTC credential must never be exposed as NEXT_PUBLIC");
assert(!/logintoken\.php/i.test(runtimeProviderCode), "Order provider adapter must not confuse TTC Access_token tool login with API v2 order API");
required("qa/ttc-live-readonly.mjs");
required("qa/ttc-live-order.mjs");
const liveOrder = read("qa/ttc-live-order.mjs");
assert(liveOrder.includes('YES_I_UNDERSTAND'), "Live TTC order smoke must require an explicit destructive opt-in");

console.log(`Work 06 provider contract passed: ${adminRoutes.length} admin provider API routes, durable PostgreSQL jobs, verified TTC API v2 adapter, routing safety and live-test guards.`);
