import test from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import argon2 from "argon2";
import {
  DepositMethodType,
  OrderStatus,
  ServiceStatus,
  SocialPlatform,
  WalletTransactionStatus,
  WalletTransactionType,
  disconnectDb,
  getDb
} from "@tuong-tac-pro/db";
import {
  DomainError,
  createCustomerOrder,
  createOrderQuote,
  createDepositRequest,
  createSupportTicket,
  getOwnedOrder,
  getOwnedTicket,
  registerCustomer,
  sendSupportReply,
  updateCustomerProfile
} from "@tuong-tac-pro/domain";
import { verifyCustomerCredentials } from "@/server/auth-service";
import { changeCustomerPassword } from "@/server/account-service";
import { requireSessionIdentity } from "@/server/auth-user";
import { createOrderSchema } from "@/server/validation";

const rootEnvPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for Work 04 backend integration tests.");
}
process.env.DATABASE_URL = testDatabaseUrl;

const password = "TestPass1234";
let passwordHash = "";

async function resetDatabase() {
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

  await db.serviceCategory.create({ data: { id: "followers", name: "Người theo dõi", sortOrder: 10 } });
  await db.service.create({
    data: {
      id: "svc-active",
      code: "TEST-ACTIVE",
      name: "Dịch vụ kiểm thử",
      description: "Dịch vụ dùng cho Work 04 integration test.",
      platform: SocialPlatform.FACEBOOK,
      categoryId: "followers",
      ratePerThousandMinor: 100000n,
      min: 100,
      max: 10000,
      averageTime: "0–24 giờ",
      status: ServiceStatus.ACTIVE,
      popular: true
    }
  });
  await db.service.create({
    data: {
      id: "svc-disabled",
      code: "TEST-DISABLED",
      name: "Dịch vụ tạm dừng",
      description: "Dịch vụ không được nhận đơn.",
      platform: SocialPlatform.TIKTOK,
      categoryId: "followers",
      ratePerThousandMinor: 100000n,
      min: 100,
      max: 10000,
      averageTime: "0–24 giờ",
      status: ServiceStatus.DISABLED,
      popular: false
    }
  });
  await db.depositMethod.create({
    data: {
      id: "bank-test",
      name: "Ngân hàng kiểm thử",
      type: DepositMethodType.BANK,
      description: "Phương thức kiểm thử.",
      minMinor: 50000n,
      maxMinor: 5000000n,
      feeLabel: "0đ",
      enabled: true,
      instructions: ["Tạo yêu cầu", "Chờ xác nhận"]
    }
  });
}

async function createUser(email: string, balanceMinor = 0n) {
  const user = await registerCustomer({ email, name: email.split("@")[0] ?? "User", passwordHash });
  if (balanceMinor > 0n) {
    const db = getDb();
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    await db.$transaction(async (tx) => {
      await tx.wallet.update({ where: { id: wallet.id }, data: { balanceMinor } });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.ADJUSTMENT,
          status: WalletTransactionStatus.COMPLETED,
          amountMinor: balanceMinor,
          balanceBeforeMinor: 0n,
          balanceAfterMinor: balanceMinor,
          referenceType: "TEST_SETUP",
          description: "Nạp số dư kiểm thử"
        }
      });
    });
  }
  return user;
}

async function createQuotedOrder(userId: string, input: { serviceId: string; targetUrl: string; quantity: number }, key: string) {
  const quote = await createOrderQuote(userId, { serviceId: input.serviceId, quantity: input.quantity });
  return createCustomerOrder(userId, { quoteId: quote.id, targetUrl: input.targetUrl }, key);
}

function isDomainCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

