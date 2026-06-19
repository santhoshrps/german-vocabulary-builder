import { Env } from "./env";
import { bytesToB64Url } from "./bytes";

// ---- Challenges (nonces) ----------------------------------------------------
// One-time, short-lived random values used to bind App Attest attestations and
// assertions to a fresh server request (replay defense).

const CHALLENGE_TTL_SECONDS = 300;

export async function issueChallenge(env: Env): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const challenge = bytesToB64Url(raw);
  await env.KV.put(`chal:${challenge}`, "1", { expirationTtl: CHALLENGE_TTL_SECONDS });
  return challenge;
}

// Returns true exactly once per challenge, then consumes it.
export async function consumeChallenge(env: Env, challenge: string): Promise<boolean> {
  if (!challenge) return false;
  const key = `chal:${challenge}`;
  const hit = await env.KV.get(key);
  if (!hit) return false;
  await env.KV.delete(key);
  return true;
}

// ---- Rate limiting ----------------------------------------------------------
// Simple fixed-window counter in KV. Good enough to blunt abuse of the expensive
// auth endpoints; for hard guarantees pair with Cloudflare rate-limiting rules.

export async function rateLimit(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now: number
): Promise<boolean> {
  const window = Math.floor(now / windowSeconds);
  const key = `rl:${bucket}:${window}`;
  const current = parseInt((await env.KV.get(key)) || "0", 10);
  if (current >= limit) return false;
  await env.KV.put(key, String(current + 1), { expirationTtl: windowSeconds * 2 });
  return true;
}
