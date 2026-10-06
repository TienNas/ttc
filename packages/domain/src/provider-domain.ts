import {
  OrderStatus,
  Prisma,
  ProviderJobStatus,
  ProviderJobType,
  ProviderMappingStatus,
  ProviderMarkupType,
  ProviderOrderStatus,
  ProviderPricingMode,
  ProviderServiceStatus,
  ProviderStatus,
  WalletTransactionStatus,
  WalletTransactionType,
  getDb
} from "@tuong-tac-pro/db";
import {
  calculateProviderCost,
  calculateSellingRate,
  parseProviderRuntimeConfig,
  proportionalRefundTarget,
  sanitizeProviderValue,
  type NormalizedProviderService
} from "@tuong-tac-pro/providers";
import { DomainError } from "./errors";

export type ProviderAdminActor = { userId: string; ipAddress?: string | null };

export type ProviderMappingInput = {
  serviceId: string;
  providerServiceId: string;
  enabled: boolean;
  priority: number;
  markupType: "PERCENTAGE" | "FIXED";
  markupBps: number;
  fixedMarkupMinor: bigint;
  minimumMarginMinor: bigint;
  pricingMode: "MANUAL" | "AUTO_MARKUP";
};

type JsonObject = Record<string, string | number | boolean | null>;

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

async function serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, attempts = 4): Promise<T> {
  const db = getDb();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5000,
        timeout: 20000
      });
    } catch (error) {
      if (errorCode(error) === "P2034" && attempt < attempts) continue;
      throw error;
    }
  }
  throw new DomainError("INTERNAL_ERROR", "Không thể hoàn tất giao dịch provider.", 500);
}

async function providerAudit(
  tx: Prisma.TransactionClient,
  actor: ProviderAdminActor,
  input: { action: string; entityType: string; entityId: string; before?: JsonObject; after?: JsonObject; metadata?: JsonObject }
) {
  await tx.adminAuditLog.create({
    data: {
      adminUserId: actor.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before,
      after: input.after,
      metadata: input.metadata,
      ipAddress: actor.ipAddress?.slice(0, 64) || null
    }
  });
}

export async function enqueueProviderJob(
  tx: Prisma.TransactionClient,
  input: {
    type: ProviderJobType;
    dedupeKey: string;
    providerId?: string | null;
    orderId?: string | null;
    providerOrderId?: string | null;
    payload?: Prisma.InputJsonValue;
    runAt?: Date;
    maxAttempts?: number;
  }
) {
  // Do not implement dedupe as create -> catch P2002 -> query again.
  // On PostgreSQL, a unique violation aborts the current transaction (25P02),
  // so the fallback query cannot run inside the same transaction.
  // Atomic upsert preserves the first durable job and returns it on replay
  // without poisoning the surrounding transaction.
  return tx.providerJob.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      type: input.type,
      status: ProviderJobStatus.PENDING,
      dedupeKey: input.dedupeKey,
      providerId: input.providerId ?? null,
      orderId: input.orderId ?? null,
      providerOrderId: input.providerOrderId ?? null,
      payload: input.payload,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? parseProviderRuntimeConfig().maxAttempts
    },
    update: {}
  });
}

export async function enqueueOrderSubmissionIfEnabled(tx: Prisma.TransactionClient, orderId: string, publicId: string) {
  if (!parseProviderRuntimeConfig().routingEnabled) return null;
  return enqueueProviderJob(tx, {
    type: ProviderJobType.SUBMIT_ORDER,
    dedupeKey: `submit:${orderId}`,
    orderId,
    payload: { publicOrderId: publicId }
  });
}

export async function enqueueAdminProviderJob(
  actor: ProviderAdminActor,
  providerId: string,
  type: Extract<ProviderJobType, "SYNC_SERVICES" | "SYNC_BALANCE" | "TEST_CONNECTION">
) {
  return serializable(async (tx) => {
    const provider = await tx.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new DomainError("VALIDATION_ERROR", "Không tìm thấy provider.", 404);
    const job = await enqueueProviderJob(tx, {
      type,
      providerId,
      dedupeKey: `${type.toLowerCase()}:${providerId}:${Date.now()}`
    });
    await providerAudit(tx, actor, {
      action: `PROVIDER_${type}`,
      entityType: "PROVIDER",
      entityId: providerId,
      metadata: { providerCode: provider.code, jobId: job.id }
    });
    return job;
  });
}

