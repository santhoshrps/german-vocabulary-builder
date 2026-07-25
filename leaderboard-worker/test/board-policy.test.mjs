#!/usr/bin/env node
// Board query/privacy/cache static contract. Exact numeric period behavior is
// exercised by algebra.test and the disposable integration runner.
//
// Traceability:
// TS-LB3-DB-007 TS-LB3-DB-008 TS-LB3-DB-009 TS-LB3-DB-014
// TS-LB3-BOARD-005 TS-LB3-BOARD-006 TS-LB3-BOARD-009
// TS-LB3-BOARD-010 TS-LB3-BOARD-011 TS-LB3-BOARD-012
// TS-LB3-BOARD-013 TS-LB3-BOARD-014 TS-LB3-BOARD-015
// TS-LB3-BOARD-016 TS-LB3-BOARD-017 TS-LB3-BOARD-020
// TS-LB3-SEC-002 TS-LB3-SEC-015 TS-LB3-PERF-002
// TS-LB3-PERF-003 TS-LB3-PERF-004 TS-LB3-PERF-005.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const board = readFileSync(join(root, "src/board.ts"), "utf8");
const contract = readFileSync(join(root, "src/contract.ts"), "utf8");

// Only the verified session actor selects a board; there is no arbitrary
// player-id route or request parameter.
assert.match(board, /const me = ctx\.playerId/);
assert.doesNotMatch(contract, /\/board\/\$\{|\/players\/.*board/);
assert.doesNotMatch(board, /url\.searchParams|request\.json\(/);

// One bounded graph lookup + set-based IN fetches, never per-friend N+1.
assert.match(board, /friendships WHERE a = \?1 OR b = \?1 LIMIT 10/);
assert.match(board, /players WHERE player_id IN/);
assert.match(board, /day_state[\s\S]*player_id IN/);
assert.match(board, /registers WHERE player_id IN/);
assert.match(board, /Promise\.all/);
const queryInsidePlayerLoop = /for \(const id of ids\)[\s\S]{0,500}\.prepare\(/;
assert.equal(queryInsidePlayerLoop.test(board), false, "per-player N+1 query");

// Composite conditional-read basis contains every visible authorization/action
// dimension. A 304 can only happen after this basis is rebuilt.
const etagAt = board.indexOf("const etagBasis");
const conditionalAt = board.indexOf('request.headers.get("if-none-match")');
assert.ok(etagAt >= 0 && conditionalAt > etagAt);
const etagBlock = board.slice(etagAt, conditionalAt);
for (const witness of ["viewerZone", "edges.results", "generation", "revisions", "cheered"]) {
  assert.ok(etagBlock.includes(witness), `ETag omits ${witness}`);
}

// Direct friends receive figures only. Duo detail and graph metadata never
// enter a friend row.
assert.match(board, /duoDays:\s*undefined/);
for (const forbidden of ["email", "provider", "subject", "friendsOfFriend", "blocks"]) {
  assert.equal(board.includes(`${forbidden}:`), false);
}

// Poison isolation applies to both day blobs and register JSON. One malformed
// row must not turn the entire authorized board into INTERNAL.
assert.match(board, /decodeDayComponent[\s\S]*catch \{/);
const registerParseAt = board.indexOf("JSON.parse(text)");
assert.ok(registerParseAt >= 0);
const registerGuard = board.slice(Math.max(0, registerParseAt - 250), registerParseAt + 250);
assert.match(registerGuard, /try\s*\{|safeParse|catch/,
  "malformed register JSON can wedge every viewer board");

// Viewer-zone ranges are computed once and applied identically to every row.
assert.equal((board.match(/viewerRanges\(/g) ?? []).length, 1);
assert.match(board, /const ranges = viewerRanges\(viewerZone/);
assert.match(board, /componentPointsIn\(c, day, range\)/);
assert.doesNotMatch(board, /viewerRanges\(.*earner|viewerRanges\(.*player/i);

// Visible values are clamped from the generated envelope rather than a manual
// board-only magic number.
assert.match(board, /ENVELOPE_V1\.dailyCeiling \* 7/);
assert.match(board, /ENVELOPE_V1\.dailyCeiling \* 31/);

console.log("board-policy.test OK — direct graph, set queries, ETag, poison isolation, viewer range");
