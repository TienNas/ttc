import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import {
  DepositMethodType,
  OrderStatus,
  ServiceStatus,
  SocialPlatform,
  SupportTicketStatus,
  UserRole,
  UserStatus,
  WalletTransactionStatus,
  WalletTransactionType,
  disconnectDb,
  getDb
} from "@tuong-tac-pro/db";
import {
  DomainError,
  adjustCustomerWallet,
  cancelDeposit,
  changeCustomerStatus,
  confirmDeposit,
  createCategory,
  createCustomerOrder,
  createOrderQuote,
  createDepositRequest,
  createService,
  createSupportTicket,
  failDeposit,
  refundOrder,
  registerCustomer,
  sendAdminSupportReply,
  updateCategory,
  updateService,
  updateSupportStatus,
  updateSystemSettings
} from "@tuong-tac-pro/domain";
import { verifyCustomerCredentials } from "@/server/auth-service";

const rootEnvPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required for Work 05 admin tests.");
process.env.DATABASE_URL = testDatabaseUrl;

const password = "TestPass1234";
let passwordHash = "";

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
  await db.systemSetting.deleteMany();
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
  await db.serviceCategory.create({ data: { id: "followers", name: "Followers", sortOrder: 10, enabled: true } });
  await db.service.create({ data: { id: "svc-admin-test", code: "ADMIN-TEST", name: "Admin test", description: "Test service", platform: SocialPlatform.FACEBOOK, categoryId: "followers", ratePerThousandMinor: 100000n, min: 100, max: 10000, averageTime: "0–24 giờ", status: ServiceStatus.ACTIVE } });
  await db.depositMethod.create({ data: { id: "bank-admin-test", name: "Bank", type: DepositMethodType.BANK, description: "Test", minMinor: 50000n, maxMinor: 5000000n, feeLabel: "0đ", enabled: true, instructions: ["Test"] } });
  await db.systemSetting.create({ data: { id: "default", siteName: "Tương Tác Pro", supportEmail: "support@example.com", minimumDepositMinor: 50000n } });
}
async function createAdmin() {
  return getDb().user.create({ data: { email: "admin-test@example.com", passwordHash, name: "Admin Test", role: UserRole.ADMIN, status: UserStatus.ACTIVE } });
}
async function createCustomer(email: string, balance = 0n) {
  const user = await registerCustomer({ email, passwordHash, name: email.split("@")[0] ?? "Customer" });
  const wallet = await getDb().wallet.findUniqueOrThrow({ where: { userId: user.id } });
  if (balance > 0n) {
    await getDb().$transaction(async (tx) => {
      await tx.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: balance } });
      await tx.walletTransaction.create({ data: { walletId: wallet.id, type: WalletTransactionType.ADJUSTMENT, status: WalletTransactionStatus.COMPLETED, amountMinor: balance, balanceBeforeMinor: 0n, balanceAfterMinor: balance, referenceType: "TEST_SETUP", description: "Opening test balance" } });
    });
  }
  return user;
}
async function createQuotedOrder(userId: string, input: { serviceId: string; targetUrl: string; quantity: number }, key: string) {
  const quote = await createOrderQuote(userId, { serviceId: input.serviceId, quantity: input.quantity });
  return createCustomerOrder(userId, { quoteId: quote.id, targetUrl: input.targetUrl }, key);
}
function domainCode(code: string) { return (error: unknown) => error instanceof DomainError && error.code === code; }