export async function setProviderEnabled(actor: ProviderAdminActor, providerId: string, enabled: boolean) {
  return serializable(async (tx) => {
    const provider = await tx.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new DomainError("VALIDATION_ERROR", "Không tìm thấy provider.", 404);
    const updated = await tx.provider.update({
      where: { id: providerId },
      data: { enabled, status: enabled ? ProviderStatus.ACTIVE : ProviderStatus.DISABLED }
    });
    await providerAudit(tx, actor, {
      action: "PROVIDER_STATUS_CHANGE",
      entityType: "PROVIDER",
      entityId: provider.id,
      before: { enabled: provider.enabled, status: provider.status },
      after: { enabled: updated.enabled, status: updated.status }
    });
    return updated;
  });
}

export async function upsertServiceProviderMapping(actor: ProviderAdminActor, input: ProviderMappingInput) {
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 10_000) {
    throw new DomainError("VALIDATION_ERROR", "Priority mapping không hợp lệ.", 400);
  }
  if (!Number.isInteger(input.markupBps) || input.markupBps < 0 || input.markupBps > 1_000_000) {
    throw new DomainError("VALIDATION_ERROR", "Markup percentage không hợp lệ.", 400);
  }
  if (input.fixedMarkupMinor < 0n || input.minimumMarginMinor < 0n) {
    throw new DomainError("VALIDATION_ERROR", "Markup và minimum margin không được âm.", 400);
  }
  return serializable(async (tx) => {
    const [service, providerService] = await Promise.all([
      tx.service.findUnique({ where: { id: input.serviceId } }),
      tx.providerService.findUnique({ where: { id: input.providerServiceId }, include: { provider: true } })
    ]);
    if (!service) throw new DomainError("SERVICE_NOT_FOUND", "Không tìm thấy dịch vụ nội bộ.", 404);
    if (!providerService) throw new DomainError("VALIDATION_ERROR", "Không tìm thấy dịch vụ provider.", 404);

    let status: ProviderMappingStatus = ProviderMappingStatus.ACTIVE;
    if (!providerService.provider.enabled || providerService.provider.status !== ProviderStatus.ACTIVE || providerService.status !== ProviderServiceStatus.AVAILABLE) {
      status = ProviderMappingStatus.PROVIDER_UNAVAILABLE;
    } else if (service.min < providerService.min || service.max > providerService.max) {
      status = ProviderMappingStatus.MIN_MAX_CONFLICT;
    } else if (service.ratePerThousandMinor < calculateProviderCost(providerService.providerRateMinor, 1000, providerService.rateUnit)) {
      status = ProviderMappingStatus.PRICE_REVIEW_REQUIRED;
    }

    const existing = await tx.serviceProviderMapping.findUnique({
      where: { serviceId_providerServiceId: { serviceId: service.id, providerServiceId: providerService.id } }
    });
    const data = {
      enabled: input.enabled,
      priority: input.priority,
      markupType: input.markupType === "FIXED" ? ProviderMarkupType.FIXED : ProviderMarkupType.PERCENTAGE,
      markupBps: input.markupBps,
      fixedMarkupMinor: input.fixedMarkupMinor,
      minimumMarginMinor: input.minimumMarginMinor,
      pricingMode: input.pricingMode === "AUTO_MARKUP" ? ProviderPricingMode.AUTO_MARKUP : ProviderPricingMode.MANUAL,
      status,
      lastPriceReviewAt: status === ProviderMappingStatus.PRICE_REVIEW_REQUIRED ? new Date() : null,
      updatedByUserId: actor.userId
    };
    let mapping;
    try {
      mapping = await tx.serviceProviderMapping.upsert({
        where: { serviceId_providerServiceId: { serviceId: service.id, providerServiceId: providerService.id } },
        update: data,
        create: { serviceId: service.id, providerServiceId: providerService.id, ...data }
      });
    } catch (error) {
      if (errorCode(error) === "P2002") {
        throw new DomainError("DUPLICATE_REQUEST", "Priority này đã được dùng cho provider mapping khác của dịch vụ.", 409);
      }
      throw error;
    }
    await providerAudit(tx, actor, {
      action: existing ? "PROVIDER_MAPPING_UPDATE" : "PROVIDER_MAPPING_CREATE",
      entityType: "SERVICE_PROVIDER_MAPPING",
      entityId: mapping.id,
      before: existing ? { enabled: existing.enabled, priority: existing.priority, status: existing.status } : undefined,
      after: { enabled: mapping.enabled, priority: mapping.priority, status: mapping.status },
      metadata: { serviceId: service.id, providerServiceId: providerService.id, providerCode: providerService.provider.code }
    });
    return mapping;
  });
}

