import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  OrderStatus,
  ProviderHealth,
  ProviderJobStatus,
  ProviderJobType,
  ProviderMappingStatus,
  ProviderOrderStatus,
  ProviderServiceStatus,
  ProviderStatus,
  ServiceStatus,
  SocialPlatform,
  UserRole,
  UserStatus,
  WalletTransactionType,
  disconnectDb,
  getDb
} from "@tuong-tac-pro/db";
import {
  ProviderAdapterError,
  ProviderRegistry,
  type NormalizedProviderService,
  type ProviderAdapter,
  type ProviderBalanceResult,
  type ProviderConnectionResult,
  type ProviderCreateOrderInput,
  type ProviderCreateOrderResult,
  type ProviderOrderStatusInput,
  type ProviderOrderStatusResult
} from "@tuong-tac-pro/providers";
import { claimDueProviderJobs } from "../src/queue";
import { processProviderJob } from "../src/provider-worker";

const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for Work 06 worker tests.");
process.env.DATABASE_URL = testDatabaseUrl;
process.env.PROVIDER_POLL_INITIAL_MS = "1";

class FakeAdapter implements ProviderAdapter {
  readonly code = "FAKE6";
  readonly capabilities = {
    supportsCreateIdempotency: false,
    supportsClientReference: true,
    supportsLookupByClientReference: false,
    supportsCancel: false,
    supportsRefill: false,
    supportsBalance: true,
    supportsServiceSync: true
  };
  createCalls = 0;
  statusCalls = 0;
  createMode: "ACCEPT" | "REJECT" | "AMBIGUOUS" = "ACCEPT";
  nextStatus: ProviderOrderStatusResult = { status: "PROCESSING" };

  async testConnection(): Promise<ProviderConnectionResult> { return { ok: true, latencyMs: 1 }; }
  async getBalance(): Promise<ProviderBalanceResult> { return { amountMinor: 999_000n, currency: "VND" }; }
  async getServices(): Promise<NormalizedProviderService[]> { return []; }
  async createOrder(_input: ProviderCreateOrderInput): Promise<ProviderCreateOrderResult> {
    this.createCalls += 1;
    if (this.createMode === "AMBIGUOUS") {
      throw new ProviderAdapterError("PROVIDER_TIMEOUT", "timeout after send", { retryable: true, ambiguousSideEffect: true });
    }
    if (this.createMode === "REJECT") {
      return { outcome: "REJECTED", code: "PROVIDER_INVALID_REQUEST", message: "provider rejected before acceptance", retryable: false };
    }
    return { outcome: "ACCEPTED", externalOrderId: "fake-order-1", status: "SUBMITTED", raw: { order: "fake-order-1" } };
  }
  async getOrderStatus(_input: ProviderOrderStatusInput): Promise<ProviderOrderStatusResult> {
    this.statusCalls += 1;
    return this.nextStatus;
  }
}

async function reset() {
  const db = getDb();
  await db.providerRequestLease.deleteMany();
  await db.providerJob.deleteMany();
  await db.providerOperationLog.deleteMany();
  await db.providerOrderAttempt.deleteMany();
  await db.providerOrder.deleteMany();
  await db.providerBalanceSnapshot.deleteMany();
  await db.serviceProviderMapping.deleteMany();
  await db.providerPriceHistory.deleteMany();
  await db.providerService.deleteMany();
  await db.provider.deleteMany();
  await db.walletTransaction.deleteMany();
  await db.walletReservation.deleteMany();
  await db.orderLog.deleteMany();
  await db.order.deleteMany();
  await db.orderQuote.deleteMany();
  await db.wallet.deleteMany();
  await db.user.deleteMany();
  await db.service.deleteMany();
  await db.serviceCategory.deleteMany();

  await db.serviceCategory.create({ data: { id: "worker-cat", name: "Worker", enabled: true } });
  await db.service.create({
    data: { id: "worker-service", code: "WORKER-SVC", name: "Worker Service", description: "Worker test", platform: SocialPlatform.FACEBOOK, categoryId: "worker-cat", ratePerThousandMinor: 20_000n, min: 100, max: 10_000, averageTime: "0-24h", status: ServiceStatus.ACTIVE }
  });
}

