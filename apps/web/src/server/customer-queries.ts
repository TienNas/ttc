import { getDb, OrderStatus, Prisma, ProviderMappingStatus, ProviderServiceStatus, ProviderStatus, ServiceStatus, SocialPlatform } from "@tuong-tac-pro/db";
import { getOwnedTicket, moneyToSafeNumber } from "@tuong-tac-pro/domain";
import { isProviderRoutingEnabled } from "@tuong-tac-pro/providers";
import { toCategory, toDeposit, toDepositMethod, toOrder, toProfile, toService, toSupportMessage, toTicket, toWallet, toWalletTransaction } from "./mappers";

const platformToDb = {
  facebook: SocialPlatform.FACEBOOK,
  tiktok: SocialPlatform.TIKTOK,
  instagram: SocialPlatform.INSTAGRAM,
  youtube: SocialPlatform.YOUTUBE,
  threads: SocialPlatform.THREADS
} as const;

const publicStatusToDb = {
  Processing: [OrderStatus.VALIDATING, OrderStatus.SUBMITTED, OrderStatus.PROCESSING],
  Completed: [OrderStatus.COMPLETED],
  Pending: [OrderStatus.PENDING],
  Failed: [OrderStatus.FAILED],
  Cancelled: [OrderStatus.CANCELLED],
  Partial: [OrderStatus.PARTIAL],
  Refunded: [OrderStatus.REFUNDED]
} as const;

function providerRoutableServiceWhere(): Prisma.ServiceWhereInput {
  if (!isProviderRoutingEnabled()) return {};
  return {
    status: ServiceStatus.ACTIVE,
    providerMappings: {
      some: {
        enabled: true,
        status: ProviderMappingStatus.ACTIVE,
        providerService: {
          status: ProviderServiceStatus.AVAILABLE,
          provider: { enabled: true, status: ProviderStatus.ACTIVE }
        }
      }
    }
  };
}

export async function readProfile(userId: string) {
  const user = await getDb().user.findUniqueOrThrow({
    where: { id: userId },
    include: { notificationPreference: true }
  });
  return toProfile(user, user.notificationPreference);
}

export async function readWallet(userId: string) {
  const wallet = await getDb().wallet.findUniqueOrThrow({ where: { userId } });
  return toWallet(wallet);
}

export async function readDashboard(userId: string) {
  const db = getDb();
  const [user, wallet, orders, popularServices] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, include: { notificationPreference: true } }),
    db.wallet.findUniqueOrThrow({ where: { userId } }),
    db.order.findMany({ where: { userId }, include: { service: true }, orderBy: { createdAt: "desc" }, take: 200 }),
    db.service.findMany({ where: { popular: true, status: ServiceStatus.ACTIVE, ...providerRoutableServiceWhere() }, orderBy: [{ platform: "asc" }, { name: "asc" }], take: 4 })
  ]);
  const completedPurchases = await db.walletTransaction.aggregate({
    where: { walletId: wallet.id, type: "PURCHASE", status: "COMPLETED" },
    _sum: { amountMinor: true }
  });

  const runningStatuses = new Set<OrderStatus>([OrderStatus.PENDING, OrderStatus.VALIDATING, OrderStatus.SUBMITTED, OrderStatus.PROCESSING]);
  const counts = new Map<SocialPlatform, number>();
  for (const order of orders) counts.set(order.service.platform, (counts.get(order.service.platform) ?? 0) + 1);
  const popularPlatformDb = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? SocialPlatform.FACEBOOK;
  const platformUi = popularPlatformDb === SocialPlatform.TIKTOK
    ? "tiktok"
    : popularPlatformDb === SocialPlatform.INSTAGRAM
      ? "instagram"
      : popularPlatformDb === SocialPlatform.YOUTUBE
        ? "youtube"
        : popularPlatformDb === SocialPlatform.THREADS
          ? "threads"
          : "facebook";

  return {
    profile: toProfile(user, user.notificationPreference),
    wallet: toWallet(wallet),
    runningOrders: orders.filter((order) => runningStatuses.has(order.status)).length,
    completedOrders: orders.filter((order) => order.status === OrderStatus.COMPLETED).length,
    totalSpent: Math.abs(moneyToSafeNumber(completedPurchases._sum.amountMinor ?? 0n)),
    popularPlatform: platformUi,
    popularServices: popularServices.map(toService),
    recentOrders: orders.slice(0, 5).map(toOrder)
  };
}

