import { b64UrlToBytes, bytesToB64Url, timingSafeEqualBytes, utf8 } from "./bytes";
import { SessionClaims } from "./jwt";
import { StoreKitEnvironment } from "./storekit-environment";

type SnapshotGrantClaims = {
  typ: "snapshot-blocks";
  sub: string;
  scope: string;
  storeKitEnvironment?: StoreKitEnvironment;
  language: string;
  snapshot: string;
  exp: number;
};

const SHA256 = /^[0-9a-f]{64}$/;

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signature(secret: string, payload: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    utf8(`snapshot-grant-v1.${payload}`),
  ));
}

/// One fresh App Attest assertion authorizes one immutable snapshot, not every
/// individual 500–1,000-row block. The short-lived stateless grant remains bound
/// to the session subject, scope, language and exact snapshot ID.
export async function mintSnapshotGrant(
  secret: string,
  session: SessionClaims,
  snapshot: string,
  language: string,
  now: number,
): Promise<string> {
  if (!SHA256.test(snapshot)) throw new Error("invalid snapshot grant identity");
  const claims: SnapshotGrantClaims = {
    typ: "snapshot-blocks",
    sub: session.sub,
    scope: session.scope,
    ...(session.sk_env ? { storeKitEnvironment: session.sk_env } : {}),
    language,
    snapshot,
    exp: Math.min(session.exp, now + 3_600),
  };
  const payload = bytesToB64Url(utf8(JSON.stringify(claims)));
  return `${payload}.${bytesToB64Url(await signature(secret, payload))}`;
}

export async function verifySnapshotGrant(
  secrets: readonly string[],
  token: string,
  session: SessionClaims,
  snapshot: string,
  language: string,
  now: number,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2 || !SHA256.test(snapshot)) return false;
  const [payload, signaturePart] = parts;
  let supplied: Uint8Array;
  let claims: SnapshotGrantClaims;
  try {
    supplied = b64UrlToBytes(signaturePart);
    claims = JSON.parse(
      new TextDecoder().decode(b64UrlToBytes(payload)),
    ) as SnapshotGrantClaims;
  } catch {
    return false;
  }
  if (claims.typ !== "snapshot-blocks"
      || claims.sub !== session.sub
      || claims.scope !== session.scope
      || claims.storeKitEnvironment !== session.sk_env
      || claims.language !== language
      || claims.snapshot !== snapshot
      || !Number.isSafeInteger(claims.exp)
      || claims.exp <= now
      || claims.exp > session.exp) {
    return false;
  }
  for (const secret of secrets) {
    if (!secret) continue;
    if (timingSafeEqualBytes(supplied, await signature(secret, payload))) {
      return true;
    }
  }
  return false;
}
