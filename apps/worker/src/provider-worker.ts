import { createHash } from "node:crypto";
import {
  OrderStatus,
  ProviderHealth,
  ProviderJobStatus,
  ProviderJobType,
  ProviderMappingStatus,
  ProviderOrderStatus,
  ProviderServiceStatus,
  ProviderSubmissionState,
  ProviderStatus,
  getDb,
  type ProviderJob
} from "@tuong-tac-pro/db";
import {
  applyProviderServiceSync,
  enqueueProviderJob,
  markProviderOrderStatus,
  partialRefundTarget,
  refundProviderOrderToTarget
} from "@tuong-tac-pro/domain";
import {
  ProviderAdapterError,
  calculateProviderCost,
  createDefaultProviderRegistry,
  decideProviderRetry,
  grossMargin,
  hasSafeMargin,
  parseProviderRuntimeConfig,
  sanitizeProviderErrorMessage,
  sanitizeProviderValue,
  toProviderAdapterError,
  type NormalizedProviderOrderStatus,
  type ProviderAdapter,
  type ProviderRegistry
} from "@tuong-tac-pro/providers";
import { completeProviderJob, failProviderJob, manualReviewProviderJob, retryProviderJob } from "./queue";
import { withProviderRequestLease } from "./rate-limit";

const TERMINAL_INTERNAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.COMPLETED,
  OrderStatus.REFUNDED,
  OrderStatus.CANCELLED
]);

const MANUAL_REVIEW_SUBMISSION_STATES: ReadonlySet<ProviderSubmissionState> = new Set<ProviderSubmissionState>([
  ProviderSubmissionState.UNKNOWN_SUBMISSION,
  ProviderSubmissionState.MANUAL_REVIEW
]);

const TERMINAL_PROVIDER_ORDER_STATUSES: ReadonlySet<ProviderOrderStatus> = new Set<ProviderOrderStatus>([
  ProviderOrderStatus.COMPLETED,
  ProviderOrderStatus.FAILED,
  ProviderOrderStatus.CANCELLED,
  ProviderOrderStatus.REFUNDED
]);

function statusPair(status: NormalizedProviderOrderStatus): { provider: ProviderOrderStatus; internal: OrderStatus } {
  switch (status) {
    case "COMPLETED": return { provider: ProviderOrderStatus.COMPLETED, internal: OrderStatus.COMPLETED };
    case "PARTIAL": return { provider: ProviderOrderStatus.PARTIAL, internal: OrderStatus.PARTIAL };
    case "FAILED": return { provider: ProviderOrderStatus.FAILED, internal: OrderStatus.FAILED };
    case "CANCELLED": return { provider: ProviderOrderStatus.CANCELLED, internal: OrderStatus.CANCELLED };
    case "REFUNDED": return { provider: ProviderOrderStatus.REFUNDED, internal: OrderStatus.REFUNDED };
    case "PROCESSING": return { provider: ProviderOrderStatus.PROCESSING, internal: OrderStatus.PROCESSING };
    case "SUBMITTED": return { provider: ProviderOrderStatus.SUBMITTED, internal: OrderStatus.SUBMITTED };
    case "PENDING": return { provider: ProviderOrderStatus.SUBMITTED, internal: OrderStatus.SUBMITTED };
    default: return { provider: ProviderOrderStatus.UNKNOWN, internal: OrderStatus.PROCESSING };
  }
}

function requestHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function operationLog(input: {
  providerId: string;
  orderId?: string;
  operation: string;
  externalOrderId?: string;
  startedAt: number;
  result: string;
  attempt?: number;
  errorCode?: string;
  metadata?: unknown;
}) {
  const db = getDb();
  await db.providerOperationLog.create({
    data: {
      providerId: input.providerId,
      orderId: input.orderId ?? null,
      operation: input.operation,
      externalOrderId: input.externalOrderId ?? null,
      durationMs: Math.max(0, Date.now() - input.startedAt),
      result: input.result,
      attempt: input.attempt ?? 1,
      errorCode: input.errorCode?.slice(0, 80) || null,
      metadata: sanitizeProviderValue(input.metadata) as object | undefined
    }
  });
}