test("Work 05 admin operations", async (t) => {
  const previousProviderRouting = process.env.PROVIDER_ROUTING_ENABLED;
  process.env.PROVIDER_ROUTING_ENABLED = "false";
  t.after(() => {
    if (previousProviderRouting === undefined) delete process.env.PROVIDER_ROUTING_ENABLED;
    else process.env.PROVIDER_ROUTING_ENABLED = previousProviderRouting;
  });
  passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  await t.test("WALLET: positive/negative adjustments are ledger-backed and audited", async () => {
    await reset(); const admin = await createAdmin(); const customer = await createCustomer("wallet-admin@example.com", 100000n); const actor = { userId: admin.id, ipAddress: "127.0.0.1" };
    const plus = await adjustCustomerWallet(actor, customer.id, 50000n, "Manual reconciliation credit", "work5-adjust-plus");
    assert.equal(plus.balanceAfterMinor, 150000n); assert.equal(plus.adminUserId, admin.id);
    const minus = await adjustCustomerWallet(actor, customer.id, -40000n, "Manual reconciliation debit", "work5-adjust-minus");
    assert.equal(minus.balanceAfterMinor, 110000n);
    await assert.rejects(() => adjustCustomerWallet(actor, customer.id, -200000n, "Invalid negative adjustment", "work5-adjust-negative"), domainCode("INSUFFICIENT_BALANCE"));
    assert.equal((await getDb().wallet.findUniqueOrThrow({ where: { userId: customer.id } })).balanceMinor, 110000n);
    assert.equal(await getDb().adminAuditLog.count({ where: { action: "WALLET_ADJUSTMENT" } }), 2);
  });

  await t.test("DEPOSIT: confirm credits exactly once including concurrent confirmation", async () => {
    await reset(); const admin = await createAdmin(); const customer = await createCustomer("deposit-admin@example.com", 100000n); const actor = { userId: admin.id };
    const deposit = await createDepositRequest(customer.id, { methodId: "bank-admin-test", amountMinor: 250000n }, "work5-deposit-create");
    const results = await Promise.allSettled([confirmDeposit(actor, deposit.publicId, "Verified bank transfer"), confirmDeposit(actor, deposit.publicId, "Verified bank transfer")]);
    assert.ok(results.some((result) => result.status === "fulfilled"));
    const wallet = await getDb().wallet.findUniqueOrThrow({ where: { userId: customer.id } });
    assert.equal(wallet.balanceMinor, 350000n);
    assert.equal((await getDb().deposit.findUniqueOrThrow({ where: { id: deposit.id } })).status, "CONFIRMED");
    assert.equal(await getDb().walletTransaction.count({ where: { walletId: wallet.id, type: WalletTransactionType.DEPOSIT, status: WalletTransactionStatus.COMPLETED, referenceId: deposit.publicId } }), 1);
    assert.equal(await getDb().adminAuditLog.count({ where: { action: "DEPOSIT_CONFIRM", entityId: deposit.publicId } }), 1);
  });

  await t.test("DEPOSIT: fail/cancel only work from PENDING and never credit wallet", async () => {
    await reset(); const admin = await createAdmin(); const customer = await createCustomer("deposit-state@example.com", 100000n); const actor = { userId: admin.id };
    const failed = await createDepositRequest(customer.id, { methodId: "bank-admin-test", amountMinor: 100000n }, "work5-deposit-fail");
    await failDeposit(actor, failed.publicId, "Payment evidence invalid");
    const cancelled = await createDepositRequest(customer.id, { methodId: "bank-admin-test", amountMinor: 120000n }, "work5-deposit-cancel");
    await cancelDeposit(actor, cancelled.publicId, "Customer requested cancellation");
    assert.equal((await getDb().wallet.findUniqueOrThrow({ where: { userId: customer.id } })).balanceMinor, 100000n);
    await assert.rejects(() => confirmDeposit(actor, failed.publicId, "Late confirm should fail"), domainCode("VALIDATION_ERROR"));
  });

  await t.test("ORDER REFUND: idempotent/concurrent and ledger/order log/audit remain consistent", async () => {
    await reset(); const admin = await createAdmin(); const customer = await createCustomer("refund@example.com", 300000n); const actor = { userId: admin.id };
    const order = await createQuotedOrder(customer.id, { serviceId: "svc-admin-test", targetUrl: "https://example.com/refund", quantity: 1000 }, "work5-order-create");
    const reservedWallet = await getDb().wallet.findUniqueOrThrow({ where: { userId: customer.id } });
    assert.equal(reservedWallet.balanceMinor, 300000n);
    assert.equal(reservedWallet.reservedMinor, 100000n);
    await Promise.allSettled([refundOrder(actor, order.publicId, "Provider not submitted"), refundOrder(actor, order.publicId, "Provider not submitted")]);
    const wallet = await getDb().wallet.findUniqueOrThrow({ where: { userId: customer.id } });
    assert.equal(wallet.balanceMinor, 300000n);
    assert.equal(wallet.reservedMinor, 0n);
    assert.equal((await getDb().order.findUniqueOrThrow({ where: { id: order.id } })).status, OrderStatus.REFUNDED);
    assert.equal(await getDb().walletTransaction.count({ where: { walletId: wallet.id, type: WalletTransactionType.REFUND, referenceId: order.publicId } }), 0);
    assert.equal(await getDb().orderLog.count({ where: { orderId: order.id, toStatus: OrderStatus.REFUNDED } }), 1);
    assert.equal(await getDb().adminAuditLog.count({ where: { action: "ORDER_REFUND", entityId: order.publicId } }), 1);
  });

  await t.test("SERVICE/CATEGORY: create, duplicate code, price history, statuses and category safety", async () => {
    await reset(); const admin = await createAdmin(); const actor = { userId: admin.id };
    await createCategory(actor, { id: "views", name: "Views", sortOrder: 20, enabled: true });
    const service = await createService(actor, { code: "WORK5-SVC", name: "Work 05 service", description: "Created by admin", platform: "TIKTOK", categoryId: "views", ratePerThousandMinor: 12000n, min: 100, max: 10000, averageTime: "0–4 giờ", popular: false, status: "ACTIVE" });
    await assert.rejects(() => createService(actor, { code: "WORK5-SVC", name: "Duplicate", description: "Duplicate", platform: "TIKTOK", categoryId: "views", ratePerThousandMinor: 12000n, min: 100, max: 10000, averageTime: "0–4 giờ", popular: false, status: "ACTIVE" }), domainCode("VALIDATION_ERROR"));
    await assert.rejects(() => createService(actor, { code: "WORK5-BAD", name: "Bad", description: "Bad", platform: "TIKTOK", categoryId: "views", ratePerThousandMinor: -1n, min: 100, max: 10, averageTime: "0–4 giờ", popular: false, status: "ACTIVE" }), domainCode("VALIDATION_ERROR"));
    await updateService(actor, service.id, { code: "WORK5-SVC", name: "Work 05 service", description: "Updated", platform: "TIKTOK", categoryId: "views", ratePerThousandMinor: 15000n, min: 100, max: 20000, averageTime: "0–4 giờ", popular: true, status: "MAINTENANCE", priceChangeReason: "Pricing review" });
    assert.equal(await getDb().servicePriceHistory.count({ where: { serviceId: service.id } }), 1);
    await assert.rejects(() => updateCategory(actor, "views", { name: "Views", sortOrder: 20, enabled: false }), domainCode("VALIDATION_ERROR"));
    await updateService(actor, service.id, { code: "WORK5-SVC", name: "Work 05 service", description: "Updated", platform: "TIKTOK", categoryId: "views", ratePerThousandMinor: 15000n, min: 100, max: 20000, averageTime: "0–4 giờ", popular: true, status: "DISABLED" });
    await updateCategory(actor, "views", { name: "Views", sortOrder: 20, enabled: false });
    assert.equal((await getDb().serviceCategory.findUniqueOrThrow({ where: { id: "views" } })).enabled, false);
  });

  await t.test("USER STATUS: suspend invalidates sessions/login; activate restores login", async () => {
    await reset(); const admin = await createAdmin(); const customer = await createCustomer("suspend@example.com"); const actor = { userId: admin.id };
    const before = (await getDb().user.findUniqueOrThrow({ where: { id: customer.id } })).sessionVersion;
    await changeCustomerStatus(actor, customer.id, "SUSPENDED");
    const suspended = await getDb().user.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(suspended.status, UserStatus.SUSPENDED); assert.equal(suspended.sessionVersion, before + 1); assert.equal(await verifyCustomerCredentials(customer.email, password), null);
    await changeCustomerStatus(actor, customer.id, "ACTIVE");
    assert.equal((await verifyCustomerCredentials(customer.email, password))?.id, customer.id);
  });

  await t.test("SETTINGS: disabling new orders does not break idempotent replay of an existing order", async () => {
    await reset(); const admin = await createAdmin(); const customer = await createCustomer("settings-order@example.com", 300000n); const actor = { userId: admin.id };
    const quote = await createOrderQuote(customer.id, { serviceId: "svc-admin-test", quantity: 1000 });
    const input = { quoteId: quote.id, targetUrl: "https://example.com/settings-idempotency" };
    const existing = await createCustomerOrder(customer.id, input, "work5-settings-order");
    await updateSystemSettings(actor, { siteName: "Tương Tác Pro", supportEmail: "support@example.com", maintenanceMode: false, minimumDepositMinor: 50000n, orderCreationEnabled: false, supportEnabled: true });
    const replay = await createCustomerOrder(customer.id, input, "work5-settings-order");
    assert.equal(replay.id, existing.id);
    await assert.rejects(() => createOrderQuote(customer.id, { serviceId: "svc-admin-test", quantity: 1000 }), domainCode("SERVICE_UNAVAILABLE"));
    assert.equal(await getDb().order.count({ where: { userId: customer.id } }), 1);
  });

  await t.test("SUPPORT/SETTINGS/AUDIT: admin reply, status and system setting changes persist", async () => {
    await reset(); const admin = await createAdmin(); const customer = await createCustomer("support-admin@example.com"); const actor = { userId: admin.id };
    const ticket = await createSupportTicket(customer.id, { subject: "Need admin", category: "General", message: "Initial message" });
    await sendAdminSupportReply(actor, ticket.publicId, "Admin response");
    assert.equal((await getDb().supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status, SupportTicketStatus.WAITING_CUSTOMER);
    await updateSupportStatus(actor, ticket.publicId, SupportTicketStatus.RESOLVED);
    const apiShapedSettings = {
      siteName: "Tương Tác Pro Test",
      supportEmail: "ops@example.com",
      maintenanceMode: false,
      minimumDeposit: 75000,
      minimumDepositMinor: 75000n,
      orderCreationEnabled: false,
      supportEnabled: true
    };
    await updateSystemSettings(actor, apiShapedSettings);
    const settings = await getDb().systemSetting.findUniqueOrThrow({ where: { id: "default" } });
    assert.equal(settings.siteName, "Tương Tác Pro Test"); assert.equal(settings.minimumDepositMinor, 75000n); assert.equal(settings.orderCreationEnabled, false);
    assert.ok(await getDb().adminAuditLog.count({ where: { action: { in: ["SUPPORT_REPLY", "SUPPORT_STATUS_CHANGE", "SYSTEM_SETTING_UPDATE"] } } }) >= 3);
  });

  await disconnectDb();
});
