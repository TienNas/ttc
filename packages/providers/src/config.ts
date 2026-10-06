import { ProviderAdapterError } from "./errors";

const DEFAULT_TTC_API_URL = "https://tuongtaccheo.com/api/v2";
const TTC_ALLOWED_HOSTS = new Set(["tuongtaccheo.com", "www.tuongtaccheo.com"]);

export type Environment = Record<string, string | undefined>;

export interface ProviderRuntimeConfig {
  routingEnabled: boolean;
  workerId?: string;
  workerPollMs: number;
  jobBatchSize: number;
  jobLockTimeoutMs: number;
  maxAttempts: number;
  pollInitialMs: number;
  pollMaxMs: number;
  ttc: {
    apiBaseUrl: string;
    apiKey: string;
    httpTimeoutMs: number;
    xuToVndRate?: string;
    rateUnit: number;
    rateInputUnit?: number;
  };
}

function configurationError(variable: string, requirement: string): ProviderAdapterError {
  return new ProviderAdapterError(
    "PROVIDER_CONFIGURATION_MISSING",
    `${variable} ${requirement}.`
  );
}

function parseBoolean(env: Environment, variable: string, fallback: boolean): boolean {
  const value = env[variable];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw configurationError(variable, "must be exactly true or false");
}

function parseInteger(
  env: Environment,
  variable: string,
  fallback: number | undefined,
  limits: { min: number; max: number }
): number | undefined {
  const value = env[variable];
  if (value === undefined || value === "") return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw configurationError(variable, "must be an unsigned base-10 integer without spaces");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < limits.min || parsed > limits.max) {
    throw configurationError(variable, `must be between ${limits.min} and ${limits.max}`);
  }
  return parsed;
}

function parsePositiveDecimal(env: Environment, variable: string): string | undefined {
  const value = env[variable];
  if (value === undefined || value === "") return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw configurationError(variable, "must be a positive decimal without signs, exponent notation or spaces");
  }
  const [whole, fraction = ""] = value.split(".");
  if (BigInt(`${whole}${fraction}`) <= 0n) {
    throw configurationError(variable, "must be greater than zero");
  }
  return value;
}

function parseWorkerId(env: Environment): string | undefined {
  const value = env.PROVIDER_WORKER_ID;
  if (value === undefined || value === "") return undefined;
  if (value !== value.trim() || value.length > 120 || /[\r\n\0]/.test(value)) {
    throw configurationError("PROVIDER_WORKER_ID", "must be 1-120 trimmed printable characters");
  }
  return value;
}

export function validateTtcApiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("TTC_API_BASE_URL", "must be a valid URL");
  }
  if (url.protocol !== "https:" || !TTC_ALLOWED_HOSTS.has(url.hostname)) {
    throw configurationError("TTC_API_BASE_URL", "must use an allowlisted tuongtaccheo.com HTTPS host");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configurationError("TTC_API_BASE_URL", "must not contain credentials, query parameters or fragments");
  }
  return url.toString().replace(/\/$/, "");
}

export function parseProviderRuntimeConfig(env: Environment = process.env): ProviderRuntimeConfig {
  const routingEnabled = parseBoolean(env, "PROVIDER_ROUTING_ENABLED", false);
  const workerPollMs = parseInteger(env, "PROVIDER_WORKER_POLL_MS", 1_000, { min: 250, max: 60_000 })!;
  const jobBatchSize = parseInteger(env, "PROVIDER_JOB_BATCH_SIZE", 10, { min: 1, max: 100 })!;
  const jobLockTimeoutMs = parseInteger(env, "PROVIDER_JOB_LOCK_TIMEOUT_MS", 300_000, { min: 1, max: 3_600_000 })!;
  const maxAttempts = parseInteger(env, "PROVIDER_MAX_ATTEMPTS", 6, { min: 1, max: 100 })!;
  const pollInitialMs = parseInteger(env, "PROVIDER_POLL_INITIAL_MS", 60_000, { min: 1, max: 86_400_000 })!;
  const pollMaxMs = parseInteger(env, "PROVIDER_POLL_MAX_MS", 1_200_000, { min: 1, max: 86_400_000 })!;
  const httpTimeoutMs = parseInteger(env, "TTC_HTTP_TIMEOUT_MS", 10_000, { min: 500, max: 120_000 })!;
  const rateUnit = parseInteger(env, "TTC_RATE_UNIT", 1_000, { min: 1, max: Number.MAX_SAFE_INTEGER })!;
  const rateInputUnit = parseInteger(env, "TTC_RATE_INPUT_UNIT", undefined, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const xuToVndRate = parsePositiveDecimal(env, "TTC_XU_TO_VND_RATE");
  const apiKey = env.TTC_API_KEY ?? "";

  if (apiKey !== apiKey.trim() || /[\r\n\0]/.test(apiKey)) {
    throw configurationError("TTC_API_KEY", "must not contain surrounding whitespace or control characters");
  }
  if (pollInitialMs > pollMaxMs) {
    throw configurationError("PROVIDER_POLL_INITIAL_MS", "must be less than or equal to PROVIDER_POLL_MAX_MS");
  }
  // A stale job must not be reclaimed while its one provider HTTP request can still be in flight.
  if (jobLockTimeoutMs <= httpTimeoutMs) {
    throw configurationError("PROVIDER_JOB_LOCK_TIMEOUT_MS", "must be greater than TTC_HTTP_TIMEOUT_MS");
  }
  if (routingEnabled && !apiKey) {
    throw configurationError("TTC_API_KEY", "is required when PROVIDER_ROUTING_ENABLED=true");
  }
  if (routingEnabled && !xuToVndRate) {
    throw configurationError("TTC_XU_TO_VND_RATE", "is required when PROVIDER_ROUTING_ENABLED=true");
  }
  if (routingEnabled && rateInputUnit === undefined) {
    throw configurationError("TTC_RATE_INPUT_UNIT", "is required when PROVIDER_ROUTING_ENABLED=true");
  }

  return {
    routingEnabled,
    workerId: parseWorkerId(env),
    workerPollMs,
    jobBatchSize,
    jobLockTimeoutMs,
    maxAttempts,
    pollInitialMs,
    pollMaxMs,
    ttc: {
      apiBaseUrl: validateTtcApiBaseUrl(env.TTC_API_BASE_URL ?? DEFAULT_TTC_API_URL),
      apiKey,
      httpTimeoutMs,
      xuToVndRate,
      rateUnit,
      rateInputUnit
    }
  };
}

export function isProviderRoutingEnabled(env: Environment = process.env): boolean {
  return parseProviderRuntimeConfig(env).routingEnabled;
}