async function markProviderHealth(providerId: string, health: ProviderHealth, errorCode?: string) {
  const db = getDb();
  await db.provider.update({
    where: { id: providerId },
    data: {
      health,
      lastHealthAt: new Date(),
      ...(health === ProviderHealth.HEALTHY ? { lastSuccessfulAt: new Date(), lastErrorCode: null } : { lastErrorCode: errorCode?.slice(0, 80) || null })
    }
  });
}

function adapterFor(registry: ProviderRegistry, code: string): ProviderAdapter {
  try {
    return registry.get(code);
  } catch (error) {
    throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", error instanceof Error ? error.message : "Provider adapter missing.");
  }
}

async function handleTestConnection(job: ProviderJob, registry: ProviderRegistry) {
  if (!job.providerId) throw new ProviderAdapterError("PROVIDER_INVALID_REQUEST", "Provider job missing providerId.");
  const db = getDb();
  const provider = await db.provider.findUniqueOrThrow({ where: { id: job.providerId } });
  const adapter = adapterFor(registry, provider.code);
  const startedAt = Date.now();
  const result = await withProviderRequestLease(provider.id, `job:${job.id}:test`, provider.timeoutMs, () => adapter.testConnection());
  await markProviderHealth(provider.id, result.ok ? ProviderHealth.HEALTHY : ProviderHealth.DEGRADED, result.ok ? undefined : "CONNECTION_FAILED");
  await operationLog({ providerId: provider.id, operation: "TEST_CONNECTION", startedAt, result: result.ok ? "SUCCESS" : "FAILED", metadata: { message: result.message ?? null } });
}

async function handleSyncServices(job: ProviderJob, registry: ProviderRegistry) {
  if (!job.providerId) throw new ProviderAdapterError("PROVIDER_INVALID_REQUEST", "Provider job missing providerId.");
  const db = getDb();
  const provider = await db.provider.findUniqueOrThrow({ where: { id: job.providerId } });
  const adapter = adapterFor(registry, provider.code);
  if (!adapter.capabilities.supportsServiceSync) throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "Provider service sync capability is not verified.");
  const startedAt = Date.now();
  const services = await withProviderRequestLease(provider.id, `job:${job.id}:services`, provider.timeoutMs, () => adapter.getServices());
  const summary = await applyProviderServiceSync(provider.id, services);
  await markProviderHealth(provider.id, ProviderHealth.HEALTHY);
  await operationLog({ providerId: provider.id, operation: "SYNC_SERVICES", startedAt, result: "SUCCESS", metadata: summary });
}

async function handleSyncBalance(job: ProviderJob, registry: ProviderRegistry) {
  if (!job.providerId) throw new ProviderAdapterError("PROVIDER_INVALID_REQUEST", "Provider job missing providerId.");
  const db = getDb();
  const provider = await db.provider.findUniqueOrThrow({ where: { id: job.providerId } });
  const adapter = adapterFor(registry, provider.code);
  if (!adapter.capabilities.supportsBalance) throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "Provider balance capability is not verified.");
  const startedAt = Date.now();
  const balance = await withProviderRequestLease(provider.id, `job:${job.id}:balance`, provider.timeoutMs, () => adapter.getBalance());
  await db.$transaction([
    db.provider.update({
      where: { id: provider.id },
      data: {
        balanceMinor: balance.amountMinor,
        balanceCurrency: balance.currency,
        lastBalanceSyncAt: new Date(),
        lastSuccessfulAt: new Date(),
        health: ProviderHealth.HEALTHY,
        lastErrorCode: null
      }
    }),
    db.providerBalanceSnapshot.create({ data: { providerId: provider.id, amountMinor: balance.amountMinor, currency: balance.currency } })
  ]);
  await operationLog({ providerId: provider.id, operation: "SYNC_BALANCE", startedAt, result: "SUCCESS", metadata: { currency: balance.currency, amountMinor: balance.amountMinor.toString() } });
}