export async function readCategories() {
  const categories = await getDb().serviceCategory.findMany({ where: { enabled: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return categories.map(toCategory);
}

export async function readServices(filters: { search?: string; platform?: string; category?: string; page?: number; pageSize?: number }) {
  const where: Prisma.ServiceWhereInput = providerRoutableServiceWhere();
  if (filters.platform && filters.platform !== "all" && filters.platform in platformToDb) {
    where.platform = platformToDb[filters.platform as keyof typeof platformToDb];
  }
  if (filters.category && filters.category !== "all") where.categoryId = filters.category;
  if (filters.search) {
    where.OR = [
      { code: { contains: filters.search, mode: "insensitive" } },
      { name: { contains: filters.search, mode: "insensitive" } },
      { description: { contains: filters.search, mode: "insensitive" } }
    ];
  }
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 200;
  const services = await getDb().service.findMany({ where, orderBy: [{ platform: "asc" }, { name: "asc" }], skip: (page - 1) * pageSize, take: pageSize });
  return services.map(toService);
}

export async function readService(id: string) {
  const routable = providerRoutableServiceWhere();
  const service = isProviderRoutingEnabled()
    ? await getDb().service.findFirst({ where: { id, ...routable } })
    : await getDb().service.findUnique({ where: { id } });
  return service ? toService(service) : null;
}

export async function readOrders(userId: string, filters: { search?: string; platform?: string; status?: string; dateRange?: string; page?: number; pageSize?: number }) {
  const where: Prisma.OrderWhereInput = { userId };
  if (filters.platform && filters.platform !== "all" && filters.platform in platformToDb) {
    where.service = { platform: platformToDb[filters.platform as keyof typeof platformToDb] };
  }
  if (filters.status && filters.status !== "all" && filters.status in publicStatusToDb) {
    where.status = { in: [...publicStatusToDb[filters.status as keyof typeof publicStatusToDb]] };
  }
  if (filters.search) {
    where.OR = [
      { publicId: { contains: filters.search, mode: "insensitive" } },
      { targetUrl: { contains: filters.search, mode: "insensitive" } },
      { service: { name: { contains: filters.search, mode: "insensitive" } } }
    ];
  }
  const days = filters.dateRange === "7d" ? 7 : filters.dateRange === "30d" ? 30 : filters.dateRange === "90d" ? 90 : 0;
  if (days) where.createdAt = { gte: new Date(Date.now() - days * 86_400_000) };
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 200;
  const orders = await getDb().order.findMany({ where, include: { service: true }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize });
  return orders.map(toOrder);
}

export async function readWalletTransactions(userId: string) {
  const wallet = await getDb().wallet.findUniqueOrThrow({ where: { userId } });
  const transactions = await getDb().walletTransaction.findMany({
    where: { walletId: wallet.id }, orderBy: { createdAt: "desc" }, take: 200
  });
  return transactions.map(toWalletTransaction);
}

export async function readDepositMethods() {
  const methods = await getDb().depositMethod.findMany({ orderBy: [{ enabled: "desc" }, { name: "asc" }] });
  return methods.map(toDepositMethod);
}

export async function readDeposits(userId: string) {
  const deposits = await getDb().deposit.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 });
  return deposits.map(toDeposit);
}

export async function readTickets(userId: string) {
  const tickets = await getDb().supportTicket.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
    take: 100
  });
  return tickets.map((ticket) => toTicket({ ...ticket, messages: [...ticket.messages].reverse() }));
}

export function mapTicketThread(ticket: Awaited<ReturnType<typeof getOwnedTicket>>) {
  return {
    ticket: toTicket({ ...ticket, messages: ticket.messages }),
    messages: ticket.messages.map((message) => toSupportMessage(message, ticket.publicId))
  };
}
