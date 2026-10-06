import {
  DepositStatus,
  OrderStatus,
  Prisma,
  ProviderJobStatus,
  ProviderSubmissionState,
  ServiceStatus,
  SocialPlatform,
  SupportTicketStatus,
  UserRole,
  UserStatus,
  WalletTransactionStatus,
  WalletTransactionType,
  getDb
} from "@tuong-tac-pro/db";
import { parseProviderRuntimeConfig } from "@tuong-tac-pro/providers";
import { moneyToSafeNumber } from "@tuong-tac-pro/domain";
import type {
  AdminAnalytics,
  AdminAuditLog,
  AdminCategory,
  AdminDeposit,
  AdminOrder,
  AdminOrderDetail,
  AdminPage,
  AdminProvider,
  AdminProviderDetail,
  AdminProviderService,
  AdminService,
  AdminServiceDetail,
  AdminSettings,
  AdminSupportThread,
  AdminSupportTicket,
  AdminTransaction,
  AdminUserDetail,
  AdminUserListItem,
  AdminWallet
} from "@/domain/admin";

function pageResult<T>(items: T[], page: number, pageSize: number, total: number): AdminPage<T> {
  return { items, page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

function dateStart(range: string | undefined) {
  if (!range || range === "all") return undefined;
  const now = new Date();
  if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : 0;
  return days ? new Date(Date.now() - days * 86_400_000) : undefined;
}

function platformName(platform: SocialPlatform) {
  return platform === SocialPlatform.FACEBOOK ? "Facebook"
    : platform === SocialPlatform.TIKTOK ? "TikTok"
      : platform === SocialPlatform.INSTAGRAM ? "Instagram"
        : platform === SocialPlatform.YOUTUBE ? "YouTube" : "Threads";
}

function transactionMap(item: {
  id: string;
  type: WalletTransactionType;
  status: WalletTransactionStatus;
  amountMinor: bigint;
  balanceBeforeMinor: bigint;
  balanceAfterMinor: bigint;
  referenceType: string | null;
  referenceId: string | null;
  description: string;
  reason: string | null;
  createdAt: Date;
  wallet: { user: { name: string; email: string } };
  adminUser: { name: string } | null;
}): AdminTransaction {
  return {
    id: item.id,
    customerName: item.wallet.user.name,
    customerEmail: item.wallet.user.email,
    type: item.type,
    status: item.status,
    amount: moneyToSafeNumber(item.amountMinor),
    balanceBefore: moneyToSafeNumber(item.balanceBeforeMinor),
    balanceAfter: moneyToSafeNumber(item.balanceAfterMinor),
    referenceType: item.referenceType ?? "",
    referenceId: item.referenceId ?? "",
    description: item.description,
    adminName: item.adminUser?.name ?? "",
    reason: item.reason ?? "",
    createdAt: item.createdAt.toISOString()
  };
}

function orderMap(item: {
  publicId: string; userId: string; targetUrl: string; quantity: number; chargeMinor: bigint; startCount: number | null; remaining: number;
  status: OrderStatus; createdAt: Date; updatedAt: Date;
  user: { name: string; email: string };
  service: { id: string; name: string; code: string; platform: SocialPlatform };
}): AdminOrder {
  return {
    id: item.publicId,
    customerId: item.userId,
    customerName: item.user.name,
    customerEmail: item.user.email,
    serviceId: item.service.id,
    serviceName: item.service.name,
    serviceCode: item.service.code,
    platform: item.service.platform,
    targetUrl: item.targetUrl,
    quantity: item.quantity,
    charge: moneyToSafeNumber(item.chargeMinor),
    startCount: item.startCount,
    remaining: item.remaining,
    status: item.status,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString()
  };
}

function serviceMap(item: {
  id: string; code: string; name: string; description: string; platform: SocialPlatform; categoryId: string; ratePerThousandMinor: bigint;
  min: number; max: number; averageTime: string; status: ServiceStatus; popular: boolean; createdAt: Date; updatedAt: Date;
  category: { name: string }; _count: { orders: number };
}): AdminService {
  return {
    id: item.id,
    code: item.code,
    name: item.name,
    description: item.description,
    platform: item.platform,
    categoryId: item.categoryId,
    categoryName: item.category.name,
    ratePerThousand: moneyToSafeNumber(item.ratePerThousandMinor),
    min: item.min,
    max: item.max,
    averageTime: item.averageTime,
    status: item.status,
    popular: item.popular,
    orderCount: item._count.orders,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString()
  };
}

function depositMap(item: {
  publicId: string; userId: string; amountMinor: bigint; status: DepositStatus; reference: string | null; createdAt: Date; updatedAt: Date;
  user: { name: string; email: string }; method: { id: string; name: string };
}): AdminDeposit {
  return {
    id: item.publicId,
    customerId: item.userId,
    customerName: item.user.name,
    customerEmail: item.user.email,
    methodId: item.method.id,
    methodName: item.method.name,
    amount: moneyToSafeNumber(item.amountMinor),
    status: item.status,
    reference: item.reference ?? "",
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString()
  };
}

export async function readAdminDashboard() {
  const db = getDb();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [
    customers, activeUsers, suspendedUsers, ordersToday, pendingOrders, processingOrders, completedOrders, failedOrders,
    spend, deposits, pendingDeposits, walletLiability, openSupportTickets, analytics
  ] = await Promise.all([
    db.user.count({ where: { role: UserRole.CUSTOMER } }),
    db.user.count({ where: { role: UserRole.CUSTOMER, status: UserStatus.ACTIVE } }),
    db.user.count({ where: { role: UserRole.CUSTOMER, status: UserStatus.SUSPENDED } }),
    db.order.count({ where: { createdAt: { gte: today } } }),
    db.order.count({ where: { status: OrderStatus.PENDING } }),
    db.order.count({ where: { status: { in: [OrderStatus.VALIDATING, OrderStatus.SUBMITTED, OrderStatus.PROCESSING] } } }),
    db.order.count({ where: { status: OrderStatus.COMPLETED } }),
    db.order.count({ where: { status: OrderStatus.FAILED } }),
    db.walletTransaction.aggregate({ where: { type: WalletTransactionType.PURCHASE, status: WalletTransactionStatus.COMPLETED }, _sum: { amountMinor: true } }),
    db.deposit.aggregate({ where: { status: DepositStatus.CONFIRMED }, _sum: { amountMinor: true } }),
    db.deposit.count({ where: { status: DepositStatus.PENDING } }),
    db.wallet.aggregate({ _sum: { balanceMinor: true } }),
    db.supportTicket.count({ where: { status: { in: [SupportTicketStatus.OPEN, SupportTicketStatus.WAITING_SUPPORT, SupportTicketStatus.WAITING_CUSTOMER] } } }),
    readAdminAnalytics(30)
  ]);
  return {
    metrics: {
      customers,
      activeUsers,
      suspendedUsers,
      ordersToday,
      pendingOrders,
      processingOrders,
      completedOrders,
      failedOrders,
      totalCustomerSpend: Math.abs(moneyToSafeNumber(spend._sum.amountMinor ?? 0n)),
      confirmedDepositVolume: moneyToSafeNumber(deposits._sum.amountMinor ?? 0n),
      pendingDeposits,
      walletLiability: moneyToSafeNumber(walletLiability._sum.balanceMinor ?? 0n),
      openSupportTickets
    },
    analytics
  };
}

export async function readAdminUsers(filters: { search?: string; status?: "ACTIVE" | "SUSPENDED" | "all"; sort?: string; page: number; pageSize: number }) {
  const db = getDb();
  const where: Prisma.UserWhereInput = { role: UserRole.CUSTOMER };
  if (filters.status && filters.status !== "all") where.status = filters.status === "ACTIVE" ? UserStatus.ACTIVE : UserStatus.SUSPENDED;
  if (filters.search) {
    const searchConditions: Prisma.UserWhereInput[] = [
      { name: { contains: filters.search, mode: "insensitive" } },
      { email: { contains: filters.search, mode: "insensitive" } },
      { phone: { contains: filters.search, mode: "insensitive" } }
    ];
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(filters.search)) {
      searchConditions.push({ id: { equals: filters.search } });
    }
    where.OR = searchConditions;
  }
  const orderBy: Prisma.UserOrderByWithRelationInput[] = filters.sort === "oldest" ? [{ createdAt: "asc" }]
    : filters.sort === "name" ? [{ name: "asc" }]
      : [{ createdAt: "desc" }];
  const [total, rows] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      include: { wallet: true, _count: { select: { orders: true } } },
      orderBy,
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize
    })
  ]);
  const items: AdminUserListItem[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? "",
    status: row.status === UserStatus.SUSPENDED ? "SUSPENDED" : "ACTIVE",
    walletBalance: moneyToSafeNumber(row.wallet?.balanceMinor ?? 0n),
    orderCount: row._count.orders,
    joinedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivity: row.updatedAt.toISOString()
  }));
  return pageResult(items, filters.page, filters.pageSize, total);
}

