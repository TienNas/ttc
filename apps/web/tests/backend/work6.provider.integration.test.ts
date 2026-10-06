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
  WalletTransactionStatus,
  WalletTransactionType,
  disconnectDb,
  getDb
} from "@tuong-tac-pro/db";
import {
  DomainError,
  applyProviderServiceSync,
  createCustomerOrder,
  enqueueProviderJob,
  refundProviderOrderToTarget,
  upsertServiceProviderMapping
} from "@tuong-tac-pro/domain";

const rootEnvPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for Work 06 provider integration tests.");
process.env.DATABASE_URL = testDatabaseUrl;

async function reset() {
  const db = getDb();

  // Keep Work 06 tests isolated from Work 04/05 because all backend test files
  // intentionally share TEST_DATABASE_URL with test-concurrency=1.
  // Delete children before parents so FK constraints cannot leak state between suites.
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

  await db.adminAuditLog.deleteMany();
  await db.servicePriceHistory.deleteMany();
  await db.paymentEvent.deleteMany();
  await db.payment.deleteMany();
  await db.walletTransaction.deleteMany();
  await db.orderLog.deleteMany();
  await db.supportMessage.deleteMany();
  await db.deposit.deleteMany();
  await db.order.deleteMany();
  await db.supportTicket.deleteMany();
  await db.passwordResetToken.deleteMany();
  await db.session.deleteMany();
  await db.account.deleteMany();
  await db.notificationPreference.deleteMany();
  await db.wallet.deleteMany();
  await db.user.deleteMany();

  await db.service.deleteMany();
  await db.serviceCategory.deleteMany();
  await db.depositMethod.deleteMany();
  await db.systemSetting.deleteMany();

  await db.serviceCategory.create({ data: { id: "work6-cat", name: "Work 06", enabled: true } });
  await db.service.create({
    data: {
      id: "work6-service",
      code: "WORK6-SVC",
      name: "Work 06 Service",
      description: "Provider integration test service",
      platform: SocialPlatform.FACEBOOK,
      categoryId: "work6-cat",
      ratePerThousandMinor: 20000n,
      min: 100,
      max: 10000,
      averageTime: "0-24h",
      status: ServiceStatus.ACTIVE
    }
  });
  await db.systemSetting.create({ data: { id: "default", siteName: "Tương Tác Pro", supportEmail: "support@example.com", minimumDepositMinor: 50000n } });
}

async function seedActorAndCustomer() {
  const db = getDb();
  const admin = await db.user.create({
    data: { email: "work6-admin@example.com", passwordHash: "test", name: "Work6 Admin", role: UserRole.ADMIN, status: UserStatus.ACTIVE }
  });
  const customer = await db.user.create({
    data: { email: "work6-customer@example.com", passwordHash: "test", name: "Work6 Customer", role: UserRole.CUSTOMER, status: UserStatus.ACTIVE }
  });
  const wallet = await db.wallet.create({ data: { userId: customer.id, balanceMinor: 1_000_000n, reservedMinor: 0n, currency: "VND" } });
  return { admin, customer, wallet };
}

async function seedProvider() {
  return getDb().provider.create({
    data: { code: "TEST6", name: "Test Provider", enabled: true, status: ProviderStatus.ACTIVE, health: ProviderHealth.HEALTHY, priority: 10 }
  });
}

beforeEach(async () => {
  process.env.PROVIDER_ROUTING_ENABLED = "false";
  process.env.TTC_API_KEY = "work6-test-key";
  process.env.TTC_XU_TO_VND_RATE = "1";
  process.env.TTC_RATE_INPUT_UNIT = "1";
  await reset();
});

after(async () => {
  delete process.env.PROVIDER_ROUTING_ENABLED;
  delete process.env.TTC_API_KEY;
  delete process.env.TTC_XU_TO_VND_RATE;
  delete process.env.TTC_RATE_INPUT_UNIT;
  await disconnectDb();
});

test("provider service sync is idempotent and records price/removal history", async () => {
  const provider = await seedProvider();
  const base = {
    externalServiceId: "ext-100",
    name: "External Followers",
    category: "Followers",
    platform: "FACEBOOK" as const,
    providerRateMinor: 10_000n,
    rateUnit: 1000,
    currency: "VND",
    min: 100,
    max: 10000,
    supportsRefill: false,
    supportsCancel: false,
    status: "AVAILABLE" as const
  };
  const first = await applyProviderServiceSync(provider.id, [base]);
  assert.equal(first.created, 1);
  const second = await applyProviderServiceSync(provider.id, [base]);
  assert.equal(second.created, 0);
  assert.equal(await getDb().providerService.count({ where: { providerId: provider.id } }), 1);

  const changed = await applyProviderServiceSync(provider.id, [{ ...base, providerRateMinor: 12_000n, min: 200 }]);
  assert.equal(changed.priceChanges, 1);
  assert.equal(await getDb().providerPriceHistory.count(), 1);
  const synced = await getDb().providerService.findUniqueOrThrow({ where: { providerId_externalServiceId: { providerId: provider.id, externalServiceId: base.externalServiceId } } });
  assert.equal(synced.providerRateMinor, 12_000n);
  assert.equal(synced.min, 200);

  const removed = await applyProviderServiceSync(provider.id, []);
  assert.equal(removed.removed, 1);
  assert.equal((await getDb().providerService.findUniqueOrThrow({ where: { id: synced.id } })).status, ProviderServiceStatus.REMOVED);
});

