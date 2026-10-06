type SeedEnvironment = Record<string, string | undefined>;

export type DevelopmentSeedConfig =
  | { enabled: false }
  | {
      enabled: true;
      customerEmail: string;
      customerPassword: string;
      adminEmail: string;
      adminPassword: string;
      secondaryEmail: string;
      secondaryPassword: string;
    };

function parseSeedFlag(value: string | undefined, nodeEnvironment: string | undefined): boolean {
  if (value === undefined || value === "") {
    return nodeEnvironment === "development" || nodeEnvironment === "test";
  }
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("SEED_DEVELOPMENT_ACCOUNT must be exactly true or false.");
}

function requiredDevelopmentPassword(env: SeedEnvironment, variable: string, fallback: string): string {
  const value = env[variable] ?? fallback;
  if (value.length < 8 || value.length > 200) {
    throw new Error(`${variable} must contain between 8 and 200 characters for development seeding.`);
  }
  return value;
}

export function resolveDevelopmentSeedConfig(env: SeedEnvironment = process.env): DevelopmentSeedConfig {
  const nodeEnvironment = env.NODE_ENV?.trim().toLowerCase();
  const enabled = parseSeedFlag(env.SEED_DEVELOPMENT_ACCOUNT, nodeEnvironment);
  if (!enabled) return { enabled: false };
  if (nodeEnvironment === "production") {
    throw new Error(
      "Development seed accounts are disabled in production. Use a separate audited account-provisioning process."
    );
  }

  return {
    enabled: true,
    customerEmail: (env.SEED_DEVELOPMENT_EMAIL ?? "minh@example.com").trim().toLowerCase(),
    customerPassword: requiredDevelopmentPassword(env, "SEED_DEVELOPMENT_PASSWORD", "demo1234"),
    adminEmail: (env.SEED_ADMIN_EMAIL ?? "admin@example.com").trim().toLowerCase(),
    adminPassword: requiredDevelopmentPassword(env, "SEED_ADMIN_PASSWORD", "Admin1234"),
    secondaryEmail: (env.SEED_DEVELOPMENT_SECOND_EMAIL ?? "lan@example.com").trim().toLowerCase(),
    secondaryPassword: requiredDevelopmentPassword(env, "SEED_DEVELOPMENT_SECOND_PASSWORD", "demo1234")
  };
}