export async function readAdminUser(userId: string): Promise<AdminUserDetail | null> {
  const user = await getDb().user.findFirst({
    where: { id: userId, role: UserRole.CUSTOMER },
    include: {
      wallet: {
        include: {
          transactions: {
            orderBy: { createdAt: "desc" }, take: 50,
            include: { adminUser: { select: { name: true } }, wallet: { include: { user: { select: { name: true, email: true } } } } }
          }
        }
      },
      orders: { orderBy: { createdAt: "desc" }, take: 30, include: { service: true, user: { select: { name: true, email: true } } } },
      deposits: { orderBy: { createdAt: "desc" }, take: 30, include: { method: true, user: { select: { name: true, email: true } } } },
      supportTickets: { orderBy: { updatedAt: "desc" }, take: 30, include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } } },
      _count: { select: { orders: true } }
    }
  });
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone ?? "",
    role: user.role,
    status: user.status === UserStatus.SUSPENDED ? "SUSPENDED" : "ACTIVE",
    walletBalance: moneyToSafeNumber(user.wallet?.balanceMinor ?? 0n),
    reservedBalance: moneyToSafeNumber(user.wallet?.reservedMinor ?? 0n),
    walletId: user.wallet?.id ?? null,
    orderCount: user._count.orders,
    joinedAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastActivity: user.updatedAt.toISOString(),
    transactions: user.wallet?.transactions.map(transactionMap) ?? [],
    orders: user.orders.map(orderMap),
    deposits: user.deposits.map(depositMap),
    tickets: user.supportTickets.map((ticket) => ({
      id: ticket.publicId, customerId: user.id, customerName: user.name, customerEmail: user.email, subject: ticket.subject, category: ticket.category,
      status: ticket.status, createdAt: ticket.createdAt.toISOString(), updatedAt: ticket.updatedAt.toISOString(), lastMessage: ticket.messages[0]?.body ?? ""
    }))
  };
}

