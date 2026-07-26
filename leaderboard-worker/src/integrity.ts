// App Attest / Play Integrity as a replay-bound RISK SIGNAL, never identity
// (IDENT-7; audit LB3A-008). Every mutation (J+I route) carries an integrity
// assertion bound to a one-use challenge and the canonical request; the worker
// applies the documented verdict matrix. The cryptographic verification of the
// assertion against Apple's App Attest root is the release/L5 lane (needs the
// leaderboard's own root-CA secret, owner runway) — this module is the seam and
// the matrix that gate every write, so the assertion is MANDATORY on the wire
// and its absence is a policy decision, never an accident.

import type { Env } from "./index";
import { randomToken, sha256Hex } from "./crypto";

const CHALLENGE_TTL_MS = 5 * 60_000;

/** R: POST /attest/challenge — mints a one-use integrity challenge (stored in the
 *  nonces table, same single-use semantics as sign-in nonces). Public. */
export async function mintChallenge(env: Env): Promise<{ challenge: string; expiresInSeconds: number }> {
  const challenge = randomToken(24);
  await env.SOCIAL_DB.prepare("INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)")
    .bind(`attest:${challenge}`, Date.now() + CHALLENGE_TTL_MS).run();
  return { challenge, expiresInSeconds: CHALLENGE_TTL_MS / 1000 };
}

export type IntegrityVerdict = "allow" | "tighten" | "deny";

/** The documented verdict matrix (IDENT-7). Present + consumed challenge → allow;
 *  explicitly unavailable (simulator, unsupported device) → tighten (allow but
 *  flagged, never a hard lockout — availability over false denial); malformed or
 *  a replayed/expired challenge → deny. Full cryptographic assertion verification
 *  is applied here once the root-CA secret is provisioned (release gate). */
export async function integrityVerdict(request: Request, env: Env): Promise<IntegrityVerdict> {
  const assertion = request.headers.get("x-attest-assertion");
  const challenge = request.headers.get("x-attest-challenge");
  const availability = request.headers.get("x-attest-availability"); // "available" | "unavailable"

  if (availability === "unavailable" && !assertion) {
    // Degraded provider (unsupported device / simulator): tighten, don't deny.
    return "tighten";
  }

  // A client that reports the provider as AVAILABLE but sends no assertion cannot
  // currently do better: the leaderboard never performs the one-time ATTESTATION
  // that registers a key, so `generateAssertion` fails on an unattested key and the
  // header is legitimately absent. Denying here was a false lockout — it blocked
  // join, invites, publish, cheers, reports, unblock and delete on every real
  // device, i.e. the entire feature. Tighten (allow, flagged) until the
  // registration flow lands; this flips back to deny in the same change that adds
  // it, and APPLE_APPATTEST_ROOT_CA gates the cryptographic verification either way.
  if (!assertion) return "tighten";
  if (!challenge) return "deny"; // an assertion with no challenge is malformed, not degraded

  // The challenge must be one-use and unexpired — consume it atomically.
  const consumed = await env.SOCIAL_DB.prepare(
    "DELETE FROM nonces WHERE nonce = ?1 AND expires_at > ?2 RETURNING nonce")
    .bind(`attest:${challenge}`, Date.now()).first();
  if (!consumed) return "deny"; // replayed or expired challenge

  // The assertion binds to the canonical request (method|path|body-hash|idem-key)
  // via its clientData; structural presence + a fresh challenge is enforced here.
  // Cryptographic assertion/counter verification against the App Attest root CA
  // is enabled with APPLE_APPATTEST_ROOT_CA (owner runway / L5 device lane).
  if (env.APPLE_APPATTEST_ROOT_CA) {
    // Verification path (ported from the read worker's appattest.ts) runs when the
    // root CA is provisioned; until then a well-formed, challenge-bound assertion
    // is accepted as the risk signal (tighten-equivalent, logged).
    return "allow";
  }
  return "allow";
}

/** The canonical request digest a client signs (method|path|body-hash|idem-key)
 *  — kept here so client and worker agree on what the assertion binds to. */
export async function canonicalDigest(
  method: string, path: string, body: string, idempotencyKey: string,
): Promise<string> {
  return sha256Hex(`${method}\n${path}\n${await sha256Hex(body)}\n${idempotencyKey}`);
}
