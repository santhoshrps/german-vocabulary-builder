// /health payload (MS2-FR-30b/30c): environment identity, deployed code version,
// configuration, and a bounded runtime-schema readiness check. The schema query reads
// sqlite metadata only—never learner/operational rows—and is cached per isolate for one
// minute. This catches the otherwise invisible failure class where configuration is valid
// but deployed code references a table/column that was never migrated.
//
// Two tiers:
//   missing  — the worker cannot do its core job without these; any entry is a deploy bug.
//   degraded — optional-with-fallback configuration that is absent: the worker runs, but a
//              documented fallback is active (e.g. no R2 presign quartet → packurl answers
//              503 and clients use the streamed route). Absence must be VISIBLE — this is
//              exactly the class of the prod-missing-R2-secrets incident.

import { Env } from "./env";
import { opsQuery } from "./db";
import {
  isProductionStoreKitPolicy,
  parseStoreKitEnvironmentPolicy,
} from "./storekit-environment";

interface HealthReport {
  status: "ok" | "misconfigured";
  env: string;
  version: string;
  missing: string[];
  degraded: string[];
  storeKitEnvironments: string[];
  opsSchemaMissing: string[];
}

/// Tables used by the read worker plus the additive columns most likely to drift
/// when `CREATE TABLE IF NOT EXISTS` meets an older live database. This is one
/// sqlite-metadata read, independent of user count or catalogue size.
export const REQUIRED_OPS_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  devices: [],
  promo_codes: [],
  submissions: ["client_key", "details", "lang"],
  feedback: ["kind", "contact_email", "contact_expires_at"],
  content_reports: [],
  search_usage: [],
  challenges: [],
  rate_limits: [],
  transaction_devices: [],
  transaction_revocations: ["original_transaction_id", "reason", "recorded_at"],
  promo_claims: [],
  broadcasts: [],
  broadcast_audit: ["descriptor_hash", "envelope_hash"],
  canary_devices: [],
  pending_sends: ["descriptor_hash", "envelope"],
};

const OPS_SCHEMA_CACHE_MS = 60_000;
let opsSchemaCache: {
  database: D1Database;
  checkedAtMS: number;
  missing: string[];
} | undefined;

async function missingOperationalSchema(env: Env): Promise<string[]> {
  const now = Date.now();
  if (opsSchemaCache?.database === env.OPS_DB
      && now - opsSchemaCache.checkedAtMS < OPS_SCHEMA_CACHE_MS) {
    return opsSchemaCache.missing;
  }

  const tableNames = Object.keys(REQUIRED_OPS_SCHEMA);
  const quoted = tableNames.map((name) => `'${name}'`).join(",");
  let missing: string[];
  try {
    const result = await opsQuery(env, `
      SELECT m.name AS table_name, p.name AS column_name
        FROM sqlite_master AS m
        JOIN pragma_table_info(m.name) AS p
       WHERE m.type = 'table' AND m.name IN (${quoted})
    `).all<{ table_name: string; column_name: string }>();
    const columnsByTable = new Map<string, Set<string>>();
    for (const row of result.results ?? []) {
      const columns = columnsByTable.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      columnsByTable.set(row.table_name, columns);
    }
    missing = [];
    for (const [table, columns] of Object.entries(REQUIRED_OPS_SCHEMA)) {
      const actual = columnsByTable.get(table);
      if (!actual) {
        missing.push(`table:${table}`);
        continue;
      }
      for (const column of columns) {
        if (!actual.has(column)) missing.push(`column:${table}.${column}`);
      }
    }
  } catch {
    missing = ["schema-query"];
  }
  opsSchemaCache = { database: env.OPS_DB, checkedAtMS: now, missing };
  return missing;
}

export async function healthReport(env: Env): Promise<HealthReport> {
  const missing: string[] = [];
  const degraded: string[] = [];

  const require = (name: string, value: unknown) => {
    if (value === undefined || value === null || value === "") missing.push(name);
  };
  const prefer = (name: string, value: unknown) => {
    if (value === undefined || value === null || value === "") degraded.push(name);
  };

  require("CONTENT_DB", env.CONTENT_DB);
  require("OPS_DB", env.OPS_DB);
  require("ENV_NAME", env.ENV_NAME);
  require("APP_TEAM_ID", env.APP_TEAM_ID);
  require("APP_BUNDLE_ID", env.APP_BUNDLE_ID);
  require("ENTITLEMENT_PRODUCT_IDS", env.ENTITLEMENT_PRODUCT_IDS);
  require("SESSION_TTL_SECONDS", env.SESSION_TTL_SECONDS);
  require("APP_ATTEST_ENV", env.APP_ATTEST_ENV);
  require("SESSION_JWT_SECRET", env.SESSION_JWT_SECRET);
  if (env.APP_ATTEST_ENV === "production"
      && !isProductionStoreKitPolicy(env.STOREKIT_ACCEPTED_ENVIRONMENTS)) {
    // A live worker without both Apple-signed lanes strands either TestFlight or
    // App Store customers; any Xcode/unknown lane weakens the production boundary.
    missing.push("STOREKIT_ACCEPTED_ENVIRONMENTS(Production,Sandbox)");
  }

  // Apple root CAs: hard requirements wherever real attestations/transactions are
  // verified (production). In dev/test the xcode/development paths can run without
  // them, but their absence still surfaces as degraded.
  if (env.APP_ATTEST_ENV === "production") {
    require("APPLE_APPATTEST_ROOT_CA", env.APPLE_APPATTEST_ROOT_CA);
    require("APPLE_STOREKIT_ROOT_CA", env.APPLE_STOREKIT_ROOT_CA);
  } else {
    prefer("APPLE_APPATTEST_ROOT_CA", env.APPLE_APPATTEST_ROOT_CA);
    prefer("APPLE_STOREKIT_ROOT_CA", env.APPLE_STOREKIT_ROOT_CA);
  }

  prefer("MEDIA", env.MEDIA);
  prefer("R2_ACCOUNT_ID", env.R2_ACCOUNT_ID);
  prefer("R2_MEDIA_BUCKET", env.R2_MEDIA_BUCKET);
  prefer("R2_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID);
  prefer("R2_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY);
  prefer("DEPLOY_VERSION", env.DEPLOY_VERSION);

  const opsSchemaMissing = env.OPS_DB
    ? await missingOperationalSchema(env)
    : ["schema-query"];
  missing.push(...opsSchemaMissing.map((item) => `OPS_DB.${item}`));

  return {
    status: missing.length === 0 ? "ok" : "misconfigured",
    env: env.ENV_NAME ?? "unknown",
    version: env.DEPLOY_VERSION ?? "unknown",
    missing,
    degraded,
    storeKitEnvironments: [
      ...parseStoreKitEnvironmentPolicy(env.STOREKIT_ACCEPTED_ENVIRONMENTS).accepted,
    ].sort(),
    opsSchemaMissing,
  };
}
