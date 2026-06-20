export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SNAPSHOTS?: R2Bucket;

  // vars
  APP_TEAM_ID: string;
  APP_BUNDLE_ID: string;
  ENTITLEMENT_PRODUCT_IDS: string;
  SESSION_TTL_SECONDS: string;
  APP_ATTEST_ENV: string;
  // StoreKit environment: "production" (verify against Apple Root CA) or "xcode"
  // (local StoreKit Configuration File testing — trusts locally-signed
  // transactions WITHOUT Apple verification or App Attest). NEVER ship "xcode".
  STOREKIT_ENV?: string;

  // secrets
  SESSION_JWT_SECRET: string;
  APPLE_APPATTEST_ROOT_CA?: string; // base64 DER
  APPLE_STOREKIT_ROOT_CA?: string;  // base64 DER
}
