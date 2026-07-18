// /health payload (MS2-FR-30b/30c): environment identity, deployed code version, and a
// configuration self-check. Deliberately touches NO D1/R2 — it stays a zero-amplification
// unauthenticated probe — so the "check" is presence-of-configuration only (names, never
// values). Wire-verification (scripts/deploy.sh) asserts env + version + config after every
// deploy; the deploy script also refuses to deploy an env whose secret parity fails.
//
// Two tiers:
//   missing  — the worker cannot do its core job without these; any entry is a deploy bug.
//   degraded — optional-with-fallback configuration that is absent: the worker runs, but a
//              documented fallback is active (e.g. no R2 presign quartet → packurl answers
//              503 and clients use the streamed route). Absence must be VISIBLE — this is
//              exactly the class of the prod-missing-R2-secrets incident.

import { Env } from "./env";

interface HealthReport {
  status: "ok" | "misconfigured";
  env: string;
  version: string;
  missing: string[];
  degraded: string[];
}

export function healthReport(env: Env): HealthReport {
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

  return {
    status: missing.length === 0 ? "ok" : "misconfigured",
    env: env.ENV_NAME ?? "unknown",
    version: env.DEPLOY_VERSION ?? "unknown",
    missing,
    degraded,
  };
}
