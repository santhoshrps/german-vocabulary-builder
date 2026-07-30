/// StoreKit transaction worlds accepted by the service.
///
/// Production and Sandbox are both Apple-signed. TestFlight always produces Sandbox
/// transactions even when the app talks to the production API. Xcode transactions are
/// locally signed and are permitted only by the explicitly insecure development-worker
/// path in `entitlement.ts`.
export const STOREKIT_ENVIRONMENTS = ["Production", "Sandbox", "Xcode"] as const;
export type StoreKitEnvironment = typeof STOREKIT_ENVIRONMENTS[number];

export function storeKitEnvironment(value: unknown): StoreKitEnvironment | null {
  return typeof value === "string"
    && (STOREKIT_ENVIRONMENTS as readonly string[]).includes(value)
    ? value as StoreKitEnvironment
    : null;
}

export interface ParsedStoreKitEnvironmentPolicy {
  accepted: Set<StoreKitEnvironment>;
  invalid: string[];
}

export function parseStoreKitEnvironmentPolicy(
  configured: string | undefined,
): ParsedStoreKitEnvironmentPolicy {
  const accepted = new Set<StoreKitEnvironment>();
  const invalid: string[] = [];
  for (const raw of (configured ?? "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    const environment = storeKitEnvironment(value);
    if (environment) accepted.add(environment);
    else invalid.push(value);
  }
  return { accepted, invalid };
}

/// The production worker deliberately supports both Apple-signed lanes and no
/// locally signed lane. This is also consumed by `/health`, so a deployment that
/// loses TestFlight support or enables Xcode fails its post-deploy health gate.
export function isProductionStoreKitPolicy(
  configured: string | undefined,
): boolean {
  const { accepted, invalid } = parseStoreKitEnvironmentPolicy(configured);
  return invalid.length === 0
    && accepted.size === 2
    && accepted.has("Production")
    && accepted.has("Sandbox")
    && !accepted.has("Xcode");
}

/// Backward-compatible operational identity. Existing production claims and
/// revocations were keyed by the bare Apple original transaction id, so Production
/// keeps that representation. Sandbox/Xcode are explicitly namespaced and can never
/// collide with or consume the device slots of a paid App Store transaction.
export function storeKitRecordKey(
  environment: StoreKitEnvironment,
  originalTransactionId: string,
): string {
  return environment === "Production"
    ? originalTransactionId
    : `${environment.toLowerCase()}:${originalTransactionId}`;
}

export function storeKitSubject(
  environment: StoreKitEnvironment,
  originalTransactionId: string,
): string {
  return `storekit:${environment.toLowerCase()}:${originalTransactionId}`;
}