export async function readAdminWallets(filters: { search?: string; page: number; pageSize: number }) {
  const where: Prisma.WalletWhereInput = { user: { role: UserRole.CUSTOMER } };
  if (filters.search) where.user = { role: UserRole.CUSTOMER, OR: [{ name: { contains: filters.search, mode: "insensitive" } }, { email: { contains: filters.search, mode: "insensitive" } }] };
  const db = getDb();
  const [total, rows] = await Promise.all([
    db.wallet.count({ where }),
    db.wallet.findMany({ where, include: { user: true }, orderBy: { updatedAt: "desc" }, skip: (filters.page - 1) * filters.pageSize, take: filters.pageSize })
  ]);
  const items: AdminWallet[] = rows.map((row) => ({
    id: row.id, userId: row.userId, customerName: row.user.name, email: row.user.email, balance: moneyToSafeNumber(row.balanceMinor),
    reserved: moneyToSafeNumber(row.reservedMinor), currency: row.currency, updatedAt: row.updatedAt.toISOString()
  }));
  return pageResult(items, filters.page, filters.pageSize, total);
}

export async function readAdminTransactions(filters: { search?: string; type?: string; status?: string; page: number; pageSize: number }) {
  const where: Prisma.WalletTransactionWhereInput = { wallet: { user: { role: UserRole.CUSTOMER } } };
  if (filters.type && filters.type !== "all" && Object.values(WalletTransactionType).includes(filters.type as WalletTransactionType)) where.type = filters.type as WalletTransactionType;
  if (filters.status && filters.status !== "all" && Object.values(WalletTransactionStatus).includes(filters.status as WalletTransactionStatus)) where.status = filters.status as WalletTransactionStatus;
  if (filters.search) {
    where.OR = [
      { description: { contains: filters.search, mode: "insensitive" } }, { referenceId: { contains: filters.search, mode: "insensitive" } },
      { wallet: { user: { OR: [{ name: { contains: filters.search, mode: "insensitive" } }, { email: { contains: filters.search, mode: "insensitive" } }] } } }
    ];
  }
  const db = getDb();
  const [total, rows] = await Promise.all([
    db.walletTransaction.count({ where }),
    db.walletTransaction.findMany({
      where,
      include: { wallet: { include: { user: { select: { name: true, email: true } } } }, adminUser: { select: { name: true } } },
      orderBy: { createdAt: "desc" }, skip: (filters.page - 1) * filters.pageSize, take: filters.pageSize
    })
  ]);
  return pageResult(rows.map(transactionMap), filters.page, filters.pageSize, total);
}

