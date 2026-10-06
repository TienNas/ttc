import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import { getDb } from "../src/client";
import { resolveDevelopmentSeedConfig } from "../src/seed-safety";
import { DepositStatus, OrderStatus, ProviderHealth, ProviderStatus, SocialPlatform, ServiceStatus, SupportSenderType, SupportTicketStatus, UserRole, UserStatus, DepositMethodType, WalletTransactionStatus, WalletTransactionType } from "../generated/prisma/client";

const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

const db = getDb();

const categories = [
  ["followers", "Người theo dõi", 10],
  ["likes", "Lượt thích / Cảm xúc", 20],
  ["views", "Lượt xem", 30],
  ["comments", "Bình luận", 40],
  ["shares", "Chia sẻ", 50]
] as const;

const services = [
  ["svc_fb_like_01", "FB-LIKE-01", SocialPlatform.FACEBOOK, "likes", "Like bài viết Facebook - Chất lượng cao", "Tăng LIKE cho bài viết Facebook công khai bằng dịch vụ TTC chất lượng cao.", 43000n, 50, 10000000, "0–6 giờ", ServiceStatus.ACTIVE, true],
  ["svc_fb_comment_like_01", "FB-CMT-LIKE-01", SocialPlatform.FACEBOOK, "likes", "Like bình luận Facebook", "Tăng LIKE cho bình luận Facebook công khai.", 26000n, 50, 10000000, "0–6 giờ", ServiceStatus.ACTIVE, false],
  ["svc_fb_comment_01", "FB-CMT-01", SocialPlatform.FACEBOOK, "comments", "Bình luận Facebook tùy chỉnh", "Dịch vụ TTC Custom Comments; chờ bổ sung trường nội dung bình luận vào đơn hàng.", 71000n, 10, 10000000, "0–24 giờ", ServiceStatus.DISABLED, false],
  ["svc_fb_page_like_01", "FB-PAGE-LIKE-01", SocialPlatform.FACEBOOK, "likes", "Like Fanpage Facebook", "Tăng lượt thích cho Fanpage Facebook công khai.", 43000n, 50, 10000000, "0–24 giờ", ServiceStatus.ACTIVE, true],
  ["svc_fb_follow_01", "FB-FOLLOW-01", SocialPlatform.FACEBOOK, "followers", "Theo dõi Facebook", "Tăng người theo dõi Facebook bằng TTC.", 31000n, 50, 10000000, "0–24 giờ", ServiceStatus.ACTIVE, true],
  ["svc_fb_follow_vip_01", "FB-FOLLOW-VIP-01", SocialPlatform.FACEBOOK, "followers", "Theo dõi Facebook VIP", "Tăng người theo dõi Facebook VIP.", 45000n, 50, 10000000, "0–24 giờ", ServiceStatus.ACTIVE, true],
  ["svc_fb_group_member_01", "FB-GROUP-MEMBER-01", SocialPlatform.FACEBOOK, "followers", "Thành viên nhóm Facebook", "Tăng thành viên cho nhóm Facebook.", 47500n, 50, 10000000, "0–24 giờ", ServiceStatus.ACTIVE, false],
  ["svc_fb_page_review_01", "FB-PAGE-REVIEW-01", SocialPlatform.FACEBOOK, "comments", "Đánh giá Page Facebook", "Dịch vụ TTC Custom Comments; chờ bổ sung nội dung đánh giá vào đơn hàng.", 59500n, 20, 10000000, "0–24 giờ", ServiceStatus.DISABLED, false],

  ["svc_tt_like_01", "TT-LIKE-01", SocialPlatform.TIKTOK, "likes", "Like video TikTok", "Tăng TYM TikTok chất lượng cao.", 24000n, 50, 10000000, "0–4 giờ", ServiceStatus.ACTIVE, true],
  ["svc_tt_save_01", "TT-SAVE-01", SocialPlatform.TIKTOK, "likes", "Lưu / Yêu thích video TikTok", "Tăng SAVE video TikTok.", 20500n, 50, 10000000, "0–4 giờ", ServiceStatus.ACTIVE, false],
  ["svc_tt_share_01", "TT-SHARE-01", SocialPlatform.TIKTOK, "shares", "Chia sẻ video TikTok", "Tăng SHARE video TikTok.", 25000n, 50, 10000000, "0–4 giờ", ServiceStatus.ACTIVE, false],
  ["svc_tt_view_01", "TT-VIEW-01", SocialPlatform.TIKTOK, "views", "Lượt xem video TikTok", "Tăng VIEW TikTok số lượng lớn.", 6000n, 1000, 10000000, "0–3 giờ", ServiceStatus.ACTIVE, true],
  ["svc_tt_comment_01", "TT-CMT-01", SocialPlatform.TIKTOK, "comments", "Bình luận TikTok tùy chỉnh", "Dịch vụ TTC Custom Comments; chờ bổ sung trường nội dung bình luận vào đơn hàng.", 83000n, 10, 10000000, "0–24 giờ", ServiceStatus.DISABLED, false],
  ["svc_tt_follow_01", "TT-FOLLOW-01", SocialPlatform.TIKTOK, "followers", "Theo dõi TikTok - Chất lượng cao nhất", "Tăng follow TikTok chất lượng cao nhất, ít tụt.", 83000n, 50, 10000000, "0–12 giờ", ServiceStatus.ACTIVE, true],

  ["svc_yt_comment_01", "YT-CMT-01", SocialPlatform.YOUTUBE, "comments", "Bình luận YouTube tùy chỉnh", "Dịch vụ TTC Custom Comments; chờ bổ sung trường nội dung bình luận vào đơn hàng.", 83000n, 15, 10000000, "0–48 giờ", ServiceStatus.DISABLED, false],
  ["svc_google_review_01", "GOOGLE-REVIEW-01", SocialPlatform.GOOGLE, "comments", "Đánh giá Google Maps", "Dịch vụ TTC Custom Comments; chờ bổ sung nội dung đánh giá vào đơn hàng.", 2362500n, 5, 10000000, "0–48 giờ", ServiceStatus.DISABLED, false],

  // Legacy/mock catalog retained as disabled so old orders keep valid foreign keys/history.
  ["svc_ig_follow_01", "IG-FOLLOW-01", SocialPlatform.INSTAGRAM, "followers", "Người theo dõi Instagram", "Legacy catalog - không có mapping TTC hiện tại.", 42000n, 100, 100000, "0–24 giờ", ServiceStatus.DISABLED, false],
  ["svc_ig_like_01", "IG-LIKE-01", SocialPlatform.INSTAGRAM, "likes", "Lượt thích bài viết Instagram", "Legacy catalog - không có mapping TTC hiện tại.", 12000n, 50, 100000, "0–6 giờ", ServiceStatus.DISABLED, false],
  ["svc_ig_view_01", "IG-VIEW-01", SocialPlatform.INSTAGRAM, "views", "Lượt xem Instagram Reels", "Legacy catalog - không có mapping TTC hiện tại.", 4500n, 500, 1000000, "0–12 giờ", ServiceStatus.DISABLED, false],
  ["svc_yt_sub_01", "YT-SUB-01", SocialPlatform.YOUTUBE, "followers", "Người đăng ký YouTube", "Không có dịch vụ Subscriber tương ứng trong TTC API hiện tại.", 168000n, 50, 50000, "1–3 ngày", ServiceStatus.DISABLED, false],
  ["svc_yt_view_01", "YT-VIEW-01", SocialPlatform.YOUTUBE, "views", "Lượt xem video YouTube", "Legacy catalog - không có mapping TTC hiện tại.", 26000n, 500, 1000000, "0–48 giờ", ServiceStatus.DISABLED, false],
  ["svc_th_follow_01", "TH-FOLLOW-01", SocialPlatform.THREADS, "followers", "Người theo dõi Threads", "Legacy catalog - không có mapping TTC hiện tại.", 56000n, 100, 50000, "0–24 giờ", ServiceStatus.DISABLED, false],
  ["svc_th_like_01", "TH-LIKE-01", SocialPlatform.THREADS, "likes", "Lượt thích bài viết Threads", "Legacy catalog - không có mapping TTC hiện tại.", 17000n, 50, 50000, "0–8 giờ", ServiceStatus.DISABLED, false]
] as const;

