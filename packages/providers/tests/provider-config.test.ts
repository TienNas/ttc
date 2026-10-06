import assert from "node:assert/strict";
import test from "node:test";
import { ProviderAdapterError, parseProviderRuntimeConfig } from "../src/index";

const enabledEnvironment = {
  PROVIDER_ROUTING_ENABLED: "true",
  TTC_API_KEY: "test-key",
  TTC_XU_TO_VND_RATE: "0.0175",
  TTC_RATE_INPUT_UNIT: "1",
  TTC_RATE_UNIT: "1000"
} as const;

function assertConfigurationError(operation: () => unknown, variable: string) {
  assert.throws(operation, (error: unknown) => {
    if (!(error instanceof ProviderAdapterError)) return false;
    assert.equal(error.code, "PROVIDER_CONFIGURATION_MISSING");
    assert.match(error.message, new RegExp(`^${variable} `));
    assert.equal(error.message.includes("test-key"), false);
    return true;
  });
}

test("routing disabled allows TTC credentials and conversion to be absent", () => {
  const config = parseProviderRuntimeConfig({ PROVIDER_ROUTING_ENABLED: "false" });
  assert.equal(config.routingEnabled, false);
  assert.equal(config.ttc.apiKey, "");
  assert.equal(config.ttc.xuToVndRate, undefined);
});

test("routing enabled rejects a missing TTC API key", () => {
  const { TTC_API_KEY: _removed, ...environment } = enabledEnvironment;
  assertConfigurationError(() => parseProviderRuntimeConfig(environment), "TTC_API_KEY");
});

test("routing enabled rejects a missing TTC conversion", () => {
  const { TTC_XU_TO_VND_RATE: _removed, ...environment } = enabledEnvironment;
  assertConfigurationError(() => parseProviderRuntimeConfig(environment), "TTC_XU_TO_VND_RATE");
});

test("TTC conversion must be a strict positive decimal", () => {
  for (const value of ["0", "-1", "+1", "1e3", " 1", "1 "]) {
    assertConfigurationError(
      () => parseProviderRuntimeConfig({ ...enabledEnvironment, TTC_XU_TO_VND_RATE: value }),
      "TTC_XU_TO_VND_RATE"
    );
  }
});

test("TTC HTTP timeout is strictly parsed and bounded", () => {
  for (const value of ["0", "499", "120001", "1000ms", " 1000"]) {
    assertConfigurationError(
      () => parseProviderRuntimeConfig({ ...enabledEnvironment, TTC_HTTP_TIMEOUT_MS: value }),
      "TTC_HTTP_TIMEOUT_MS"
    );
  }
});

test("TTC rate units must be positive integers", () => {
  for (const variable of ["TTC_RATE_UNIT", "TTC_RATE_INPUT_UNIT"] as const) {
    for (const value of ["0", "-1", "1.5", "1e3"]) {
      assertConfigurationError(
        () => parseProviderRuntimeConfig({ ...enabledEnvironment, [variable]: value }),
        variable
      );
    }
  }
});

test("worker timing rejects a lock that can expire during the TTC HTTP timeout", () => {
  assertConfigurationError(
    () => parseProviderRuntimeConfig({
      ...enabledEnvironment,
      TTC_HTTP_TIMEOUT_MS: "10000",
      PROVIDER_JOB_LOCK_TIMEOUT_MS: "10000"
    }),
    "PROVIDER_JOB_LOCK_TIMEOUT_MS"
  );
});

test("worker polling and retry controls reject malformed or unsafe values", () => {
  assertConfigurationError(
    () => parseProviderRuntimeConfig({ ...enabledEnvironment, PROVIDER_WORKER_POLL_MS: "0" }),
    "PROVIDER_WORKER_POLL_MS"
  );
  assertConfigurationError(
    () => parseProviderRuntimeConfig({ ...enabledEnvironment, PROVIDER_JOB_BATCH_SIZE: "1.5" }),
    "PROVIDER_JOB_BATCH_SIZE"
  );
  assertConfigurationError(
    () => parseProviderRuntimeConfig({ ...enabledEnvironment, PROVIDER_MAX_ATTEMPTS: "0" }),
    "PROVIDER_MAX_ATTEMPTS"
  );
  assertConfigurationError(
    () => parseProviderRuntimeConfig({
      ...enabledEnvironment,
      PROVIDER_POLL_INITIAL_MS: "2000",
      PROVIDER_POLL_MAX_MS: "1000"
    }),
    "PROVIDER_POLL_INITIAL_MS"
  );
});