export async function readAdminOrders(filters: { search?: string; customer?: string; serviceId?: string; platform?: string; status?: string; dateRange?: string; page: number; pageSize: number }) {
  const where: Prisma.OrderWhereInput = {};
  if (filters.status && filters.status !== "all" && Object.values(OrderStatus).includes(filters.status as OrderStatus)) where.status = filters.status as OrderStatus;
  if (filters.platform && filters.platform !== "all" && Object.values(SocialPlatform).includes(filters.platform as SocialPlatform)) where.service = { platform: filters.platform as SocialPlatform };
  if (filters.serviceId) where.serviceId = filters.serviceId;
  if (filters.customer) where.user = { OR: [{ name: { contains: filters.customer, mode: "insensitive" } }, { email: { contains: filters.customer, mode: "insensitive" } }] };
  if (filters.search) where.OR = [{ publicId: { contains: filters.search, mode: "insensitive" } }, { targetUrl: { contains: filters.search, mode: "insensitive" } }, { service: { name: { contains: filters.search, mode: "insensitive" } } }];
  const start = dateStart(filters.dateRange); if (start) where.createdAt = { gte: start };
  const db = getDb();
  const [total, rows] = await Promise.all([
    db.order.count({ where }),
    db.order.findMany({ where, include: { user: { select: { name: true, email: true } }, service: true }, orderBy: { createdAt: "desc" }, skip: (filters.page - 1) * filters.pageSize, take: filters.pageSize })
  ]);
  return pageResult(rows.map(orderMap), filters.page, filters.pageSize, total);
}

export async function readAdminOrder(publicId: string): Promise<AdminOrderDetail | null> {
  const db = getDb();
  const order = await db.order.findUnique({
    where: { publicId },
    include: {
      user: { select: { name: true, email: true } },
      service: true,
      logs: { orderBy: { createdAt: "asc" } },
      providerOrder: { include: { provider: true, providerService: true } }
    }
  });
  if (!order) return null;
  const wallet = await db.wallet.findUnique({ where: { userId: order.userId } });
  const transactions = wallet ? await db.walletTransaction.findMany({
    where: { walletId: wallet.id, referenceType: "ORDER", referenceId: order.publicId },
    include: { wallet: { include: { user: { select: { name: true, email: true } } } }, adminUser: { select: { name: true } } },
    orderBy: { createdAt: "asc" }
  }) : [];
  return {
    ...orderMap(order),
    timeline: order.logs.map((log) => ({ fromStatus: log.fromStatus, toStatus: log.toStatus, message: log.message, createdAt: log.createdAt.toISOString() })),
    walletTransactions: transactions.map(transactionMap),
    provider: order.providerOrder ? {
      providerName: order.providerOrder.provider.name,
      providerServiceName: order.providerOrder.providerService.name,
      externalOrderId: order.providerOrder.externalOrderId ?? "",
      submissionState: order.providerOrder.submissionState,
      providerStatus: order.providerOrder.status,
      attempts: order.providerOrder.attemptCount,
      submittedAt: order.providerOrder.submittedAt?.toISOString() ?? null,
      lastCheckedAt: order.providerOrder.lastCheckedAt?.toISOString() ?? null,
      providerCost: moneyToSafeNumber(order.providerOrder.providerCostMinor),
      customerCharge: moneyToSafeNumber(order.providerOrder.customerChargeMinor),
      grossMargin: moneyToSafeNumber(order.providerOrder.grossMarginMinor)
    } : null
  };
}

export async function readAdminServices(filters: { search?: string; platform?: string; category?: string; status?: string; page: number; pageSize: number }) {
  const where: Prisma.ServiceWhereInput = {};
  if (filters.platform && filters.platform !== "all" && Object.values(SocialPlatform).includes(filters.platform as SocialPlatform)) where.platform = filters.platform as SocialPlatform;
  if (filters.status && filters.status !== "all" && Object.values(ServiceStatus).includes(filters.status as ServiceStatus)) where.status = filters.status as ServiceStatus;
  if (filters.category) where.categoryId = filters.category;
  if (filters.search) where.OR = [{ code: { contains: filters.search, mode: "insensitive" } }, { name: { contains: filters.search, mode: "insensitive" } }];
  const db = getDb();
  const [total, rows] = await Promise.all([
    db.service.count({ where }),
    db.service.findMany({ where, include: { category: true, _count: { select: { orders: true } } }, orderBy: [{ platform: "asc" }, { name: "asc" }], skip: (filters.page - 1) * filters.pageSize, take: filters.pageSize })
  ]);
  return pageResult(rows.map(serviceMap), filters.page, filters.pageSize, total);
}