async function main() {
  for (const [id, name, sortOrder] of categories) {
    await db.serviceCategory.upsert({ where: { id }, update: { name, sortOrder }, create: { id, name, sortOrder } });
  }
  for (const [id, code, platform, categoryId, name, description, ratePerThousandMinor, min, max, averageTime, status, popular] of services) {
    await db.service.upsert({
      where: { id },
      update: { code, platform, categoryId, name, description, ratePerThousandMinor, min, max, averageTime, status, popular },
      create: { id, code, platform, categoryId, name, description, ratePerThousandMinor, min, max, averageTime, status, popular }
    });
  }

  const depositMethods = [
    {
      id: "bank-transfer", name: "Chuyển khoản ngân hàng", type: DepositMethodType.BANK,
      description: "Chuyển khoản đến tài khoản ngân hàng đã cấu hình và sử dụng đúng nội dung chuyển khoản được tạo.",
      minMinor: 50000n, maxMinor: 50000000n, feeLabel: "Không có phí nền tảng", enabled: true,
      instructions: ["Tạo yêu cầu nạp tiền.", "Chuyển đúng số tiền và dùng nội dung chuyển khoản được tạo.", "Yêu cầu ở trạng thái đang chờ cho đến khi được xác nhận."]
    },
    {
      id: "vietqr", name: "VietQR", type: DepositMethodType.QR,
      description: "Tạo yêu cầu thanh toán bằng mã QR theo cấu hình hiện tại.",
      minMinor: 50000n, maxMinor: 20000000n, feeLabel: "Sẽ cấu hình sau", enabled: true,
      instructions: ["Chọn số tiền cần nạp.", "Mã QR sẽ được tạo từ cấu hình thanh toán ở Work payment sau.", "Xác nhận tự động hiện chưa khả dụng."]
    },
    {
      id: "manual-review", name: "Duyệt thủ công", type: DepositMethodType.MANUAL,
      description: "Chỉ sử dụng khi có hướng dẫn từ bộ phận hỗ trợ.",
      minMinor: 100000n, maxMinor: 10000000n, feeLabel: "Không thu phí", enabled: false,
      instructions: ["Liên hệ bộ phận hỗ trợ trước khi sử dụng phương thức này."]
    }
  ];
  for (const method of depositMethods) {
    await db.depositMethod.upsert({ where: { id: method.id }, update: method, create: method });
  }

  await db.systemSetting.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      siteName: "Tương Tác Pro",
      supportEmail: "support@example.com",
      maintenanceMode: false,
      minimumDepositMinor: 50000n,
      orderCreationEnabled: true,
      supportEnabled: true
    }
  });

  // TTC API v2 base URL is public provider metadata. Credentials remain environment-only.
  const ttcBaseUrl = (process.env.TTC_API_BASE_URL ?? "https://tuongtaccheo.com/api/v2").trim();
  await db.provider.upsert({
    where: { code: "TTC" },
    update: { name: "Tương Tác Chéo", baseUrl: ttcBaseUrl },
    create: {
      code: "TTC",
      name: "Tương Tác Chéo",
      status: ProviderStatus.DISABLED,
      health: ProviderHealth.UNKNOWN,
      enabled: false,
      priority: 100,
      timeoutMs: 10000,
      baseUrl: ttcBaseUrl
    }
  });

  const developmentSeed = resolveDevelopmentSeedConfig();
  if (developmentSeed.enabled) {
    const email = developmentSeed.customerEmail;
    const password = developmentSeed.customerPassword;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const user = await db.user.upsert({
      where: { email },
      update: { name: "Nguyễn Minh", passwordHash, status: UserStatus.ACTIVE, role: UserRole.CUSTOMER },
      create: { email, passwordHash, name: "Nguyễn Minh", phone: "0901234567", status: UserStatus.ACTIVE, role: UserRole.CUSTOMER }
    });
    await db.notificationPreference.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, orderUpdates: true, walletUpdates: true, promotions: false, supportReplies: true }
    });
    const wallet = await db.wallet.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, balanceMinor: 0n, reservedMinor: 0n, currency: "VND" }
    });
    const seedKey = "seed:development-opening-balance";
    const openingBalance = 1250000n;
    const existingSeedCredit = await db.walletTransaction.findUnique({
      where: { walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey: seedKey } }
    });
    if (!existingSeedCredit) {
      await db.$transaction(async (tx) => {
        const current = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        await tx.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: { increment: openingBalance } } });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: WalletTransactionType.ADJUSTMENT,
            status: WalletTransactionStatus.COMPLETED,
            amountMinor: openingBalance,
            balanceBeforeMinor: current.balanceMinor,
            balanceAfterMinor: current.balanceMinor + openingBalance,
            referenceType: "SEED",
            referenceId: "development-opening-balance",
            description: "Số dư khởi tạo tài khoản development",
            idempotencyKey: seedKey
          }
        });
      });
    }

    const adminEmail = developmentSeed.adminEmail;
    const adminPassword = developmentSeed.adminPassword;
    const adminPasswordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
    await db.user.upsert({
      where: { email: adminEmail },
      update: { name: "Tương Tác Pro Admin", passwordHash: adminPasswordHash, status: UserStatus.ACTIVE, role: UserRole.ADMIN },
      create: { email: adminEmail, passwordHash: adminPasswordHash, name: "Tương Tác Pro Admin", status: UserStatus.ACTIVE, role: UserRole.ADMIN }
    });

    const secondEmail = developmentSeed.secondaryEmail;
    const secondPassword = developmentSeed.secondaryPassword;
    const secondHash = await argon2.hash(secondPassword, { type: argon2.argon2id });
    const secondUser = await db.user.upsert({
      where: { email: secondEmail },
      update: { name: "Trần Lan", passwordHash: secondHash, status: UserStatus.ACTIVE, role: UserRole.CUSTOMER },
      create: { email: secondEmail, passwordHash: secondHash, name: "Trần Lan", phone: "0902222333", status: UserStatus.ACTIVE, role: UserRole.CUSTOMER }
    });
    await db.notificationPreference.upsert({
      where: { userId: secondUser.id },
      update: {},
      create: { userId: secondUser.id, orderUpdates: true, walletUpdates: true, promotions: false, supportReplies: true }
    });
    await db.wallet.upsert({ where: { userId: secondUser.id }, update: {}, create: { userId: secondUser.id, currency: "VND" } });

    const sampleOrderPublicId = "TT-SEED-0001";
    const existingOrder = await db.order.findUnique({ where: { publicId: sampleOrderPublicId } });
    if (!existingOrder) {
      await db.$transaction(async (tx) => {
        const currentWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        const charge = 3100n;
        const order = await tx.order.create({
          data: {
            publicId: sampleOrderPublicId,
            userId: user.id,
            serviceId: "svc_fb_follow_01",
            targetUrl: "https://example.com/development-profile",
            quantity: 100,
            chargeMinor: charge,
            remaining: 100,
            status: OrderStatus.PENDING,
            idempotencyKey: "seed:sample-order",
            requestFingerprint: "seed-sample-order"
          }
        });
        await tx.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: { decrement: charge } } });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id, type: WalletTransactionType.PURCHASE, status: WalletTransactionStatus.COMPLETED, amountMinor: -charge,
            balanceBeforeMinor: currentWallet.balanceMinor, balanceAfterMinor: currentWallet.balanceMinor - charge, referenceType: "ORDER",
            referenceId: sampleOrderPublicId, description: `Đơn hàng development ${sampleOrderPublicId}`, idempotencyKey: "seed:sample-order-purchase"
          }
        });
        await tx.orderLog.create({ data: { orderId: order.id, toStatus: OrderStatus.PENDING, message: "Đơn mẫu development đang chờ xử lý." } });
      });
    }

    const sampleDepositPublicId = "DEP-SEED-0001";
    if (!await db.deposit.findUnique({ where: { publicId: sampleDepositPublicId } })) {
      await db.$transaction(async (tx) => {
        const currentWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
        await tx.deposit.create({
          data: { publicId: sampleDepositPublicId, userId: user.id, methodId: "bank-transfer", amountMinor: 200000n, status: DepositStatus.PENDING, idempotencyKey: "seed:sample-deposit" }
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id, type: WalletTransactionType.DEPOSIT, status: WalletTransactionStatus.PENDING, amountMinor: 200000n,
            balanceBeforeMinor: currentWallet.balanceMinor, balanceAfterMinor: currentWallet.balanceMinor, referenceType: "DEPOSIT",
            referenceId: sampleDepositPublicId, description: `Yêu cầu nạp tiền development ${sampleDepositPublicId}`, idempotencyKey: "seed:sample-deposit-ledger"
          }
        });
      });
    }

    const sampleTicketPublicId = "SUP-SEED-0001";
    if (!await db.supportTicket.findUnique({ where: { publicId: sampleTicketPublicId } })) {
      await db.supportTicket.create({
        data: {
          publicId: sampleTicketPublicId, userId: user.id, subject: "Yêu cầu hỗ trợ development", category: "general", status: SupportTicketStatus.WAITING_SUPPORT,
          messages: { create: { senderType: SupportSenderType.CUSTOMER, senderUserId: user.id, body: "Đây là yêu cầu hỗ trợ mẫu dùng cho Work 05 development." } }
        }
      });
    }
  }
}

main()
  .then(async () => { await db.$disconnect(); })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exitCode = 1;
  });
