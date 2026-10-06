import type {
  NormalizedProviderOrderStatus,
  NormalizedProviderService,
  ProviderAdapter,
  ProviderBalanceResult,
  ProviderCapabilities,
  ProviderConnectionResult,
  ProviderCreateOrderInput,
  ProviderCreateOrderResult,
  ProviderErrorCode,
  ProviderOrderStatusInput,
  ProviderOrderStatusResult
} from "../contracts";
import { ProviderAdapterError } from "../errors";
import { providerFetch } from "../http";
import { parseProviderRuntimeConfig } from "../config";

const TTC_ALLOWED_HOSTS = ["tuongtaccheo.com", "www.tuongtaccheo.com"] as const;
const MAX_RESPONSE_BYTES = 2_000_000;
const SUPPORTED_ORDER_TYPES = new Set(["default", "package"]);

type JsonRecord = Record<string, unknown>;

type TTCProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  xuToVndRate?: string;
  rateInputUnit?: number;
  rateUnit?: number;
};

type DecimalRational = { numerator: bigint; denominator: bigint };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return undefined;
}

function integerValue(value: unknown): number | undefined {
  const text = stringValue(value);
  if (!text || !/^-?\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["1", "true", "yes", "y"].includes(text);
}

function parsePositiveDecimal(value: string, field: string): DecimalRational {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", `${field} must be a positive decimal value.`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`);
  if (numerator <= 0n) {
    throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", `${field} must be greater than zero.`);
  }
  return { numerator, denominator };
}

function parseNonNegativeDecimal(value: unknown, field: string): DecimalRational {
  const text = stringValue(value);
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) {
    throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", `TTC returned an invalid ${field}.`);
  }
  const [whole, fraction = ""] = text.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`);
  return { numerator, denominator };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function convertXuRateToVnd(rate: unknown, xuToVndRate: string, rateInputUnit: number, rateUnit: number): bigint {
  const source = parseNonNegativeDecimal(rate, "service rate");
  const conversion = parsePositiveDecimal(xuToVndRate, "TTC_XU_TO_VND_RATE");
  if (!Number.isInteger(rateInputUnit) || rateInputUnit <= 0) {
    throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "TTC_RATE_INPUT_UNIT must be a positive integer.");
  }
  if (!Number.isInteger(rateUnit) || rateUnit <= 0) {
    throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "TTC_RATE_UNIT must be a positive integer.");
  }
  return ceilDiv(
    source.numerator * conversion.numerator * BigInt(rateUnit),
    source.denominator * conversion.denominator * BigInt(rateInputUnit)
  );
}

function parseWholeBalance(value: unknown): bigint {
  const parsed = parseNonNegativeDecimal(value, "balance");
  if (parsed.numerator % parsed.denominator !== 0n) {
    throw new ProviderAdapterError(
      "PROVIDER_MALFORMED_RESPONSE",
      "TTC returned a fractional balance but the current provider balance snapshot stores whole provider currency units."
    );
  }
  return parsed.numerator / parsed.denominator;
}

function providerErrorFromMessage(message: string): ProviderAdapterError {
  const normalized = message.toLowerCase();
  if (/api\s*key|unauthori[sz]ed|authentication|invalid\s*key|incorrect\s*key/.test(normalized)) {
    return new ProviderAdapterError("PROVIDER_UNAUTHORIZED", "TTC rejected the API credential.");
  }
  if (/rate\s*limit|too\s*many\s*request/.test(normalized)) {
    return new ProviderAdapterError("PROVIDER_RATE_LIMIT", "TTC rate limit reached.", { retryable: true });
  }
  if (/balance|insufficient|not\s*enough\s*(fund|money|xu)/.test(normalized)) {
    return new ProviderAdapterError("PROVIDER_INSUFFICIENT_BALANCE", "TTC provider balance is insufficient.");
  }
  if (/service/.test(normalized) && /invalid|incorrect|not\s*found|unavailable|disabled/.test(normalized)) {
    return new ProviderAdapterError("PROVIDER_SERVICE_UNAVAILABLE", "TTC service is unavailable.");
  }
  return new ProviderAdapterError("PROVIDER_INVALID_REQUEST", `TTC rejected the request: ${message.slice(0, 300)}`);
}

function responseError(payload: unknown): ProviderAdapterError | null {
  if (!isRecord(payload)) return null;
  const direct = stringValue(payload.error);
  if (direct) return providerErrorFromMessage(direct);
  const status = stringValue(payload.status)?.toLowerCase();
  const message = stringValue(payload.mess) ?? stringValue(payload.message);
  if (status === "fail" && message) return providerErrorFromMessage(message);
  return null;
}

function normalizePlatform(name: string, category: string): NormalizedProviderService["platform"] {
  const haystack = `${category} ${name}`.toLowerCase();
  if (haystack.includes("facebook")) return "FACEBOOK";
  if (haystack.includes("tiktok")) return "TIKTOK";
  if (haystack.includes("instagram")) return "INSTAGRAM";
  if (haystack.includes("youtube")) return "YOUTUBE";
  if (haystack.includes("thread")) return "THREADS";
  if (haystack.includes("google")) return "GOOGLE";
  return undefined;
}

export function normalizeTTCStatus(rawStatus: string): NormalizedProviderOrderStatus {
  const normalized = rawStatus.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (normalized === "pending") return "PENDING";
  if (normalized === "processing" || normalized === "in progress") return "PROCESSING";
  if (normalized === "completed" || normalized === "complete") return "COMPLETED";
  if (normalized === "partial") return "PARTIAL";
  if (normalized === "canceled" || normalized === "cancelled") return "CANCELLED";
  if (normalized === "refunded" || normalized === "refund") return "REFUNDED";
  if (normalized === "failed" || normalized === "error") return "FAILED";
  return "UNKNOWN";
}

export class TTCProviderAdapter implements ProviderAdapter {
  readonly code = "TTC";
  readonly capabilities: ProviderCapabilities = {
    supportsCreateIdempotency: false,
    supportsClientReference: false,
    supportsLookupByClientReference: false,
    supportsCancel: true,
    supportsRefill: false,
    supportsBalance: true,
    supportsServiceSync: true
  };

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly xuToVndRate: string;
  private readonly rateInputUnit: number;
  private readonly rateUnit: number;

  constructor(config: TTCProviderConfig = {}) {
    const runtime = parseProviderRuntimeConfig();
    this.baseUrl = config.baseUrl ?? runtime.ttc.apiBaseUrl;
    this.apiKey = config.apiKey ?? runtime.ttc.apiKey;
    this.timeoutMs = config.timeoutMs ?? runtime.ttc.httpTimeoutMs;
    this.xuToVndRate = config.xuToVndRate ?? runtime.ttc.xuToVndRate ?? "";
    this.rateInputUnit = config.rateInputUnit ?? runtime.ttc.rateInputUnit ?? 0;
    this.rateUnit = config.rateUnit ?? runtime.ttc.rateUnit;
  }

  private endpoint(): URL {
    if (!this.apiKey) {
      throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "TTC_API_KEY is required.");
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 500 || this.timeoutMs > 120_000) {
      throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "TTC_HTTP_TIMEOUT_MS must be between 500 and 120000 milliseconds.");
    }
    if (!Number.isInteger(this.rateUnit) || this.rateUnit <= 0) {
      throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "TTC_RATE_UNIT must be a positive integer.");
    }
    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch {
      throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "TTC_API_BASE_URL is not a valid URL.");
    }
    if (url.protocol !== "https:" || !TTC_ALLOWED_HOSTS.includes(url.hostname as (typeof TTC_ALLOWED_HOSTS)[number])) {
      throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "TTC_API_BASE_URL must use the allowlisted tuongtaccheo.com HTTPS host.");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new ProviderAdapterError("PROVIDER_CONFIGURATION_MISSING", "TTC_API_BASE_URL must not contain credentials, query parameters or fragments.");
    }
    return url;
  }

  private async post(action: string, fields: Record<string, string> = {}, ambiguousSideEffect = false): Promise<unknown> {
    const url = this.endpoint();
    const body = new URLSearchParams({ key: this.apiKey, action, ...fields });
    const response = await providerFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body
      },
      { timeoutMs: this.timeoutMs, allowHosts: TTC_ALLOWED_HOSTS, ambiguousSideEffect }
    );
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", "TTC response exceeded the maximum accepted size.", { ambiguousSideEffect });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", "TTC returned invalid JSON.", { ambiguousSideEffect, cause });
    }
    return payload;
  }

  async testConnection(): Promise<ProviderConnectionResult> {
    const startedAt = Date.now();
    const balance = await this.getBalance();
    return {
      ok: true,
      latencyMs: Math.max(0, Date.now() - startedAt),
      message: `Connected to TTC API; balance currency ${balance.currency}.`
    };
  }

  async getBalance(): Promise<ProviderBalanceResult> {
    const payload = await this.post("balance");
    const error = responseError(payload);
    if (error) throw error;
    if (!isRecord(payload)) throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", "TTC balance response must be a JSON object.");
    const currency = stringValue(payload.currency);
    if (!currency) throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", "TTC balance response is missing currency.");
    return { amountMinor: parseWholeBalance(payload.balance), currency: currency.toUpperCase().slice(0, 16) };
  }

  async getServices(): Promise<NormalizedProviderService[]> {
    if (!this.xuToVndRate) {
      throw new ProviderAdapterError(
        "PROVIDER_CONFIGURATION_MISSING",
        "TTC_XU_TO_VND_RATE is required before service sync so TTC XU rates can be converted into authoritative VND provider cost."
      );
    }
    parsePositiveDecimal(this.xuToVndRate, "TTC_XU_TO_VND_RATE");
    if (!Number.isInteger(this.rateInputUnit) || this.rateInputUnit <= 0) {
      throw new ProviderAdapterError(
        "PROVIDER_CONFIGURATION_MISSING",
        "TTC_RATE_INPUT_UNIT is required and must be a positive integer before service sync."
      );
    }
    const payload = await this.post("services");
    const error = responseError(payload);
    if (error) throw error;
    if (!Array.isArray(payload)) throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", "TTC services response must be a JSON array.");

    return payload.map((item, index) => {
      if (!isRecord(item)) throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", `TTC service at index ${index} is not an object.`);
      const externalServiceId = stringValue(item.service);
      const name = stringValue(item.name);
      const type = stringValue(item.type) ?? "Default";
      const category = stringValue(item.category) ?? "";
      const min = integerValue(item.min);
      const max = integerValue(item.max);
      if (!externalServiceId || !name || min === undefined || max === undefined || min <= 0 || max < min) {
        throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", `TTC service at index ${index} is missing a valid service/name/min/max.`);
      }
      const normalizedType = type.trim().toLowerCase();
      const supportedOrderType = SUPPORTED_ORDER_TYPES.has(normalizedType);
      return {
        externalServiceId,
        name,
        category: category || undefined,
        platform: normalizePlatform(name, category),
        providerRateMinor: convertXuRateToVnd(item.rate, this.xuToVndRate, this.rateInputUnit, this.rateUnit),
        rateUnit: this.rateUnit,
        currency: "VND",
        min,
        max,
        supportsRefill: booleanValue(item.refill),
        supportsCancel: booleanValue(item.cancel),
        status: supportedOrderType ? "AVAILABLE" : "UNAVAILABLE",
        rawMetadata: {
          type,
          providerCurrency: "XU",
          providerRate: stringValue(item.rate) ?? null,
          refill: booleanValue(item.refill),
          cancel: booleanValue(item.cancel),
          rateInputUnit: this.rateInputUnit,
          normalizedRateUnit: this.rateUnit,
          orderTypeSupported: supportedOrderType
        }
      } satisfies NormalizedProviderService;
    });
  }

  async createOrder(input: ProviderCreateOrderInput): Promise<ProviderCreateOrderResult> {
    const payload = await this.post(
      "add",
      {
        service: input.externalServiceId,
        link: input.target,
        quantity: String(input.quantity)
      },
      true
    );
    const error = responseError(payload);
    if (error) {
      return {
        outcome: "REJECTED",
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        httpStatus: error.httpStatus,
        raw: payload
      };
    }
    if (!isRecord(payload)) {
      return { outcome: "UNKNOWN", code: "PROVIDER_MALFORMED_RESPONSE", message: "TTC create-order response was not a JSON object.", raw: payload };
    }
    const externalOrderId = stringValue(payload.order);
    if (!externalOrderId) {
      return {
        outcome: "UNKNOWN",
        code: "PROVIDER_MALFORMED_RESPONSE",
        message: "TTC create-order response did not include an order ID; submission state is unknown.",
        raw: payload
      };
    }
    return { outcome: "ACCEPTED", externalOrderId, status: "SUBMITTED", raw: payload };
  }

  async getOrderStatus(input: ProviderOrderStatusInput): Promise<ProviderOrderStatusResult> {
    const payload = await this.post("status", { order: input.externalOrderId });
    const error = responseError(payload);
    if (error) throw error;
    if (!isRecord(payload)) throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", "TTC order-status response must be a JSON object.");
    const rawStatus = stringValue(payload.status);
    if (!rawStatus) throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", "TTC order-status response is missing status.");
    const remaining = integerValue(payload.remains);
    const startCount = integerValue(payload.start_count);
    return {
      status: normalizeTTCStatus(rawStatus),
      remaining,
      startCount,
      rawStatus,
      raw: payload
    };
  }

  async cancelOrder(input: ProviderOrderStatusInput): Promise<ProviderOrderStatusResult> {
    const payload = await this.post("cancel", { order: input.externalOrderId });
    const error = responseError(payload);
    if (error) throw error;
    if (!isRecord(payload)) throw new ProviderAdapterError("PROVIDER_MALFORMED_RESPONSE", "TTC cancel response must be a JSON object.");
    return { status: "PENDING", rawStatus: "cancel_requested", raw: payload };
  }
}