async function schedulePoll(providerOrderId: string, providerId: string, orderId: string, delayMs: number) {
  const db = getDb();
  const runAt = new Date(Date.now() + delayMs);
  await db.$transaction(async (tx) => {
    await tx.providerOrder.update({ where: { id: providerOrderId }, data: { nextPollAt: runAt } });
    await enqueueProviderJob(tx, {
      type: ProviderJobType.POLL_ORDER_STATUS,
      dedupeKey: `poll:${providerOrderId}:${runAt.getTime()}`,
      providerId,
      orderId,
      providerOrderId,
      runAt
    });
  });
}

async function finalRefundForSubmissionFailure(providerOrderId: string, code: string, message: string) {
  const db = getDb();
  const providerOrder = await db.providerOrder.findUniqueOrThrow({ where: { id: providerOrderId }, include: { order: true } });
  await refundProviderOrderToTarget({
    orderId: providerOrder.orderId,
    targetRefundMinor: providerOrder.order.chargeMinor,
    finalStatus: OrderStatus.FAILED,
    remaining: providerOrder.order.quantity,
    reason: `Provider submission failed: ${message}`,
    providerOrderId,
    providerOrderStatus: ProviderOrderStatus.FAILED,
    providerSubmissionState: "REJECTED",
    providerErrorCode: code
  });
}

