export interface Env {
  // Split databases (MS2-FR-29/29b). CONTENT_DB holds the published vocabulary
  // (verbs/nouns/adverbs_adjectives + meta) and is read-only for this worker —
  // all access goes through src/db.ts capabilities, never these bindings directly.
  // OPS_DB holds operational state (devices, promo codes/claims, submissions,
  // feedback, search_usage, challenges, rate_limits, transaction_devices).
  CONTENT_DB: D1Database;
  OPS_DB: D1Database;
  SNAPSHOTS?: R2Bucket;
  // Audio (and future image) assets: packs + manifest written by the build
  // pipeline (sync/audio_sync.py). Optional so the worker still boots if unbound.
  MEDIA?: R2Bucket;

  // vars
  // Environment identity (MS2-FR-30): "prod" | "dev" | "test". Stamped into the
  // session-JWT issuer (a dev-minted token is rejected by prod even if secrets
  // were ever confused) and reported by /health so wire-verification can assert
  // which world it hit.
  ENV_NAME: string;
  // Deployed code identity (MS2-FR-30c): git SHA injected by scripts/deploy.sh
  // (`wrangler deploy --var DEPLOY_VERSION:<sha>`), reported by /health. Absent
  // only on ad-hoc deploys, which the deploy script exists to prevent.
  DEPLOY_VERSION?: string;
  // Forward-compat floor (MS2-FR-23): the minimum app content-schema generation
  // this backend still serves. Bumped ONLY for a truly breaking content change;
  // older apps then show a friendly "update the app" state instead of failing
  // weirdly. Absent → 1.
  MIN_CLIENT_GENERATION?: string;
  APP_TEAM_ID: string;
  APP_BUNDLE_ID: string;
  ENTITLEMENT_PRODUCT_IDS: string;
  SESSION_TTL_SECONDS: string;
  APP_ATTEST_ENV: string;
  // StoreKit environment: "production" (verify against Apple Root CA) or "xcode"
  // (local StoreKit Configuration File testing — trusts locally-signed
  // transactions WITHOUT Apple verification or App Attest). "xcode" is honored
  // ONLY when APP_ATTEST_ENV !== "production" (see storeKitXcodeMode in
  // entitlement.ts), so it can never take effect on a production deployment.
  STOREKIT_ENV?: string;

  // Direct-from-storage pack delivery (MS-NFR-PERF-3): the worker authorizes and mints a
  // short-lived presigned R2 URL; the client downloads the bytes straight from R2 so the
  // worker never sits in the byte path (it was measured pacing every stream). All optional:
  // when any is missing, `audio/packurl` answers 503 and clients fall back to the legacy
  // streamed `audio/pack` route — and /health reports the gap as "degraded" so the
  // fallback state is visible instead of silent (the prod-missing-R2-secrets incident).
  // vars
  R2_ACCOUNT_ID?: string;      // Cloudflare account id (the r2.cloudflarestorage.com host)
  R2_MEDIA_BUCKET?: string;    // bucket name, e.g. "german-media-prod"
  // secrets (wrangler secret put …): an R2 API token scoped to READ this one bucket
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  // secrets
  SESSION_JWT_SECRET: string;
  // Previous signing key, honored for VERIFICATION only during a rotation grace
  // window (MS2-FR-30e): rotate by moving the current value here and putting a
  // fresh value in SESSION_JWT_SECRET; delete this once the window (≥ session
  // TTL) has passed. Minting always uses SESSION_JWT_SECRET.
  SESSION_JWT_SECRET_PREVIOUS?: string;
  APPLE_APPATTEST_ROOT_CA?: string; // base64 DER
  APPLE_STOREKIT_ROOT_CA?: string;  // base64 DER
}
