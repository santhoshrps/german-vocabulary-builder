#!/usr/bin/env node
// Route-enumeration test (LB3-NFR-4f): the deployed
// route table must equal the contract's declaration, and the public allowlist must
// be EXACTLY the contract's — an unauthenticated route cannot ship by accident.
//
// Traceability:
// TS-LB3-ARCH-008 TS-LB3-ARCH-009 TS-LB3-ARCH-011
// TS-LB3-AUTH-005 TS-LB3-DB-015 TS-LB3-SEC-001
// TS-LB3-SEC-002 TS-LB3-SEC-004 TS-LB3-SEC-005
// TS-LB3-SEC-013 TS-LB3-SEC-014 TS-LB3-SEC-017.
//
// Run: npm test  (bundles src/contract.ts via the read worker's esbuild — no deps)

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = mkdtempSync(join(tmpdir(), "lb-contract-"));
try {
  execSync(
    `npx --prefix ../read-worker esbuild src/contract.ts --bundle --format=esm --outfile=${join(out, "contract.mjs")}`,
    { cwd: root, stdio: "pipe" },
  );
  const { ROUTES, ERROR_CODES, BASE } = await import(join(out, "contract.mjs"));

  // 1. The public allowlist is EXACTLY the contract's short list (NFR-4f).
  const publicPaths = ROUTES.filter((r) => r.auth === "public").map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(publicPaths, [
    `GET ${BASE}/capability`,
    `GET ${BASE}/health`,
    `POST ${BASE}/auth/exchange`,
    `POST ${BASE}/auth/nonce`,
    `POST ${BASE}/auth/refresh`,
  ], "public allowlist drifted");

  // 2. Exactly one capability-auth route (delete-status) and one invite-token route (preview).
  assert.deepEqual(ROUTES.filter((r) => r.auth === "capability").map((r) => r.path),
    [`${BASE}/profile/delete-status`]);
  assert.deepEqual(ROUTES.filter((r) => r.auth === "inviteToken").map((r) => r.path),
    [`${BASE}/invites/preview`]);

  // 3. Every other route requires the session (default-deny: no fifth category exists).
  for (const r of ROUTES) {
    assert.ok(["public", "capability", "inviteToken", "session", "sessionIntegrity"].includes(r.auth),
      `route ${r.id} has unknown auth level ${r.auth}`);
  }

  // 4. No duplicates; everything under the versioned namespace; no push/admin/debug routes.
  const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate route");
  for (const r of ROUTES) {
    assert.ok(r.path.startsWith(BASE), `route outside namespace: ${r.path}`);
    assert.ok(!/push|admin|debug|moderat/.test(r.path), `forbidden route family: ${r.path}`);
  }

  // 5. Contract count and closed code registry sanity.
  assert.equal(ROUTES.length, 27, "route count changed — update the contract doc and this test together");
  assert.ok(ERROR_CODES.includes("GENERATION_STALE") && ERROR_CODES.includes("PUBLISH_REBASE_REQUIRED"));
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length, "duplicate error code");

  console.log(`routes.test OK — ${ROUTES.length} routes, ${ERROR_CODES.length} codes, allowlist exact`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