export async function disableServiceProviderMapping(actor: ProviderAdminActor, mappingId: string) {
  return serializable(async (tx) => {
    const mapping = await tx.serviceProviderMapping.findUnique({ where: { id: mappingId } });
    if (!mapping) throw new DomainError("VALIDATION_ERROR", "Không tìm thấy mapping.", 404);
    const updated = await tx.serviceProviderMapping.update({
      where: { id: mappingId },
      data: { enabled: false, status: ProviderMappingStatus.DISABLED, updatedByUserId: actor.userId }
    });
    await providerAudit(tx, actor, {
      action: "PROVIDER_MAPPING_DISABLE",
      entityType: "SERVICE_PROVIDER_MAPPING",
      entityId: mappingId,
      before: { enabled: mapping.enabled, status: mapping.status },
      after: { enabled: false, status: updated.status }
    });
    return updated;
  });
}

function deriveMappingStatus(input: {
  providerEnabled: boolean;
  providerActive: boolean;
  providerServiceStatus: ProviderServiceStatus;
  serviceMin: number;
  serviceMax: number;
  providerMin: number;
  providerMax: number;
  serviceRate: bigint;
  providerRate: bigint;
  providerRateUnit: number;
}): ProviderMappingStatus {
  if (!input.providerEnabled || !input.providerActive || input.providerServiceStatus !== ProviderServiceStatus.AVAILABLE) {
    return ProviderMappingStatus.PROVIDER_UNAVAILABLE;
  }
  if (input.serviceMin < input.providerMin || input.serviceMax > input.providerMax) return ProviderMappingStatus.MIN_MAX_CONFLICT;
  if (input.serviceRate < calculateProviderCost(input.providerRate, 1000, input.providerRateUnit)) return ProviderMappingStatus.PRICE_REVIEW_REQUIRED;
  return ProviderMappingStatus.ACTIVE;
}