async function seedOrder(publicId: string) {
  const db = getDb();
  const customer = await db.user.create({ data: { email: `${publicId.toLowerCase()}@example.com`, passwordHash: "test", name: "Worker Customer", role: UserRole.CUSTOMER, status: UserStatus.ACTIVE } });
  const wallet = await db.wallet.create({ data: { userId: customer.id, balanceMinor: 1_000_000n, reservedMinor: 20_000n, currency: "VND" } });
  const provider = await db.provider.create({ data: { code: "FAKE6", name: "Fake Test Provider", status: ProviderStatus.ACTIVE, health: ProviderHealth.HEALTHY, enabled: true, priority: 1, minRequestIntervalMs: 0, maxConcurrentRequests: 1 } });
  const providerService = await db.providerService.create({
    data: { providerId: provider.id, externalServiceId: "fake-service-1", name: "Fake Service", platform: SocialPlatform.FACEBOOK, providerRateMinor: 10_000n, rateUnit: 1000, currency: "VND", min: 100, max: 10_000, status: ProviderServiceStatus.AVAILABLE, lastSyncedAt: new Date() }
  });
  await db.serviceProviderMapping.create({
    data: { serviceId: "worker-service", providerServiceId: providerService.id, enabled: true, priority: 1, status: ProviderMappingStatus.ACTIVE, minimumMarginMinor: 0n }
  });
  const order = await db.order.create({
    data: { publicId, userId: customer.id, serviceId: "worker-service", targetUrl: "https://example.com/worker-target", quantity: 1000, chargeMinor: 20_000n, remaining: 1000, status: OrderStatus.PENDING, idempotencyKey: `idem-${publicId}`, requestFingerprint: `fp-${publicId}` }
  });
  await db.walletReservation.create({ data: { walletId: wallet.id, orderId: order.id, amountMinor: 20_000n } });
  const submitJob = await db.providerJob.create({ data: { type: ProviderJobType.SUBMIT_ORDER, status: ProviderJobStatus.PENDING, dedupeKey: `submit:${order.id}`, orderId: order.id, runAt: new Date(0) } });
  return { customer, wallet, provider, providerService, order, submitJob };
}

beforeEach(reset);
after(async () => { await disconnectDb(); });

function registryFor(adapter: ProviderAdapter): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(adapter);
  return registry;
}

async function claimOne() {
  const jobs = await claimDueProviderJobs("work6-test-worker", 10);
  assert.ok(jobs.length >= 1);
  return jobs[0]!;
}

test("worker snapshots economics, stores external order id and does not duplicate accepted create", async () => {
  const fixture = await seedOrder("TT-W6-WORKER-1");
  const adapter = new FakeAdapter();
  const registry = registryFor(adapter);
  await processProviderJob(await claimOne(), registry);

  const providerOrder = await getDb().providerOrder.findUniqueOrThrow({ where: { orderId: fixture.order.id } });
  assert.equal(providerOrder.externalOrderId, "fake-order-1");
  assert.equal(providerOrder.status, ProviderOrderStatus.SUBMITTED);
  assert.equal(providerOrder.providerCostMinor, 10_000n);
  assert.equal(providerOrder.customerChargeMinor, 20_000n);
  assert.equal(providerOrder.grossMarginMinor, 10_000n);
  assert.equal((await getDb().order.findUniqueOrThrow({ where: { id: fixture.order.id } })).status, OrderStatus.SUBMITTED);
  const capturedWallet = await getDb().wallet.findUniqueOrThrow({ where: { id: fixture.wallet.id } });
  assert.equal(capturedWallet.balanceMinor, 980_000n);
  assert.equal(capturedWallet.reservedMinor, 0n);
  assert.equal(await getDb().walletTransaction.count({ where: { walletId: fixture.wallet.id, type: WalletTransactionType.PURCHASE } }), 1);
  assert.equal(adapter.createCalls, 1);

  await getDb().providerJob.create({ data: { type: ProviderJobType.SUBMIT_ORDER, status: ProviderJobStatus.PENDING, dedupeKey: `submit-replay:${fixture.order.id}`, orderId: fixture.order.id, runAt: new Date(0) } });
  const replay = (await claimDueProviderJobs("work6-test-worker", 10)).find((job) => job.type === ProviderJobType.SUBMIT_ORDER);
  assert.ok(replay);
  await processProviderJob(replay, registry);
  assert.equal(adapter.createCalls, 1, "accepted provider order must never be created again");
  assert.equal(await getDb().providerOrder.count({ where: { orderId: fixture.order.id } }), 1);
  assert.equal(await getDb().walletTransaction.count({ where: { walletId: fixture.wallet.id, type: WalletTransactionType.PURCHASE } }), 1);
});

test("ambiguous create without provider idempotency stops in manual review without refund or blind retry", async () => {
  const fixture = await seedOrder("TT-W6-UNKNOWN-1");
  const adapter = new FakeAdapter();
  adapter.createMode = "AMBIGUOUS";
  const job = await claimOne();
  await processProviderJob(job, registryFor(adapter));

  const latestJob = await getDb().providerJob.findUniqueOrThrow({ where: { id: job.id } });
  const providerOrder = await getDb().providerOrder.findUniqueOrThrow({ where: { orderId: fixture.order.id } });
  assert.equal(latestJob.status, ProviderJobStatus.MANUAL_REVIEW);
  assert.equal(providerOrder.status, ProviderOrderStatus.UNKNOWN);
  assert.equal(providerOrder.submissionState, "UNKNOWN_SUBMISSION");
  assert.equal(adapter.createCalls, 1);
  const wallet = await getDb().wallet.findUniqueOrThrow({ where: { id: fixture.wallet.id } });
  assert.equal(wallet.balanceMinor, 1_000_000n);
  assert.equal(wallet.reservedMinor, 20_000n);
  assert.equal(await getDb().walletTransaction.count({ where: { walletId: fixture.wallet.id, type: WalletTransactionType.PURCHASE } }), 0);
  assert.equal(await getDb().walletTransaction.count({ where: { walletId: fixture.wallet.id, type: WalletTransactionType.REFUND } }), 0);
});

