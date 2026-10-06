import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ServiceStatus,
  SocialPlatform,
  UserRole,
  UserStatus,
  WalletReservationStatus,
  WalletTransactionType,
  disconnectDb,
  getDb
} from "@tuong-tac-pro/db";
import {
  DomainError,
  captureOrderReservation,
  createCustomerOrder,
  createOrderQuote,
  releaseOrderReservation
} from "@tuong-tac-pro/domain";

const rootEnvPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for Work 07 financial integration tests.");
process.env.DATABASE_URL = testDatabaseUrl;
process.env.PROVIDER_ROUTING_ENABLED = "false";

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
  await db.adminAuditLog.deleteMany();
  await db.servicePriceHistory.deleteMany();
  await db.paymentEvent.deleteMany();
  await db.payment.deleteMany();
  await db.walletTransaction.deleteMany();
  await db.walletReservation.deleteMany();
  await db.orderLog.deleteMany();
  await db.supportMessage.deleteMany();
  await db.deposit.deleteMany();
  await db.order.deleteMany();
  await db.orderQuote.deleteMany();
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

  await db.serviceCategory.create({ data: { id: "work7-cat", name: "Work 07", enabled: true } });
  await db.service.create({
    data: {
      id: "work7-service", code: "WORK7-SVC", name: "Work 07 Service", description: "Financial hardening test service",
      platform: SocialPlatform.FACEBOOK, categoryId: "work7-cat", ratePerThousandMinor: 100_000n,
      min: 100, max: 10_000, averageTime: "0-24h", status: ServiceStatus.ACTIVE
    }
  });
  await db.systemSetting.create({ data: { id: "default", siteName: "Tương Tác Pro", supportEmail: "support@example.com" } });
}

async function customer(balanceMinor: bigint) {
  const db = getDb();
  const user = await db.user.create({
    data: { email: `work7-${crypto.randomUUID()}@example.com`, passwordHash: "test", name: "Work 07", role: UserRole.CUSTOMER, status: UserStatus.ACTIVE }
  });
  const wallet = await db.wallet.create({ data: { userId: user.id, balanceMinor, reservedMinor: 0n, currency: "VND" } });
  return { user, wallet };
}

async function quoteAndOrder(userId: string, quantity: number, key: string, target = "https://example.com/work7") {
  const quote = await createOrderQuote(userId, { serviceId: "work7-service", quantity });
  const order = await createCustomerOrder(userId, { quoteId: quote.id, targetUrl: target }, key);
  return { quote, order };
}

function domainCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

beforeEach(reset);
after(async () => {
  delete process.env.PROVIDER_ROUTING_ENABLED;
  await disconnectDb();
});