async function handleSubmitOrder(job: ProviderJob, registry: ProviderRegistry) {
  if (!job.orderId) throw new ProviderAdapterError("PROVIDER_INVALID_REQUEST", "Submit job missing orderId.");
  const db = getDb();
  const order = await db.order.findUnique({ where: { id: job.orderId }, include: { service: true, providerOrder: true } });
  if (!order) throw new ProviderAdapterError("PROVIDER_INVALID_REQUEST", "Internal order no longer exists.");
  if (order.providerOrder?.submissionState === ProviderSubmissionState.ACCEPTED) return;
  if (TERMINAL_INTERNAL_ORDER_STATUSES.has(order.status)) return;
  if (MANUAL_REVIEW_SUBMISSION_STATES.has(order.providerOrder?.submissionState ?? ProviderSubmissionState.PENDING)) {
    throw new ProviderAdapterError("PROVIDER_UNKNOWN_ERROR", "Order is already waiting for manual provider review.");
  }

  const mappingWhere = {
    serviceId: order.serviceId,
    ...(order.providerOrder ? { providerServiceId: order.providerOrder.providerServiceId } : {}),
    enabled: true,
    status: ProviderMappingStatus.ACTIVE,
    providerService: {
      status: ProviderServiceStatus.AVAILABLE,
      provider: { enabled: true, status: ProviderStatus.ACTIVE }
    }
  };
  const mapping = await db.serviceProviderMapping.findFirst({
    where: mappingWhere,
    orderBy: { priority: "asc" },
    include: { providerService: { include: { provider: true } } }
  });
  if (!mapping) throw new ProviderAdapterError("PROVIDER_SERVICE_UNAVAILABLE", "No active provider mapping is available for this service.");
  const providerService = mapping.providerService;
  const provider = providerService.provider;
  if (providerService.currency !== "VND") {
    throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "Foreign-currency provider pricing requires an explicit FX policy.");
  }
  if (order.quantity < providerService.min || order.quantity > providerService.max) {
    await db.serviceProviderMapping.update({ where: { id: mapping.id }, data: { status: ProviderMappingStatus.MIN_MAX_CONFLICT } });
    throw new ProviderAdapterError("PROVIDER_INVALID_REQUEST", "Order quantity conflicts with current provider limits.");
  }

  const providerCostMinor = calculateProviderCost(providerService.providerRateMinor, order.quantity, providerService.rateUnit);
  const marginMinor = grossMargin(order.chargeMinor, providerCostMinor);
  const clientReference = `ttp:${order.publicId}`;
  let providerOrder = order.providerOrder ?? await db.providerOrder.create({
    data: {
      orderId: order.id,
      providerId: provider.id,
      providerServiceId: providerService.id,
      clientReference,
      providerRateSnapshotMinor: providerService.providerRateMinor,
      rateUnitSnapshot: providerService.rateUnit,
      providerCostMinor,
      customerChargeMinor: order.chargeMinor,
      grossMarginMinor: marginMinor,
      currency: providerService.currency,
      requestPayload: sanitizeProviderValue({ externalServiceId: providerService.externalServiceId, quantity: order.quantity, targetHash: createHash("sha256").update(order.targetUrl).digest("hex") }) as object
    }
  });

  if (!hasSafeMargin(order.chargeMinor, providerCostMinor, mapping.minimumMarginMinor)) {
    await db.$transaction([
      db.serviceProviderMapping.update({ where: { id: mapping.id }, data: { status: ProviderMappingStatus.PRICE_REVIEW_REQUIRED, lastPriceReviewAt: new Date() } }),
      db.providerOrder.update({ where: { id: providerOrder.id }, data: { submissionState: ProviderSubmissionState.MANUAL_REVIEW, lastErrorCode: "PRICE_REVIEW_REQUIRED", lastErrorMessage: "Provider cost violates minimum margin policy." } })
    ]);
    throw new ProviderAdapterError("PROVIDER_SERVICE_UNAVAILABLE", "Provider price requires admin review before submission.");
  }

  const adapter = adapterFor(registry, provider.code);
  const providerIdempotencyKey = adapter.capabilities.supportsCreateIdempotency ? `create:${order.publicId}` : undefined;
  const createInput = {
    internalOrderId: order.id,
    publicOrderId: order.publicId,
    externalServiceId: providerService.externalServiceId,
    target: order.targetUrl,
    quantity: order.quantity,
    idempotencyKey: providerIdempotencyKey,
    clientReference: adapter.capabilities.supportsClientReference ? clientReference : undefined
  };
  const attemptNo = providerOrder.attemptCount + 1;
  const attempt = await db.providerOrderAttempt.create({
    data: {
      orderId: order.id,
      providerOrderRecordId: providerOrder.id,
      providerId: provider.id,
      providerServiceId: providerService.id,
      attemptNo,
      providerIdempotencyKey,
      clientReference,
      requestHash: requestHash(createInput),
      state: ProviderSubmissionState.PREPARED
    }
  });
  providerOrder = await db.providerOrder.update({
    where: { id: providerOrder.id },
    data: { submissionState: ProviderSubmissionState.SENDING, attemptCount: attemptNo }
  });
  await db.order.update({ where: { id: order.id }, data: { status: OrderStatus.VALIDATING } });
  const startedAt = Date.now();

  try {
    const result = await withProviderRequestLease(provider.id, `job:${job.id}:create`, provider.timeoutMs, () => adapter.createOrder(createInput));
    if (result.outcome === "UNKNOWN") {
      await db.$transaction([
        db.providerOrderAttempt.update({ where: { id: attempt.id }, data: { state: ProviderSubmissionState.UNKNOWN_SUBMISSION, httpStatus: result.httpStatus ?? null, errorCode: result.code, finishedAt: new Date() } }),
        db.providerOrder.update({ where: { id: providerOrder.id }, data: { submissionState: ProviderSubmissionState.UNKNOWN_SUBMISSION, status: ProviderOrderStatus.UNKNOWN, lastErrorCode: result.code, lastErrorMessage: result.message.slice(0, 500), responsePayload: sanitizeProviderValue(result.raw) as object | undefined } })
      ]);
      await operationLog({ providerId: provider.id, orderId: order.id, operation: "CREATE_ORDER", startedAt, result: "UNKNOWN", attempt: attemptNo, errorCode: result.code });
      await manualReviewProviderJob(job.id, "UNKNOWN_SUBMISSION", result.message);
      return;
    }
    if (result.outcome === "REJECTED") {
      await db.providerOrderAttempt.update({ where: { id: attempt.id }, data: { state: ProviderSubmissionState.REJECTED, httpStatus: result.httpStatus ?? null, errorCode: result.code, finishedAt: new Date() } });
      await operationLog({ providerId: provider.id, orderId: order.id, operation: "CREATE_ORDER", startedAt, result: "REJECTED", attempt: attemptNo, errorCode: result.code });
      if (result.retryable && job.attempts < job.maxAttempts && adapter.capabilities.supportsCreateIdempotency) {
        await db.providerOrder.update({ where: { id: providerOrder.id }, data: { submissionState: ProviderSubmissionState.SAFE_TO_RETRY, lastErrorCode: result.code, lastErrorMessage: result.message.slice(0, 500) } });
        await retryProviderJob(job, result.code, result.message);
        return;
      }
      await finalRefundForSubmissionFailure(providerOrder.id, result.code, result.message);
      return;
    }

    const pair = statusPair(result.status ?? "SUBMITTED");
    const internalStatus = pair.internal === OrderStatus.COMPLETED ? OrderStatus.COMPLETED : pair.internal;
    const remaining = internalStatus === OrderStatus.COMPLETED ? 0 : order.remaining;
    await db.$transaction(async (tx) => {
      await tx.providerOrderAttempt.update({
        where: { id: attempt.id },
        data: { state: ProviderSubmissionState.ACCEPTED, externalOrderId: result.externalOrderId, finishedAt: new Date() }
      });
      await tx.providerOrder.update({
        where: { id: providerOrder.id },
        data: {
          externalOrderId: result.externalOrderId,
          submissionState: ProviderSubmissionState.ACCEPTED,
          status: pair.provider,
          submittedAt: new Date(),
          responsePayload: sanitizeProviderValue(result.raw) as object | undefined,
          lastErrorCode: null,
          lastErrorMessage: null
        }
      });
      await tx.order.update({ where: { id: order.id }, data: { status: internalStatus, remaining } });
      await tx.orderLog.create({
        data: { orderId: order.id, fromStatus: OrderStatus.VALIDATING, toStatus: internalStatus, message: "Đơn đã được provider chấp nhận.", metadata: { providerOrderId: providerOrder.id } }
      });
    });
    await markProviderHealth(provider.id, ProviderHealth.HEALTHY);
    await operationLog({ providerId: provider.id, orderId: order.id, externalOrderId: result.externalOrderId, operation: "CREATE_ORDER", startedAt, result: "SUCCESS", attempt: attemptNo });
    if (internalStatus !== OrderStatus.COMPLETED) {
      await schedulePoll(providerOrder.id, provider.id, order.id, parseProviderRuntimeConfig().pollInitialMs);
    }
  } catch (error) {
    const providerError = toProviderAdapterError(error, true);
    const decision = decideProviderRetry(providerError, job.attempts, job.maxAttempts, {
      sideEffecting: true,
      providerSupportsIdempotency: adapter.capabilities.supportsCreateIdempotency
    });
    await db.providerOrderAttempt.update({
      where: { id: attempt.id },
      data: {
        state: decision.action === "MANUAL_REVIEW" ? ProviderSubmissionState.UNKNOWN_SUBMISSION : decision.action === "RETRY" ? ProviderSubmissionState.SAFE_TO_RETRY : ProviderSubmissionState.REJECTED,
        httpStatus: providerError.httpStatus ?? null,
        errorCode: providerError.code,
        finishedAt: new Date()
      }
    });
    await operationLog({ providerId: provider.id, orderId: order.id, operation: "CREATE_ORDER", startedAt, result: decision.action, attempt: attemptNo, errorCode: providerError.code });
    const safeMessage = sanitizeProviderErrorMessage(providerError.message);
    if (decision.action === "MANUAL_REVIEW") {
      await db.providerOrder.update({ where: { id: providerOrder.id }, data: { submissionState: ProviderSubmissionState.UNKNOWN_SUBMISSION, status: ProviderOrderStatus.UNKNOWN, lastErrorCode: providerError.code, lastErrorMessage: safeMessage } });
      await manualReviewProviderJob(job.id, "UNKNOWN_SUBMISSION", safeMessage);
      return;
    }
    if (decision.action === "RETRY") {
      await db.providerOrder.update({ where: { id: providerOrder.id }, data: { submissionState: ProviderSubmissionState.SAFE_TO_RETRY, lastErrorCode: providerError.code, lastErrorMessage: safeMessage } });
      await retryProviderJob(job, providerError.code, safeMessage, decision.delayMs);
      return;
    }
    await finalRefundForSubmissionFailure(providerOrder.id, providerError.code, safeMessage);
  }
}