export async function readAdminService(serviceId: string): Promise<AdminServiceDetail | null> {
  const item = await getDb().service.findUnique({
    where: { id: serviceId },
    include: {
      category: true, _count: { select: { orders: true } },
      priceHistory: { orderBy: { createdAt: "desc" }, take: 50, include: { adminUser: { select: { name: true } } } }
    }
  });
  if (!item) return null;
  return {
    ...serviceMap(item),
    priceHistory: item.priceHistory.map((history) => ({
      previousRate: moneyToSafeNumber(history.previousRateMinor), newRate: moneyToSafeNumber(history.newRateMinor), adminName: history.adminUser.name,
      reason: history.reason ?? "", createdAt: history.createdAt.toISOString()
    }))
  };
}

export async function readAdminCategories(): Promise<AdminCategory[]> {
  const rows = await getDb().serviceCategory.findMany({ include: { _count: { select: { services: true } } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return rows.map((row) => ({ id: row.id, name: row.name, sortOrder: row.sortOrder, enabled: row.enabled, serviceCount: row._count.services, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
}

export async function readAdminDeposits(filters: { search?: string; status?: string; dateRange?: string; page: number; pageSize: number }) {
  const where: Prisma.DepositWhereInput = {};
  if (filters.status && filters.status !== "all" && Object.values(DepositStatus).includes(filters.status as DepositStatus)) where.status = filters.status as DepositStatus;
  if (filters.search) where.OR = [{ publicId: { contains: filters.search, mode: "insensitive" } }, { reference: { contains: filters.search, mode: "insensitive" } }, { method: { name: { contains: filters.search, mode: "insensitive" } } }, { user: { OR: [{ name: { contains: filters.search, mode: "insensitive" } }, { email: { contains: filters.search, mode: "insensitive" } }] } }];
  const start = dateStart(filters.dateRange); if (start) where.createdAt = { gte: start };
  const db = getDb();
  const [total, rows] = await Promise.all([
    db.deposit.count({ where }),
    db.deposit.findMany({ where, include: { user: { select: { name: true, email: true } }, method: true }, orderBy: { createdAt: "desc" }, skip: (filters.page - 1) * filters.pageSize, take: filters.pageSize })
  ]);
  return pageResult(rows.map(depositMap), filters.page, filters.pageSize, total);
}

export async function readAdminDeposit(publicId: string) {
  const item = await getDb().deposit.findUnique({ where: { publicId }, include: { user: { select: { name: true, email: true } }, method: true } });
  return item ? depositMap(item) : null;
}

export async function readAdminSupportTickets(filters: { search?: string; status?: string; page: number; pageSize: number }) {
  const where: Prisma.SupportTicketWhereInput = {};
  if (filters.status && filters.status !== "all" && Object.values(SupportTicketStatus).includes(filters.status as SupportTicketStatus)) where.status = filters.status as SupportTicketStatus;
  if (filters.search) where.OR = [{ publicId: { contains: filters.search, mode: "insensitive" } }, { subject: { contains: filters.search, mode: "insensitive" } }, { user: { OR: [{ name: { contains: filters.search, mode: "insensitive" } }, { email: { contains: filters.search, mode: "insensitive" } }] } }];
  const db = getDb();
  const [total, rows] = await Promise.all([
    db.supportTicket.count({ where }),
    db.supportTicket.findMany({ where, include: { user: { select: { name: true, email: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1 } }, orderBy: { updatedAt: "desc" }, skip: (filters.page - 1) * filters.pageSize, take: filters.pageSize })
  ]);
  const items: AdminSupportTicket[] = rows.map((ticket) => ({
    id: ticket.publicId, customerId: ticket.userId, customerName: ticket.user.name, customerEmail: ticket.user.email, subject: ticket.subject, category: ticket.category,
    status: ticket.status, createdAt: ticket.createdAt.toISOString(), updatedAt: ticket.updatedAt.toISOString(), lastMessage: ticket.messages[0]?.body ?? ""
  }));
  return pageResult(items, filters.page, filters.pageSize, total);
}

export async function readAdminSupportThread(publicId: string): Promise<AdminSupportThread | null> {
  const ticket = await getDb().supportTicket.findUnique({
    where: { publicId },
    include: { user: { select: { name: true, email: true } }, messages: { orderBy: { createdAt: "asc" }, include: { senderUser: { select: { name: true } } } } }
  });
  if (!ticket) return null;
  return {
    ticket: {
      id: ticket.publicId, customerId: ticket.userId, customerName: ticket.user.name, customerEmail: ticket.user.email, subject: ticket.subject, category: ticket.category,
      status: ticket.status, createdAt: ticket.createdAt.toISOString(), updatedAt: ticket.updatedAt.toISOString(), lastMessage: ticket.messages.at(-1)?.body ?? ""
    },
    messages: ticket.messages.map((message) => ({
      id: message.id, senderType: message.senderType, senderName: message.senderUser?.name ?? (message.senderType === "ADMIN" ? "Quản trị viên" : ticket.user.name),
      body: message.body, createdAt: message.createdAt.toISOString()
    }))
  };
}

export async function readAdminAnalytics(days: 7 | 30): Promise<AdminAnalytics> {
  const db = getDb();
  const start = new Date(Date.now() - (days - 1) * 86_400_000); start.setHours(0, 0, 0, 0);
  const [orders, users, deposits, refunds, wallets, providerOrders] = await Promise.all([
    db.order.findMany({ where: { createdAt: { gte: start } }, include: { service: true } }),
    db.user.findMany({ where: { role: UserRole.CUSTOMER, createdAt: { gte: start } }, select: { createdAt: true } }),
    db.deposit.findMany({ where: { status: DepositStatus.CONFIRMED, updatedAt: { gte: start } }, select: { amountMinor: true, updatedAt: true } }),
    db.walletTransaction.findMany({ where: { type: WalletTransactionType.REFUND, status: WalletTransactionStatus.COMPLETED, createdAt: { gte: start } }, select: { amountMinor: true, createdAt: true } }),
    db.wallet.aggregate({ _sum: { balanceMinor: true } }),
    db.providerOrder.findMany({ where: { createdAt: { gte: start }, submissionState: ProviderSubmissionState.ACCEPTED }, include: { provider: { select: { name: true } } } })
  ]);
  const byDate = new Map<string, { date: string; orders: number; customerSpend: number; newCustomers: number; deposits: number; refunds: number }>();
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(start.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
    byDate.set(date, { date, orders: 0, customerSpend: 0, newCustomers: 0, deposits: 0, refunds: 0 });
  }
  for (const order of orders) {
    const bucket = byDate.get(order.createdAt.toISOString().slice(0, 10)); if (!bucket) continue;
    bucket.orders += 1; bucket.customerSpend += moneyToSafeNumber(order.chargeMinor);
  }
  for (const user of users) { const bucket = byDate.get(user.createdAt.toISOString().slice(0, 10)); if (bucket) bucket.newCustomers += 1; }
  for (const deposit of deposits) { const bucket = byDate.get(deposit.updatedAt.toISOString().slice(0, 10)); if (bucket) bucket.deposits += moneyToSafeNumber(deposit.amountMinor); }
  for (const refund of refunds) { const bucket = byDate.get(refund.createdAt.toISOString().slice(0, 10)); if (bucket) bucket.refunds += moneyToSafeNumber(refund.amountMinor); }
  const platforms = new Map<SocialPlatform, number>();
  const serviceMapData = new Map<string, { id: string; name: string; orders: number; customerSpend: number }>();
  const statuses = new Map<OrderStatus, number>();
  for (const order of orders) {
    platforms.set(order.service.platform, (platforms.get(order.service.platform) ?? 0) + 1);
    const service = serviceMapData.get(order.service.id) ?? { id: order.service.id, name: order.service.name, orders: 0, customerSpend: 0 };
    service.orders += 1; service.customerSpend += moneyToSafeNumber(order.chargeMinor); serviceMapData.set(order.service.id, service);
    statuses.set(order.status, (statuses.get(order.status) ?? 0) + 1);
  }
  return {
    rangeDays: days,
    daily: [...byDate.values()],
    platformDistribution: [...platforms.entries()].map(([platform, count]) => ({ label: platformName(platform), count })).sort((a, b) => b.count - a.count),
    topServices: [...serviceMapData.values()].sort((a, b) => b.orders - a.orders).slice(0, 8),
    orderStatusDistribution: [...statuses.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    walletLiability: moneyToSafeNumber(wallets._sum.balanceMinor ?? 0n),
    providerEconomics: (() => {
      const byProvider = new Map<string, { provider: string; orders: number; providerCost: number; grossMargin: number }>();
      let customerCharge = 0; let providerCost = 0; let grossMarginValue = 0;
      for (const item of providerOrders) {
        const charge = moneyToSafeNumber(item.customerChargeMinor);
        const cost = moneyToSafeNumber(item.providerCostMinor);
        const margin = moneyToSafeNumber(item.grossMarginMinor);
        customerCharge += charge; providerCost += cost; grossMarginValue += margin;
        const current = byProvider.get(item.provider.name) ?? { provider: item.provider.name, orders: 0, providerCost: 0, grossMargin: 0 };
        current.orders += 1; current.providerCost += cost; current.grossMargin += margin; byProvider.set(item.provider.name, current);
      }
      return { orderCount: providerOrders.length, customerCharge, providerCost, grossMargin: grossMarginValue, byProvider: [...byProvider.values()].sort((a, b) => b.orders - a.orders) };
    })()
  };
}

export async function readAdminAuditLogs(filters: { search?: string; action?: string; entityType?: string; admin?: string; adminUserId?: string; dateRange?: string; page: number; pageSize: number }) {
  const where: Prisma.AdminAuditLogWhereInput = {};
  if (filters.action) where.action = filters.action;
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.adminUserId) where.adminUserId = filters.adminUserId;
  if (filters.admin) where.adminUser = { OR: [{ name: { contains: filters.admin, mode: "insensitive" } }, { email: { contains: filters.admin, mode: "insensitive" } }] };
  const start = dateStart(filters.dateRange); if (start) where.createdAt = { gte: start };
  if (filters.search) where.OR = [{ entityId: { contains: filters.search, mode: "insensitive" } }, { action: { contains: filters.search, mode: "insensitive" } }, { entityType: { contains: filters.search, mode: "insensitive" } }];
  const db = getDb();
  const [total, rows] = await Promise.all([
    db.adminAuditLog.count({ where }),
    db.adminAuditLog.findMany({ where, include: { adminUser: { select: { name: true } } }, orderBy: { createdAt: "desc" }, skip: (filters.page - 1) * filters.pageSize, take: filters.pageSize })
  ]);
  const items: AdminAuditLog[] = rows.map((row) => ({
    id: row.id, timestamp: row.createdAt.toISOString(), adminId: row.adminUserId, adminName: row.adminUser.name, action: row.action,
    entityType: row.entityType, entityId: row.entityId, before: row.before, after: row.after, metadata: row.metadata, ipAddress: row.ipAddress ?? ""
  }));
  return pageResult(items, filters.page, filters.pageSize, total);
}

export async function readAdminSettings(): Promise<AdminSettings> {
  const row = await getDb().systemSetting.upsert({
    where: { id: "default" }, update: {},
    create: { id: "default", siteName: "Tương Tác Pro", supportEmail: "support@example.com", maintenanceMode: false, minimumDepositMinor: 50000n, orderCreationEnabled: true, supportEnabled: true }
  });
  return {
    siteName: row.siteName, supportEmail: row.supportEmail, maintenanceMode: row.maintenanceMode, minimumDeposit: moneyToSafeNumber(row.minimumDepositMinor),
    orderCreationEnabled: row.orderCreationEnabled, supportEnabled: row.supportEnabled, updatedAt: row.updatedAt.toISOString()
  };
}

function providerBase(row: {
  id: string;
  code: string;
  name: string;
  status: "ACTIVE" | "DISABLED" | "DEGRADED";
  health: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
  enabled: boolean;
  priority: number;
  baseUrl: string | null;
  balanceMinor: bigint | null;
  balanceCurrency: string | null;
  lastBalanceSyncAt: Date | null;
  lastHealthAt: Date | null;
  lastSuccessfulAt: Date | null;
  lastErrorCode: string | null;
  updatedAt: Date;
  _count: { services: number; operationLogs: number };
  services: { _count: { mappings: number } }[];
}): AdminProvider {
  const mapped = row.services.reduce((sum, item) => sum + (item._count.mappings > 0 ? 1 : 0), 0);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    health: row.health,
    enabled: row.enabled,
    priority: row.priority,
    baseUrlConfigured: Boolean(row.baseUrl),
    credentialConfigured: row.code === "TTC" ? Boolean(parseProviderRuntimeConfig().ttc.apiKey) : false,
    balance: row.balanceMinor === null ? null : moneyToSafeNumber(row.balanceMinor),
    balanceCurrency: row.balanceCurrency ?? "",
    lastBalanceSyncAt: row.lastBalanceSyncAt?.toISOString() ?? null,
    lastHealthAt: row.lastHealthAt?.toISOString() ?? null,
    lastSuccessfulAt: row.lastSuccessfulAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode ?? "",
    services: row._count.services,
    mappedServices: mapped,
    unmappedServices: Math.max(0, row._count.services - mapped),
    errors: row._count.operationLogs,
    updatedAt: row.updatedAt.toISOString()
  };
}

export async function readAdminProviders(filters: { search?: string; status?: string; page: number; pageSize: number }) {
  const db = getDb();
  const where: Prisma.ProviderWhereInput = {};
  if (filters.search) where.OR = [{ code: { contains: filters.search, mode: "insensitive" } }, { name: { contains: filters.search, mode: "insensitive" } }];
  if (filters.status && filters.status !== "all" && ["ACTIVE", "DISABLED", "DEGRADED"].includes(filters.status)) {
    where.status = filters.status as "ACTIVE" | "DISABLED" | "DEGRADED";
  }
  const [total, rows] = await Promise.all([
    db.provider.count({ where }),
    db.provider.findMany({
      where,
      include: {
        _count: { select: { services: true, operationLogs: true } },
        services: { select: { _count: { select: { mappings: true } } } }
      },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize
    })
  ]);
  return pageResult(rows.map(providerBase), filters.page, filters.pageSize, total);
}

export async function readAdminProvider(providerId: string): Promise<AdminProviderDetail | null> {
  const db = getDb();
  const row = await db.provider.findUnique({
    where: { id: providerId },
    include: {
      _count: { select: { services: true, operationLogs: true } },
      services: {
        orderBy: [{ status: "asc" }, { name: "asc" }],
        include: {
          _count: { select: { mappings: true } },
          mappings: { include: { service: true }, orderBy: { priority: "asc" } }
        }
      },
      jobs: { orderBy: { createdAt: "desc" }, take: 30 },
      operationLogs: { orderBy: { createdAt: "desc" }, take: 50 }
    }
  });
  if (!row) return null;
  const servicesList: AdminProviderService[] = row.services.map((service) => ({
    id: service.id,
    externalServiceId: service.externalServiceId,
    name: service.name,
    category: service.category ?? "",
    platform: service.platform,
    providerRate: moneyToSafeNumber(service.providerRateMinor),
    rateUnit: service.rateUnit,
    currency: service.currency,
    min: service.min,
    max: service.max,
    supportsRefill: service.supportsRefill,
    supportsCancel: service.supportsCancel,
    status: service.status,
    lastSyncedAt: service.lastSyncedAt.toISOString(),
    mappings: service.mappings.map((mapping) => ({
      id: mapping.id,
      internalServiceId: mapping.serviceId,
      internalServiceCode: mapping.service.code,
      internalServiceName: mapping.service.name,
      customerRate: moneyToSafeNumber(mapping.service.ratePerThousandMinor),
      marginPerRateUnit: moneyToSafeNumber(mapping.service.ratePerThousandMinor - ((service.providerRateMinor * 1000n + BigInt(service.rateUnit) - 1n) / BigInt(service.rateUnit))),
      enabled: mapping.enabled,
      priority: mapping.priority,
      markupType: mapping.markupType,
      markupBps: mapping.markupBps,
      fixedMarkup: moneyToSafeNumber(mapping.fixedMarkupMinor),
      minimumMargin: moneyToSafeNumber(mapping.minimumMarginMinor),
      pricingMode: mapping.pricingMode,
      status: mapping.status
    }))
  }));
  return {
    ...providerBase(row),
    servicesList,
    jobs: row.jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      runAt: job.runAt.toISOString(),
      lastErrorCode: job.lastErrorCode ?? "",
      lastErrorMessage: job.lastErrorMessage ?? "",
      createdAt: job.createdAt.toISOString()
    })),
    operations: row.operationLogs.map((operation) => ({
      id: operation.id,
      operation: operation.operation,
      result: operation.result,
      durationMs: operation.durationMs,
      attempt: operation.attempt,
      errorCode: operation.errorCode ?? "",
      createdAt: operation.createdAt.toISOString()
    }))
  };
}

export async function readAdminProviderJobs(filters: { status?: string; page: number; pageSize: number }) {
  const where: Prisma.ProviderJobWhereInput = {};
  if (filters.status && filters.status !== "all" && Object.values(ProviderJobStatus).includes(filters.status as ProviderJobStatus)) {
    where.status = filters.status as ProviderJobStatus;
  }
  const db = getDb();
  const [total, rows] = await Promise.all([
    db.providerJob.count({ where }),
    db.providerJob.findMany({ where, orderBy: { createdAt: "desc" }, skip: (filters.page - 1) * filters.pageSize, take: filters.pageSize })
  ]);
  return pageResult(rows.map((job) => ({
    id: job.id, type: job.type, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts,
    runAt: job.runAt.toISOString(), lastErrorCode: job.lastErrorCode ?? "", lastErrorMessage: job.lastErrorMessage ?? "", createdAt: job.createdAt.toISOString()
  })), filters.page, filters.pageSize, total);
}
