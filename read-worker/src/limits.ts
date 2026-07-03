// One-time challenges (nonces) + fixed-window rate limiting, backed by D1.
//
// These were previously KV read-modify-write sequences (get → put / get → delete), which
// are NOT atomic and are eventually consistent across PoPs: N concurrent requests could all
// read the same pre-state and all pass — defeating the promo brute-force limit and letting
// a challenge be consumed twice (TOCTOU). D1 is a single-writer SQLite database and each
// statement executes atomically, so a conditional DELETE / upsert-increment decides exactly
// once. Cost: one D1 write per check on low-QPS auth endpoints — correctness over latency.
//
// Tables: `challenges` and `rate_limits` in schema/extra.sql.

import { Env } from "./env";
import { bytesToB64Url } from "./bytes";

// ---- Challenges (nonces) ----------------------------------------------------
// One-time, short-lived random values used to bind App Attest attestations and
// assertions to a fresh server request (replay defense).

const CHALLENGE_TTL_SECONDS = 300;

export async function issueChallenge(env: Env): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const challenge = bytesToB64Url(raw);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO challenges (challenge, expires_at) VALUES (?, ?)"
  ).bind(challenge, now + CHALLENGE_TTL_SECONDS).run();
  // Opportunistic GC of expired nonces (indexed on expires_at; issuance is rate-limited,
  // so this stays cheap and the table never accumulates).
  await env.DB.prepare("DELETE FROM challenges WHERE expires_at <= ?").bind(now).run();
  return challenge;
}

// Returns true exactly ONCE per unexpired challenge: a single conditional DELETE is atomic
// in SQLite, so two concurrent requests replaying the same challenge can never both consume it.
export async function consumeChallenge(env: Env, challenge: string): Promise<boolean> {
  if (!challenge) return false;
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    "DELETE FROM challenges WHERE challenge = ? AND expires_at > ?"
  ).bind(challenge, now).run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- Rate limiting ----------------------------------------------------------
// Fixed-window counter. The atomic upsert increments AND returns the post-increment count
// in one statement, so concurrent requests serialize in D1 and the limit is a hard bound.

export async function rateLimit(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number,
  now: number
): Promise<boolean> {
  const window = Math.floor(now / windowSeconds);
  const key = `${bucket}:${window}`;
  const expiresAt = (window + 2) * windowSeconds; // window end + one grace window
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(bucket) DO UPDATE SET count = count + 1
     RETURNING count`
  ).bind(key, expiresAt).first<{ count: number }>();
  // Fail closed: if D1 didn't answer, don't wave the request through the limiter.
  const count = row?.count ?? limit + 1;
  if (count === 1) {
    // First hit of a fresh window: piggyback GC of dead windows (indexed on expires_at).
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now).run();
  }
  return count <= limit;
}