async function handlePoll(job: ProviderJob, registry: ProviderRegistry) {
  if (!job.providerOrderId) throw new ProviderAdapterError("PROVIDER_INVALID_REQUEST", "Poll job missing providerOrderId.");
  const db = getDb();
  const providerOrder = await db.providerOrder.findUnique({
    where: { id: job.providerOrderId },
    include: { provider: true, order: true }
  });
  if (!providerOrder || !providerOrder.externalOrderId) return;
  if (TERMINAL_PROVIDER_ORDER_STATUSES.has(providerOrder.status)) return;
  const adapter = adapterFor(registry, providerOrder.provider.code);
  const startedAt = Date.now();
  try {
    const result = await withProviderRequestLease(providerOrder.providerId, `job:${job.id}:status`, providerOrder.provider.timeoutMs, () => adapter.getOrderStatus({ externalOrderId: providerOrder.externalOrderId!, clientReference: providerOrder.clientReference }));
    const pair = statusPair(result.status);
    await operationLog({ providerId: providerOrder.providerId, orderId: providerOrder.orderId, externalOrderId: providerOrder.externalOrderId, operation: "GET_ORDER_STATUS", startedAt, result: "SUCCESS", attempt: job.attempts, metadata: { status: result.status, rawStatus: result.rawStatus ?? null } });

    if (result.status === "PARTIAL") {
      if (!Number.isInteger(result.remaining) || result.remaining === undefined || result.remaining < 0 || result.remaining > providerOrder.order.quantity) {
        await manualReviewProviderJob(job.id, "PROVIDER_MALFORMED_RESPONSE", "PARTIAL status requires a valid remaining count.");
        return;
      }
      const target = partialRefundTarget(providerOrder.order.chargeMinor, result.remaining, providerOrder.order.quantity);
      await refundProviderOrderToTarget({
        orderId: providerOrder.orderId,
        targetRefundMinor: target,
        finalStatus: OrderStatus.PARTIAL,
        remaining: result.remaining,
        reason: "Provider completed the order partially; proportional refund applied.",
        providerOrderId: providerOrder.id,
        providerOrderStatus: ProviderOrderStatus.PARTIAL,
        providerSubmissionState: "ACCEPTED"
      });
      return;
    }
    if (["FAILED", "CANCELLED", "REFUNDED"].includes(result.status)) {
      const terminalInternal = result.status === "CANCELLED" ? OrderStatus.CANCELLED : result.status === "REFUNDED" ? OrderStatus.REFUNDED : OrderStatus.FAILED;
      const terminalProvider = result.status === "CANCELLED" ? ProviderOrderStatus.CANCELLED : result.status === "REFUNDED" ? ProviderOrderStatus.REFUNDED : ProviderOrderStatus.FAILED;
      await refundProviderOrderToTarget({
        orderId: providerOrder.orderId,
        targetRefundMinor: providerOrder.order.chargeMinor,
        finalStatus: terminalInternal,
        remaining: result.remaining ?? providerOrder.order.quantity,
        reason: `Provider terminal status: ${result.status}.`,
        providerOrderId: providerOrder.id,
        providerOrderStatus: terminalProvider,
        providerSubmissionState: "ACCEPTED"
      });
      return;
    }
    if (result.status === "COMPLETED") {
      await markProviderOrderStatus({
        providerOrderId: providerOrder.id,
        providerStatus: pair.provider,
        internalStatus: OrderStatus.COMPLETED,
        remaining: 0,
        startCount: result.startCount,
        responsePayload: sanitizeProviderValue(result.raw) as object | undefined
      });
      return;
    }

    await markProviderOrderStatus({
      providerOrderId: providerOrder.id,
      providerStatus: pair.provider,
      internalStatus: pair.internal,
      remaining: result.remaining,
      startCount: result.startCount,
      responsePayload: sanitizeProviderValue(result.raw) as object | undefined
    });
    const ageMinutes = Math.max(0, (Date.now() - providerOrder.createdAt.getTime()) / 60_000);
    const config = parseProviderRuntimeConfig();
    const delay = Math.min(config.pollMaxMs, config.pollInitialMs * Math.max(1, Math.ceil(ageMinutes / 30)));
    await schedulePoll(providerOrder.id, providerOrder.providerId, providerOrder.orderId, delay);
  } catch (error) {
    const providerError = toProviderAdapterError(error, false);
    await operationLog({ providerId: providerOrder.providerId, orderId: providerOrder.orderId, externalOrderId: providerOrder.externalOrderId, operation: "GET_ORDER_STATUS", startedAt, result: "ERROR", attempt: job.attempts, errorCode: providerError.code });
    if (providerError.retryable && job.attempts < job.maxAttempts) {
      await retryProviderJob(job, providerError.code, sanitizeProviderErrorMessage(providerError.message));
      return;
    }
    await manualReviewProviderJob(job.id, providerError.code, sanitizeProviderErrorMessage(providerError.message));
  }
}

