import assert from "node:assert/strict";
import test from "node:test";
import { resolveDevelopmentSeedConfig } from "../src/seed-safety";

test("production does not enable development accounts by default", () => {
  assert.deepEqual(resolveDevelopmentSeedConfig({ NODE_ENV: "production" }), { enabled: false });
});

test("production rejects explicitly enabled development accounts", () => {
  assert.throws(
    () => resolveDevelopmentSeedConfig({ NODE_ENV: "production", SEED_DEVELOPMENT_ACCOUNT: "true" }),
    /disabled in production/
  );
});

test("local development keeps explicit demo seeding convenient", () => {
  const config = resolveDevelopmentSeedConfig({ NODE_ENV: "development", SEED_DEVELOPMENT_ACCOUNT: "true" });
  assert.equal(config.enabled, true);
  if (!config.enabled) return;
  assert.equal(config.customerEmail, "minh@example.com");
  assert.equal(config.adminEmail, "admin@example.com");
});

test("seed flag parsing is strict", () => {
  assert.throws(
    () => resolveDevelopmentSeedConfig({ NODE_ENV: "development", SEED_DEVELOPMENT_ACCOUNT: "TRUE" }),
    /exactly true or false/
  );
});