test("Work 04 backend/database integration", async (t) => {
  const previousProviderRouting = process.env.PROVIDER_ROUTING_ENABLED;
  process.env.PROVIDER_ROUTING_ENABLED = "false";
  t.after(() => {
    if (previousProviderRouting === undefined) delete process.env.PROVIDER_ROUTING_ENABLED;
    else process.env.PROVIDER_ROUTING_ENABLED = previousProviderRouting;
  });
  passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  await t.test("AUTH: register, duplicate email, valid and invalid credentials", async () => {
    await resetDatabase();
    const user = await createUser("auth@example.com");
    assert.equal(user.email, "auth@example.com");
    await assert.rejects(() => registerCustomer({ email: "AUTH@example.com", name: "Duplicate", passwordHash }), isDomainCode("EMAIL_IN_USE"));
    assert.equal((await verifyCustomerCredentials("AUTH@example.com", password))?.id, user.id);
    assert.equal(await verifyCustomerCredentials("auth@example.com", "wrong-password"), null);
  });

  await t.test("AUTHORIZATION: missing session identity is rejected", () => {
    assert.throws(() => requireSessionIdentity(null), isDomainCode("UNAUTHORIZED"));
  });

  await t.test("PROFILE/AUTH: email uniqueness and password change/session version", async () => {
    await resetDatabase();
    const first = await createUser("profile-a@example.com");
    await createUser("profile-b@example.com");
    await assert.rejects(
      () => updateCustomerProfile(first.id, { name: "Profile A", email: "PROFILE-B@example.com", phone: "" }),
      isDomainCode("EMAIL_IN_USE")
    );
    await assert.rejects(() => changeCustomerPassword(first.id, "wrong-current", "NewPass1234"), isDomainCode("INVALID_CREDENTIALS"));
    const beforeVersion = (await getDb().user.findUniqueOrThrow({ where: { id: first.id } })).sessionVersion;
    await changeCustomerPassword(first.id, password, "NewPass1234");
    const changed = await getDb().user.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(changed.sessionVersion, beforeVersion + 1);
    assert.equal(await verifyCustomerCredentials("profile-a@example.com", password), null);
    assert.equal((await verifyCustomerCredentials("profile-a@example.com", "NewPass1234"))?.id, first.id);
  });

  await t.test("ORDER: valid order reserves wallet funds and writes its order log atomically", async () => {
    await resetDatabase();
    const user = await createUser("order@example.com", 200000n);
    const order = await createQuotedOrder(user.id, { serviceId: "svc-active", targetUrl: "https://example.com/post/1", quantity: 500 }, "idem-order-valid-0001");
    assert.equal(order.status, OrderStatus.PENDING);
    assert.equal(order.chargeMinor, 50000n);
    const db = getDb();
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(wallet.balanceMinor, 200000n);
    assert.equal(wallet.reservedMinor, 50000n);
    assert.equal(await db.walletTransaction.count({ where: { referenceId: order.publicId, type: WalletTransactionType.PURCHASE } }), 0);
    const logs = await db.orderLog.findMany({ where: { orderId: order.id } });
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.toStatus, OrderStatus.PENDING);
  });

  await t.test("ORDER: inactive/missing service and min/max validation are rejected without debit", async () => {
    await resetDatabase();
    const user = await createUser("validate@example.com", 200000n);
    await assert.rejects(() => createOrderQuote(user.id, { serviceId: "missing", quantity: 500 }), isDomainCode("SERVICE_NOT_FOUND"));
    await assert.rejects(() => createOrderQuote(user.id, { serviceId: "svc-disabled", quantity: 500 }), isDomainCode("SERVICE_UNAVAILABLE"));
    await assert.rejects(() => createOrderQuote(user.id, { serviceId: "svc-active", quantity: 99 }), isDomainCode("VALIDATION_ERROR"));
    await assert.rejects(() => createOrderQuote(user.id, { serviceId: "svc-active", quantity: 10001 }), isDomainCode("VALIDATION_ERROR"));
    assert.equal((await getDb().wallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceMinor, 200000n);
  });

  await t.test("ORDER: URL is validated at authoritative API boundary schema", () => {
    assert.equal(createOrderSchema.safeParse({ quoteId: "fdcd6a74-8cce-4c55-9472-c7ee76b2a3d5", targetUrl: "javascript:alert(1)" }).success, false);
    assert.equal(createOrderSchema.safeParse({ quoteId: "fdcd6a74-8cce-4c55-9472-c7ee76b2a3d5", targetUrl: "https://example.com/post" }).success, true);
  });

  await t.test("ATOMICITY: insufficient balance creates no order or purchase ledger", async () => {
    await resetDatabase();
    const user = await createUser("atomic@example.com", 10000n);
    const before = (await getDb().wallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceMinor;
    const quote = await createOrderQuote(user.id, { serviceId: "svc-active", quantity: 500 });
    await assert.rejects(() => createCustomerOrder(user.id, { quoteId: quote.id, targetUrl: "https://example.com/atomic" }, "idem-atomic-0001"), isDomainCode("INSUFFICIENT_BALANCE"));
    const db = getDb();
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(wallet.balanceMinor, before);
    assert.equal(await db.order.count({ where: { userId: user.id } }), 0);
    assert.equal(await db.walletTransaction.count({ where: { walletId: wallet.id, type: WalletTransactionType.PURCHASE } }), 0);
  });

  await t.test("IDEMPOTENCY: same key and payload returns one order; changed payload conflicts", async () => {
    await resetDatabase();
    const user = await createUser("idem@example.com", 200000n);
    const quote = await createOrderQuote(user.id, { serviceId: "svc-active", quantity: 500 });
    const input = { quoteId: quote.id, targetUrl: "https://example.com/idempotent" };
    const first = await createCustomerOrder(user.id, input, "idem-repeat-0001");
    const second = await createCustomerOrder(user.id, input, "idem-repeat-0001");
    assert.equal(second.id, first.id);
    const db = getDb();
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(await db.order.count({ where: { userId: user.id } }), 1);
    assert.equal(await db.walletTransaction.count({ where: { walletId: wallet.id, type: WalletTransactionType.PURCHASE } }), 0);
    assert.equal(await db.walletReservation.count({ where: { walletId: wallet.id } }), 1);
    await assert.rejects(() => createCustomerOrder(user.id, { ...input, targetUrl: "https://example.com/changed" }, "idem-repeat-0001"), isDomainCode("DUPLICATE_REQUEST"));
  });

  await t.test("CONCURRENCY: two 80k orders cannot overspend a 100k wallet", async () => {
    await resetDatabase();
    const user = await createUser("race@example.com", 100000n);
    const [quoteA, quoteB] = await Promise.all([
      createOrderQuote(user.id, { serviceId: "svc-active", quantity: 800 }),
      createOrderQuote(user.id, { serviceId: "svc-active", quantity: 800 })
    ]);
    const results = await Promise.allSettled([
      createCustomerOrder(user.id, { quoteId: quoteA.id, targetUrl: "https://example.com/race-a" }, "idem-race-a-0001"),
      createCustomerOrder(user.id, { quoteId: quoteB.id, targetUrl: "https://example.com/race-b" }, "idem-race-b-0001")
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const db = getDb();
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(wallet.balanceMinor, 100000n);
    assert.equal(wallet.reservedMinor, 80000n);
    assert.equal(await db.order.count({ where: { userId: user.id } }), 1);
  });

  await t.test("OWNERSHIP: another user cannot read order or support ticket by guessed public ID", async () => {
    await resetDatabase();
    const owner = await createUser("owner@example.com", 200000n);
    const attacker = await createUser("attacker@example.com", 200000n);
    const order = await createQuotedOrder(owner.id, { serviceId: "svc-active", targetUrl: "https://example.com/owned", quantity: 500 }, "idem-owned-0001");
    const ticket = await createSupportTicket(owner.id, { subject: "Yêu cầu của chủ tài khoản", category: "Order", message: "Cần kiểm tra đơn hàng." });
    await assert.rejects(() => getOwnedOrder(attacker.id, order.publicId), isDomainCode("ORDER_NOT_FOUND"));
    await assert.rejects(() => getOwnedTicket(attacker.id, ticket.publicId), isDomainCode("TICKET_NOT_FOUND"));
  });

  await t.test("DEPOSIT: request is PENDING, idempotent, persists ledger, and does not credit wallet", async () => {
    await resetDatabase();
    const user = await createUser("deposit@example.com", 100000n);
    const deposit = await createDepositRequest(user.id, { methodId: "bank-test", amountMinor: 500000n }, "idem-deposit-0001");
    const replay = await createDepositRequest(user.id, { methodId: "bank-test", amountMinor: 500000n }, "idem-deposit-0001");
    assert.equal(replay.id, deposit.id);
    assert.equal(deposit.status, "PENDING");
    const db = getDb();
    const wallet = await db.wallet.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(wallet.balanceMinor, 100000n);
    const ledgers = await db.walletTransaction.findMany({ where: { referenceId: deposit.publicId, type: WalletTransactionType.DEPOSIT } });
    assert.equal(ledgers.length, 1);
    const ledger = ledgers[0];
    assert.equal(ledger?.status, WalletTransactionStatus.PENDING);
    assert.equal(ledger?.balanceBeforeMinor, 100000n);
    assert.equal(ledger?.balanceAfterMinor, 100000n);
    await assert.rejects(
      () => createDepositRequest(user.id, { methodId: "bank-test", amountMinor: 600000n }, "idem-deposit-0001"),
      isDomainCode("DUPLICATE_REQUEST")
    );
  });

  await t.test("SUPPORT: customer can create ticket and reply; another customer remains blocked", async () => {
    await resetDatabase();
    const user = await createUser("support@example.com");
    const other = await createUser("support-other@example.com");
    const ticket = await createSupportTicket(user.id, { subject: "Kiểm tra hỗ trợ", category: "General", message: "Tin nhắn đầu tiên." });
    const reply = await sendSupportReply(user.id, ticket.publicId, "Tin nhắn tiếp theo.");
    assert.equal(reply.body, "Tin nhắn tiếp theo.");
    const thread = await getOwnedTicket(user.id, ticket.publicId);
    assert.equal(thread.messages.length, 2);
    await assert.rejects(() => sendSupportReply(other.id, ticket.publicId, "Không được phép"), isDomainCode("TICKET_NOT_FOUND"));
  });

  await t.test("PERSISTENCE: order, ticket and profile survive Prisma client disconnect/reconnect", async () => {
    await resetDatabase();
    const user = await createUser("persist@example.com", 200000n);
    const order = await createQuotedOrder(user.id, { serviceId: "svc-active", targetUrl: "https://example.com/persist", quantity: 500 }, "idem-persist-0001");
    const ticket = await createSupportTicket(user.id, { subject: "Dữ liệu bền vững", category: "General", message: "Không được mất sau reconnect." });
    await updateCustomerProfile(user.id, { name: "Persisted User", email: "persist@example.com", phone: "0900000000" });

    await disconnectDb();
    const db = getDb(testDatabaseUrl);
    assert.ok(await db.order.findUnique({ where: { publicId: order.publicId } }));
    assert.ok(await db.supportTicket.findUnique({ where: { publicId: ticket.publicId } }));
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).name, "Persisted User");
  });

  await disconnectDb();
});