export async function processProviderJob(job: ProviderJob, registry: ProviderRegistry = createDefaultProviderRegistry()): Promise<void> {
  if (job.status !== ProviderJobStatus.RUNNING) return;
  try {
    switch (job.type) {
      case ProviderJobType.TEST_CONNECTION:
        await handleTestConnection(job, registry);
        break;
      case ProviderJobType.SYNC_SERVICES:
        await handleSyncServices(job, registry);
        break;
      case ProviderJobType.SYNC_BALANCE:
        await handleSyncBalance(job, registry);
        break;
      case ProviderJobType.SUBMIT_ORDER:
        await handleSubmitOrder(job, registry);
        break;
      case ProviderJobType.POLL_ORDER_STATUS:
        await handlePoll(job, registry);
        break;
      default:
        await failProviderJob(job.id, "UNSUPPORTED_JOB", `Unsupported provider job: ${String(job.type)}`);
        return;
    }
    const latest = await getDb().providerJob.findUnique({ where: { id: job.id } });
    if (latest?.status === ProviderJobStatus.RUNNING) await completeProviderJob(job.id);
  } catch (error) {
    const providerError = toProviderAdapterError(error, false);
    const message = sanitizeProviderErrorMessage(providerError.message);
    if (providerError.code === "PROVIDER_CONFIGURATION_MISSING" || providerError.code === "PROVIDER_UNAUTHORIZED" || providerError.code === "PROVIDER_INSUFFICIENT_BALANCE" || providerError.code === "PROVIDER_SERVICE_UNAVAILABLE" || providerError.code === "PROVIDER_INVALID_REQUEST") {
      await manualReviewProviderJob(job.id, providerError.code, message);
      if (job.providerId) await markProviderHealth(job.providerId, ProviderHealth.DEGRADED, providerError.code);
      return;
    }
    if (providerError.retryable && job.attempts < job.maxAttempts) {
      await retryProviderJob(job, providerError.code, message);
      return;
    }
    await failProviderJob(job.id, providerError.code, message);
  }
}