test("provider routing rejects unmapped customer order before wallet debit, then queues mapped order durably", async () => {
  const { admin, customer, wallet } = await seedActorAndCustomer();
  process.env.PROVIDER_ROUTING_ENABLED = "true";
  await assert.rejects(
    () => createCustomerOrder(customer.id, { serviceId: "work6-service", targetUrl: "https://example.com/profile", quantity: 1000 }, "work6-unmapped-order"),
    (error: unknown) => error instanceof DomainError && error.code === "SERVICE_UNAVAILABLE"
  );
  assert.equal((await getDb().wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceMinor, 1_000_000n);
  assert.equal(await getDb().order.count(), 0);

  const provider = await seedProvider();
  await applyProviderServiceSync(provider.id, [{
    externalServiceId: "ext-route",
    name: "External Route",
    platform: "FACEBOOK",
    providerRateMinor: 10_000n,
    rateUnit: 1000,
    currency: "VND",
    min: 100,
    max: 10000,
    supportsRefill: false,
    supportsCancel: false,
    status: "AVAILABLE"
  }]);
  const providerService = await getDb().providerService.findFirstOrThrow({ where: { providerId: provider.id } });
  const mapping = await upsertServiceProviderMapping({ userId: admin.id }, {
    serviceId: "work6-service",
    providerServiceId: providerService.id,
    enabled: true,
    priority: 1,
    markupType: "PERCENTAGE",
    markupBps: 0,
    fixedMarkupMinor: 0n,
    minimumMarginMinor: 0n,
    pricingMode: "MANUAL"
  });
  assert.equal(mapping.status, ProviderMappingStatus.ACTIVE);

  const order = await createCustomerOrder(customer.id, { serviceId: "work6-service", targetUrl: "https://example.com/profile", quantity: 1000 }, "work6-mapped-order");
  assert.equal(order.status, OrderStatus.PENDING);
  const job = await getDb().providerJob.findUniqueOrThrow({ where: { dedupeKey: `submit:${order.id}` } });
  assert.equal(job.type, ProviderJobType.SUBMIT_ORDER);
  assert.equal(job.status, ProviderJobStatus.PENDING);
  assert.equal(job.orderId, order.id);
});

test("durable provider job dedupe returns the original row", async () => {
  const db = getDb();
  const first = await db.$transaction((tx) => enqueueProviderJob(tx, { type: ProviderJobType.TEST_CONNECTION, dedupeKey: "work6:dedupe" }));
  const second = await db.$transaction((tx) => enqueueProviderJob(tx, { type: ProviderJobType.TEST_CONNECTION, dedupeKey: "work6:dedupe" }));
  assert.equal(first.id, second.id);
  assert.equal(await db.providerJob.count({ where: { dedupeKey: "work6:dedupe" } }), 1);
});

test("provider refund target is idempotent and never double-credits wallet", async () => {
  const { customer, wallet } = await seedActorAndCustomer();
  const provider = await seedProvider();
  await applyProviderServiceSync(provider.id, [{
    externalServiceId: "ext-refund",
    name: "External Refund",
    providerRateMinor: 10_000n,
    rateUnit: 1000,
    currency: "VND",
    min: 100,
    max: 10000,
    supportsRefill: false,
    supportsCancel: false,
    status: "AVAILABLE"
  }]);
  const providerService = await getDb().providerService.findFirstOrThrow({ where: { providerId: provider.id } });
  const order = await getDb().order.create({
    data: {
      publicId: "TT-WORK6-REFUND",
      userId: customer.id,
      serviceId: "work6-service",
      targetUrl: "https://example.com/profile",
      quantity: 1000,
      chargeMinor: 20_000n,
      remaining: 1000,
      status: OrderStatus.PROCESSING,
      idempotencyKey: "work6-refund-order",
      requestFingerprint: "work6-refund"
    }
  });
  await getDb().wallet.update({ where: { id: wallet.id }, data: { balanceMinor: 980_000n } });
  const providerOrder = await getDb().providerOrder.create({
    data: {
      orderId: order.id,
      providerId: provider.id,
      providerServiceId: providerService.id,
      externalOrderId: "external-refund-1",
      clientReference: `ttp:${order.publicId}`,
      submissionState: "ACCEPTED",
      status: ProviderOrderStatus.PROCESSING,
      providerRateSnapshotMinor: 10_000n,
      rateUnitSnapshot: 1000,
      providerCostMinor: 10_000n,
      customerChargeMinor: 20_000n,
      grossMarginMinor: 10_000n,
      currency: "VND"
    }
  });

  const first = await refundProviderOrderToTarget({
    orderId: order.id,
    targetRefundMinor: 6_000n,
    finalStatus: OrderStatus.PARTIAL,
    remaining: 300,
    reason: "Work 06 partial refund",
    providerOrderId: providerOrder.id,
    providerOrderStatus: ProviderOrderStatus.PARTIAL,
    providerSubmissionState: "ACCEPTED"
  });
  const second = await refundProviderOrderToTarget({
    orderId: order.id,
    targetRefundMinor: 6_000n,
    finalStatus: OrderStatus.PARTIAL,
    remaining: 300,
    reason: "Work 06 partial refund replay",
    providerOrderId: providerOrder.id,
    providerOrderStatus: ProviderOrderStatus.PARTIAL,
    providerSubmissionState: "ACCEPTED"
  });
  assert.equal(first.refundDeltaMinor, 6_000n);
  assert.equal(second.refundDeltaMinor, 0n);
  assert.equal((await getDb().wallet.findUniqueOrThrow({ where: { id: wallet.id } })).balanceMinor, 986_000n);
  const refunds = await getDb().walletTransaction.findMany({ where: { walletId: wallet.id, type: WalletTransactionType.REFUND, status: WalletTransactionStatus.COMPLETED } });
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0]?.amountMinor, 6_000n);
  assert.equal((await getDb().order.findUniqueOrThrow({ where: { id: order.id } })).refundedMinor, 6_000n);
});