export async function applyProviderServiceSync(providerId: string, services: NormalizedProviderService[]) {
  return serializable(async (tx) => {
    const provider = await tx.provider.findUnique({ where: { id: providerId } });
    if (!provider) throw new DomainError("VALIDATION_ERROR", "Không tìm thấy provider.", 404);
    const now = new Date();
    const externalIds: string[] = [];
    let created = 0;
    let updated = 0;
    let priceChanges = 0;

    for (const service of services) {
      if (!service.externalServiceId || service.providerRateMinor < 0n || service.rateUnit <= 0 || service.min <= 0 || service.max < service.min) {
        throw new DomainError("VALIDATION_ERROR", "Provider trả về service không hợp lệ.", 502);
      }
      externalIds.push(service.externalServiceId);
      const existing = await tx.providerService.findUnique({
        where: { providerId_externalServiceId: { providerId, externalServiceId: service.externalServiceId } }
      });
      const data = {
        name: service.name.slice(0, 255),
        category: service.category?.slice(0, 120) || null,
        platform: service.platform ?? null,
        providerRateMinor: service.providerRateMinor,
        rateUnit: service.rateUnit,
        currency: service.currency.slice(0, 16),
        min: service.min,
        max: service.max,
        supportsRefill: service.supportsRefill,
        supportsCancel: service.supportsCancel,
        status: service.status as ProviderServiceStatus,
        rawMetadata: service.rawMetadata === undefined ? undefined : sanitizeProviderValue(service.rawMetadata) as Prisma.InputJsonValue,
        lastSyncedAt: now
      };
      const record = existing
        ? await tx.providerService.update({ where: { id: existing.id }, data })
        : await tx.providerService.create({ data: { providerId, externalServiceId: service.externalServiceId, ...data } });
      if (existing) updated += 1;
      else created += 1;
      if (existing && existing.providerRateMinor !== record.providerRateMinor) {
        priceChanges += 1;
        await tx.providerPriceHistory.create({
          data: {
            providerServiceId: record.id,
            previousRateMinor: existing.providerRateMinor,
            newRateMinor: record.providerRateMinor,
            source: "PROVIDER_SYNC"
          }
        });
      }
    }

    const removed = externalIds.length === 0
      ? await tx.providerService.updateMany({ where: { providerId, status: { not: ProviderServiceStatus.REMOVED } }, data: { status: ProviderServiceStatus.REMOVED } })
      : await tx.providerService.updateMany({
          where: { providerId, externalServiceId: { notIn: externalIds }, status: { not: ProviderServiceStatus.REMOVED } },
          data: { status: ProviderServiceStatus.REMOVED }
        });

    const mappings = await tx.serviceProviderMapping.findMany({
      where: { providerService: { providerId } },
      include: { service: true, providerService: { include: { provider: true } } }
    });
    for (const mapping of mappings) {
      const ps = mapping.providerService;
      let customerRate = mapping.service.ratePerThousandMinor;
      if (mapping.pricingMode === ProviderPricingMode.AUTO_MARKUP && mapping.updatedByUserId && ps.currency === "VND" && ps.rateUnit === 1000) {
        const calculated = calculateSellingRate(
          ps.providerRateMinor,
          mapping.markupType === ProviderMarkupType.FIXED
            ? { type: "FIXED", fixedMarkupMinor: mapping.fixedMarkupMinor }
            : { type: "PERCENTAGE", markupBps: mapping.markupBps }
        );
        if (calculated !== customerRate) {
          await tx.service.update({ where: { id: mapping.serviceId }, data: { ratePerThousandMinor: calculated } });
          await tx.servicePriceHistory.create({
            data: {
              serviceId: mapping.serviceId,
              previousRateMinor: customerRate,
              newRateMinor: calculated,
              adminUserId: mapping.updatedByUserId,
              reason: `AUTO_PROVIDER_SYNC:${provider.code}`
            }
          });
          customerRate = calculated;
        }
      }
      const status = deriveMappingStatus({
        providerEnabled: ps.provider.enabled,
        providerActive: ps.provider.status === ProviderStatus.ACTIVE,
        providerServiceStatus: ps.status,
        serviceMin: mapping.service.min,
        serviceMax: mapping.service.max,
        providerMin: ps.min,
        providerMax: ps.max,
        serviceRate: customerRate,
        providerRate: ps.providerRateMinor,
        providerRateUnit: ps.rateUnit
      });
      await tx.serviceProviderMapping.update({
        where: { id: mapping.id },
        data: { status, lastPriceReviewAt: status === ProviderMappingStatus.PRICE_REVIEW_REQUIRED ? now : mapping.lastPriceReviewAt }
      });
    }

    await tx.provider.update({
      where: { id: providerId },
      data: { lastSuccessfulAt: now, lastErrorCode: null }
    });
    return { created, updated, removed: removed.count, priceChanges };
  });
}

