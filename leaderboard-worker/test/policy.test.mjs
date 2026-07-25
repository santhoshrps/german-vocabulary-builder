#!/usr/bin/env node
// W2 pure-logic tests: nickname policy (NFR-4e/IDENT-4) + social JWT roundtrip.
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "lb-w2-"));
try {
  for (const mod of ["profile", "crypto"]) {
    execSync(`npx --prefix ../read-worker esbuild src/${mod}.ts --bundle --format=esm --outfile=${join(out, mod + ".mjs")}`, { cwd: root, stdio: "pipe" });
  }
  const { sanitizeNickname, validTimeZone } = await import(join(out, "profile.mjs"));
  const { mintJwt, verifyJwt, hashedSubject, b64urlDecode, b64urlEncode } = await import(join(out, "crypto.mjs"));

  // Nickname policy
  assert.equal(sanitizeNickname("  Anna   Schmidt "), "Anna Schmidt");
  assert.equal(sanitizeNickname("Änna🦊"), "Änna🦊");           // letters+emoji fine
  assert.equal(sanitizeNickname(""), null);
  assert.equal(sanitizeNickname("   "), null);
  assert.equal(sanitizeNickname("a".repeat(25)), null);          // > 24
  assert.equal(sanitizeNickname("a​b"), null);              // zero-width
  assert.equal(sanitizeNickname("a‮b"), null);              // bidi override
  assert.equal(sanitizeNickname("!!!"), null);                   // no letter/digit
  assert.equal(sanitizeNickname("Anná".normalize("NFD")), "Anná".normalize("NFC")); // NFC
  assert.ok(validTimeZone("Europe/Berlin") && !validTimeZone("Mars/Olympus"));

  // JWT roundtrip + tamper + wrong secret
  const claims = { sub: "p1", aud: "leaderboard", env: "dev", sv: 1, fam: "f", iat: 1, exp: 2, jti: "j" };
  const token = await mintJwt("secret-a", claims);
  assert.deepEqual(await verifyJwt("secret-a", token), claims);
  assert.equal(await verifyJwt("secret-b", token), null);
  const parts = token.split(".");
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  payload.sub = "attacker";
  const forged = [parts[0], b64urlEncode(new TextEncoder().encode(JSON.stringify(payload))), parts[2]].join(".");
  assert.equal(await verifyJwt("secret-a", forged), null);

  // Identity hash: stable per key, distinct across keys/subjects
  const h1 = await hashedSubject("k1", "apple", "sub1");
  assert.equal(h1, await hashedSubject("k1", "apple", "sub1"));
  assert.notEqual(h1, await hashedSubject("k2", "apple", "sub1"));
  assert.notEqual(h1, await hashedSubject("k1", "apple", "sub2"));
  assert.equal(h1.length, 64);

  console.log("policy.test OK — nickname policy, JWT roundtrip/tamper, identity hash");
} finally {
  rmSync(out, { recursive: true, force: true });
}