test("explicit provider rejection releases reservation exactly once without purchase", async () => {
  const fixture = await seedOrder("TT-W7-REJECT-1");
  const adapter = new FakeAdapter();
  adapter.createMode = "REJECT";
  const registry = registryFor(adapter);
  await processProviderJob(await claimOne(), registry);

  const reservation = await getDb().walletReservation.findUniqueOrThrow({ where: { orderId: fixture.order.id } });
  const wallet = await getDb().wallet.findUniqueOrThrow({ where: { id: fixture.wallet.id } });
  const order = await getDb().order.findUniqueOrThrow({ where: { id: fixture.order.id } });
  assert.equal(reservation.status, "RELEASED");
  assert.equal(wallet.balanceMinor, 1_000_000n);
  assert.equal(wallet.reservedMinor, 0n);
  assert.equal(order.status, OrderStatus.FAILED);
  assert.equal(await getDb().walletTransaction.count({ where: { walletId: fixture.wallet.id, type: WalletTransactionType.PURCHASE } }), 0);

  await getDb().providerJob.create({ data: { type: ProviderJobType.SUBMIT_ORDER, status: ProviderJobStatus.PENDING, dedupeKey: `submit-rejected-replay:${fixture.order.id}`, orderId: fixture.order.id, runAt: new Date(0) } });
  const replay = (await claimDueProviderJobs("work7-reject-replay", 10)).find((item) => item.dedupeKey.startsWith("submit-rejected-replay:"));
  assert.ok(replay);
  await processProviderJob(replay, registry);
  assert.equal(adapter.createCalls, 1);
  assert.equal((await getDb().wallet.findUniqueOrThrow({ where: { id: fixture.wallet.id } })).reservedMinor, 0n);
});

test("repeated PARTIAL polling refunds only the server-calculated target once", async () => {
  const fixture = await seedOrder("TT-W6-PARTIAL-1");
  const adapter = new FakeAdapter();
  const registry = registryFor(adapter);
  await processProviderJob(await claimOne(), registry);
  const providerOrder = await getDb().providerOrder.findUniqueOrThrow({ where: { orderId: fixture.order.id } });

  await getDb().providerJob.updateMany({ where: { providerOrderId: providerOrder.id, type: ProviderJobType.POLL_ORDER_STATUS }, data: { runAt: new Date(0) } });
  adapter.nextStatus = { status: "PARTIAL", remaining: 300, startCount: 10 };
  const poll1 = (await claimDueProviderJobs("work6-test-worker", 10)).find((job) => job.type === ProviderJobType.POLL_ORDER_STATUS);
  assert.ok(poll1);
  await processProviderJob(poll1, registry);

  await getDb().providerJob.create({ data: { type: ProviderJobType.POLL_ORDER_STATUS, status: ProviderJobStatus.PENDING, dedupeKey: `poll-replay:${providerOrder.id}`, providerId: fixture.provider.id, orderId: fixture.order.id, providerOrderId: providerOrder.id, runAt: new Date(0) } });
  const poll2 = (await claimDueProviderJobs("work6-test-worker", 10)).find((job) => job.dedupeKey.startsWith("poll-replay:"));
  assert.ok(poll2);
  await processProviderJob(poll2, registry);

  const order = await getDb().order.findUniqueOrThrow({ where: { id: fixture.order.id } });
  assert.equal(order.status, OrderStatus.PARTIAL);
  assert.equal(order.remaining, 300);
  assert.equal(order.refundedMinor, 6_000n);
  assert.equal((await getDb().wallet.findUniqueOrThrow({ where: { id: fixture.wallet.id } })).balanceMinor, 986_000n);
  const refunds = await getDb().walletTransaction.findMany({ where: { walletId: fixture.wallet.id, type: WalletTransactionType.REFUND } });
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0]?.amountMinor, 6_000n);
  assert.equal(adapter.statusCalls, 2);
});

test("durable queue recovers stale RUNNING jobs and conditional claim prevents double ownership", async () => {
  const db = getDb();
  const stale = await db.providerJob.create({
    data: {
      type: ProviderJobType.TEST_CONNECTION,
      status: ProviderJobStatus.RUNNING,
      dedupeKey: "work6-stale-job",
      lockedAt: new Date(Date.now() - 10 * 60_000),
      lockedBy: "dead-worker",
      runAt: new Date(0)
    }
  });
  const recovered = await claimDueProviderJobs("recovery-worker", 1);
  assert.equal(recovered[0]?.id, stale.id);
  assert.equal(recovered[0]?.lockedBy, "recovery-worker");
  assert.equal(recovered[0]?.attempts, 1);

  await db.providerJob.update({ where: { id: stale.id }, data: { status: ProviderJobStatus.PENDING, lockedAt: null, lockedBy: null, attempts: 0, runAt: new Date(0) } });
  const [a, b] = await Promise.all([
    claimDueProviderJobs("worker-a", 1),
    claimDueProviderJobs("worker-b", 1)
  ]);
  assert.equal(a.length + b.length, 1, "one durable job must be owned by only one worker claim");
});
