export interface Env {
  DB: D1Database;
  SNAPSHOTS?: R2Bucket;
  // Audio (and future image) assets: packs + manifest written by the build
  // pipeline (sync/audio_sync.py). Optional so the worker still boots if unbound.
  MEDIA?: R2Bucket;

  // vars
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
  // streamed `audio/pack` route.
  // vars
  R2_ACCOUNT_ID?: string;      // Cloudflare account id (the r2.cloudflarestorage.com host)
  R2_MEDIA_BUCKET?: string;    // bucket name, e.g. "german-vocabulary-media"
  // secrets (wrangler secret put …): an R2 API token scoped to READ this one bucket
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  // secrets
  SESSION_JWT_SECRET: string;
  APPLE_APPATTEST_ROOT_CA?: string; // base64 DER
  APPLE_STOREKIT_ROOT_CA?: string;  // base64 DER
}