test("concurrent wallet reservations cannot overspend available balance", async () => {
  const { user, wallet } = await customer(100_000n);
  const [a, b] = await Promise.all([
    createOrderQuote(user.id, { serviceId: "work7-service", quantity: 800 }),
    createOrderQuote(user.id, { serviceId: "work7-service", quantity: 800 })
  ]);
  const results = await Promise.allSettled([
    createCustomerOrder(user.id, { quoteId: a.id, targetUrl: "https://example.com/a" }, "work7-race-a"),
    createCustomerOrder(user.id, { quoteId: b.id, targetUrl: "https://example.com/b" }, "work7-race-b")
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const latest = await getDb().wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  assert.equal(latest.balanceMinor, 100_000n);
  assert.equal(latest.reservedMinor, 80_000n);
  assert.equal(await getDb().order.count({ where: { userId: user.id } }), 1);
});

test("insufficient available balance rolls back quote consumption, order and reservation", async () => {
  const { user, wallet } = await customer(40_000n);
  const quote = await createOrderQuote(user.id, { serviceId: "work7-service", quantity: 500 });
  await assert.rejects(
    () => createCustomerOrder(user.id, { quoteId: quote.id, targetUrl: "https://example.com/insufficient" }, "work7-insufficient"),
    domainCode("INSUFFICIENT_BALANCE")
  );
  assert.equal((await getDb().orderQuote.findUniqueOrThrow({ where: { id: quote.id } })).consumedAt, null);
  assert.equal(await getDb().walletReservation.count({ where: { walletId: wallet.id } }), 0);
  assert.equal(await getDb().order.count({ where: { userId: user.id } }), 0);
});

test("idempotent replay creates only one reservation and changed payload conflicts", async () => {
  const { user, wallet } = await customer(200_000n);
  const quote = await createOrderQuote(user.id, { serviceId: "work7-service", quantity: 500 });
  const input = { quoteId: quote.id, targetUrl: "https://example.com/idempotent" };
  const first = await createCustomerOrder(user.id, input, "work7-idempotency");
  const replay = await createCustomerOrder(user.id, input, "work7-idempotency");
  assert.equal(replay.id, first.id);
  assert.equal(await getDb().walletReservation.count({ where: { walletId: wallet.id } }), 1);
  await assert.rejects(
    () => createCustomerOrder(user.id, { ...input, targetUrl: "https://example.com/different" }, "work7-idempotency"),
    domainCode("DUPLICATE_REQUEST")
  );
});

test("capture is exactly once and writes one immutable purchase", async () => {
  const { user, wallet } = await customer(100_000n);
  const { order } = await quoteAndOrder(user.id, 500, "work7-capture");
  const first = await captureOrderReservation(order.id);
  const replay = await captureOrderReservation(order.id);
  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  const latest = await getDb().wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  assert.equal(latest.balanceMinor, 50_000n);
  assert.equal(latest.reservedMinor, 0n);
  assert.equal(await getDb().walletTransaction.count({ where: { walletId: wallet.id, type: WalletTransactionType.PURCHASE } }), 1);
});

test("release is exactly once and never debits posted balance", async () => {
  const { user, wallet } = await customer(100_000n);
  const { order } = await quoteAndOrder(user.id, 500, "work7-release");
  const first = await releaseOrderReservation(order.id);
  const replay = await releaseOrderReservation(order.id);
  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  const latest = await getDb().wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  assert.equal(latest.balanceMinor, 100_000n);
  assert.equal(latest.reservedMinor, 0n);
  assert.equal(await getDb().walletTransaction.count({ where: { walletId: wallet.id, type: WalletTransactionType.PURCHASE } }), 0);
});

test("capture and release race has one winner and preserves wallet invariants", async () => {
  const { user, wallet } = await customer(100_000n);
  const { order } = await quoteAndOrder(user.id, 500, "work7-transition-race");
  const results = await Promise.allSettled([captureOrderReservation(order.id), releaseOrderReservation(order.id)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const reservation = await getDb().walletReservation.findUniqueOrThrow({ where: { orderId: order.id } });
  const latest = await getDb().wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  assert.equal(latest.reservedMinor, 0n);
  if (reservation.status === WalletReservationStatus.CAPTURED) {
    assert.equal(latest.balanceMinor, 50_000n);
    assert.equal(await getDb().walletTransaction.count({ where: { walletId: wallet.id, type: WalletTransactionType.PURCHASE } }), 1);
  } else {
    assert.equal(reservation.status, WalletReservationStatus.RELEASED);
    assert.equal(latest.balanceMinor, 100_000n);
    assert.equal(await getDb().walletTransaction.count({ where: { walletId: wallet.id, type: WalletTransactionType.PURCHASE } }), 0);
  }
});

test("quote is server priced and preserves its snapshot after a service price change", async () => {
  const { user } = await customer(200_000n);
  const quote = await createOrderQuote(user.id, { serviceId: "work7-service", quantity: 500 });
  assert.equal(quote.ratePerThousandMinor, 100_000n);
  assert.equal(quote.chargeMinor, 50_000n);
  await getDb().service.update({ where: { id: "work7-service" }, data: { ratePerThousandMinor: 200_000n } });
  const order = await createCustomerOrder(user.id, { quoteId: quote.id, targetUrl: "https://example.com/frozen-price" }, "work7-frozen-price");
  assert.equal(order.chargeMinor, 50_000n);
});

test("expired quote cannot be consumed", async () => {
  const { user } = await customer(200_000n);
  const quote = await createOrderQuote(user.id, { serviceId: "work7-service", quantity: 500 });
  await getDb().orderQuote.update({ where: { id: quote.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await assert.rejects(
    () => createCustomerOrder(user.id, { quoteId: quote.id, targetUrl: "https://example.com/expired" }, "work7-expired"),
    domainCode("QUOTE_EXPIRED")
  );
});

test("a quote can create at most one order, including concurrent consumption", async () => {
  const { user } = await customer(300_000n);
  const quote = await createOrderQuote(user.id, { serviceId: "work7-service", quantity: 500 });
  const results = await Promise.allSettled([
    createCustomerOrder(user.id, { quoteId: quote.id, targetUrl: "https://example.com/consume-a" }, "work7-consume-a"),
    createCustomerOrder(user.id, { quoteId: quote.id, targetUrl: "https://example.com/consume-b" }, "work7-consume-b")
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(await getDb().order.count({ where: { quoteId: quote.id } }), 1);
  await assert.rejects(
    () => createCustomerOrder(user.id, { quoteId: quote.id, targetUrl: "https://example.com/reuse" }, "work7-reuse"),
    domainCode("QUOTE_ALREADY_USED")
  );
});