export async function refundProviderOrderToTarget(input: {
  orderId: string;
  targetRefundMinor: bigint;
  finalStatus: OrderStatus;
  remaining: number;
  reason: string;
  providerOrderId?: string;
  providerOrderStatus?: ProviderOrderStatus;
  providerSubmissionState?: "ACCEPTED" | "REJECTED" | "MANUAL_REVIEW" | "UNKNOWN_SUBMISSION";
  providerErrorCode?: string | null;
}) {
  return serializable(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: input.orderId }, include: { user: { include: { wallet: true } } } });
    if (!order) throw new DomainError("ORDER_NOT_FOUND", "Không tìm thấy đơn hàng.", 404);
    if (!order.user.wallet) throw new DomainError("INTERNAL_ERROR", "Khách hàng chưa có ví.", 500);
    const target = input.targetRefundMinor > order.chargeMinor ? order.chargeMinor : input.targetRefundMinor;
    if (target < 0n) throw new DomainError("VALIDATION_ERROR", "Refund target không hợp lệ.", 400);
    const delta = target - order.refundedMinor;
    if (delta > 0n) {
      const wallet = order.user.wallet;
      const nextBalance = wallet.balanceMinor + delta;
      await tx.wallet.update({ where: { id: wallet.id }, data: { balanceMinor: nextBalance } });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: WalletTransactionType.REFUND,
          status: WalletTransactionStatus.COMPLETED,
          amountMinor: delta,
          balanceBeforeMinor: wallet.balanceMinor,
          balanceAfterMinor: nextBalance,
          referenceType: "ORDER",
          referenceId: order.publicId,
          description: `Provider refund ${order.publicId}`,
          idempotencyKey: `provider-refund:${order.id}:${target.toString()}`,
          reason: input.reason.slice(0, 255)
        }
      });
    }
    if (input.providerOrderId && input.providerOrderStatus) {
      await tx.providerOrder.update({
        where: { id: input.providerOrderId },
        data: {
          status: input.providerOrderStatus,
          submissionState: input.providerSubmissionState,
          lastCheckedAt: new Date(),
          lastErrorCode: input.providerErrorCode ?? null
        }
      });
    }
    const updated = await tx.order.update({
      where: { id: order.id },
      data: { status: input.finalStatus, remaining: input.remaining, refundedMinor: target }
    });
    if (order.status !== updated.status || delta > 0n || order.remaining !== input.remaining) {
      await tx.orderLog.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: updated.status,
          message: input.reason.slice(0, 255),
          metadata: { refundDeltaMinor: delta.toString(), refundTotalMinor: target.toString(), remaining: input.remaining }
        }
      });
    }
    return { order: updated, refundDeltaMinor: delta, refundTotalMinor: target };
  });
}

export function partialRefundTarget(chargeMinor: bigint, remaining: number, quantity: number): bigint {
  return proportionalRefundTarget(chargeMinor, remaining, quantity);
}

export async function markProviderOrderStatus(input: {
  providerOrderId: string;
  providerStatus: ProviderOrderStatus;
  internalStatus: OrderStatus;
  remaining?: number;
  startCount?: number;
  responsePayload?: Prisma.InputJsonValue;
}) {
  return serializable(async (tx) => {
    const providerOrder = await tx.providerOrder.findUnique({ where: { id: input.providerOrderId }, include: { order: true } });
    if (!providerOrder) throw new DomainError("ORDER_NOT_FOUND", "Không tìm thấy provider order.", 404);
    const remaining = input.remaining ?? providerOrder.order.remaining;
    await tx.providerOrder.update({
      where: { id: providerOrder.id },
      data: { status: input.providerStatus, lastCheckedAt: new Date(), responsePayload: input.responsePayload }
    });
    const order = await tx.order.update({
      where: { id: providerOrder.orderId },
      data: { status: input.internalStatus, remaining, startCount: input.startCount ?? providerOrder.order.startCount }
    });
    if (providerOrder.order.status !== order.status || providerOrder.order.remaining !== order.remaining) {
      await tx.orderLog.create({
        data: {
          orderId: order.id,
          fromStatus: providerOrder.order.status,
          toStatus: order.status,
          message: `Provider status synchronized: ${input.providerStatus}`,
          metadata: { providerOrderId: providerOrder.id, remaining }
        }
      });
    }
    return order;
  });
}
