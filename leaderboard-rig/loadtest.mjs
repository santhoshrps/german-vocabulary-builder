#!/usr/bin/env node
// Leaderboard capacity rig — load driver (capacity-model.md §7 steps 2–4).
//
// Usage:
//   node loadtest.mjs <worker-url> <rig-token> seed        # fixtures: bytes per shape + fleet seed
//   node loadtest.mjs <worker-url> <rig-token> publish 116 1800   # rate/s, seconds
//   node loadtest.mjs <worker-url> <rig-token> mixed 116 116 600  # writes/s, reads/s, seconds
//   node loadtest.mjs <worker-url> <rig-token> burst 1157 60
//
// Prints p50/p95/p99, error and 429 counts — the numbers that fill the MEASURED
// columns. Run from a machine with a stable connection; latency includes network,
// so record the /publish-reported server-side `ms` percentiles too (also printed).

const [url, token, mode = "publish", aRaw, bRaw, cRaw] = process.argv.slice(2);
if (!url || !token) {
  console.error("usage: node loadtest.mjs <worker-url> <rig-token> <seed|publish|mixed|burst> …");
  process.exit(1);
}

const headers = { "x-rig-token": token };
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

function report(label, wall, server, errors, throttled, total) {
  wall.sort((x, y) => x - y);
  server.sort((x, y) => x - y);
  const line = (name, arr) => arr.length
    ? `${name} p50=${percentile(arr, 50)}ms p95=${percentile(arr, 95)}ms p99=${percentile(arr, 99)}ms`
    : `${name} (none)`;
  console.log(`\n[${label}] n=${total} errors=${errors} 429/503=${throttled}`);
  console.log("  " + line("wall  ", wall));
  console.log("  " + line("server", server));
}

async function runAtRate(label, perSecond, seconds, makeRequest) {
  const wall = [], server = [];
  let errors = 0, throttled = 0, sent = 0;
  const interval = 1000 / perSecond;
  const started = Date.now();
  const inflight = new Set();
  while (Date.now() - started < seconds * 1000) {
    const target = started + sent * interval;
    const delay = target - Date.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    sent += 1;
    const t0 = Date.now();
    const p = makeRequest(sent)
      .then(async (res) => {
        wall.push(Date.now() - t0);
        if (res.status === 429 || res.status === 503) throttled += 1;
        else if (!res.ok && res.status !== 304) errors += 1;
        else if (res.headers.get("content-type")?.includes("json")) {
          const body = await res.json().catch(() => null);
          if (body?.ms !== undefined) server.push(body.ms);
        }
      })
      .catch(() => { errors += 1; })
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
  await Promise.allSettled([...inflight]);
  report(label, wall, server, errors, throttled, sent);
}

const rand = (n) => `rig-${String(Math.floor(Math.random() * n)).padStart(7, "0")}`;
const FLEET = 5000; // seeded player count for load runs; /seed handles fleet-scale sizing

if (mode === "seed") {
  // Fixture bytes per shape (fills capacity §2), then a load-run fleet.
  for (const shape of ["typical", "declared", "envelope"]) {
    const res = await fetch(`${url}/seed?players=5&days=66&shape=${shape}&start=9990000`, { method: "POST", headers });
    console.log(shape, await res.json());
  }
  for (let start = 0; start < FLEET; start += 500) {
    const res = await fetch(`${url}/seed?players=500&days=20&shape=typical&start=${start}`, { method: "POST", headers });
    if (!res.ok) { console.error("seed failed", res.status, await res.text()); process.exit(1); }
    process.stdout.write(`\rseeded ${start + 500}/${FLEET}`);
  }
  await fetch(`${url}/friends?players=${FLEET}`, { method: "POST", headers });
  console.log("\nfleet + friends ready; stats:", await (await fetch(`${url}/stats`, { headers })).json());
} else if (mode === "publish") {
  const rate = Number(aRaw ?? 116), seconds = Number(bRaw ?? 300);
  await runAtRate(`publish ${rate}/s × ${seconds}s`, rate, seconds, () =>
    fetch(`${url}/publish?player=${rand(FLEET)}&shape=declared`, { method: "POST", headers }));
} else if (mode === "mixed") {
  const w = Number(aRaw ?? 116), r = Number(bRaw ?? 116), seconds = Number(cRaw ?? 300);
  await Promise.all([
    runAtRate(`writes ${w}/s`, w, seconds, () =>
      fetch(`${url}/publish?player=${rand(FLEET)}&shape=declared`, { method: "POST", headers })),
    runAtRate(`reads ${r}/s`, r, seconds, () =>
      fetch(`${url}/board?viewer=${rand(FLEET)}`, { headers })),
  ]);
} else if (mode === "burst") {
  const rate = Number(aRaw ?? 1157), seconds = Number(bRaw ?? 60);
  await runAtRate(`burst ${rate}/s × ${seconds}s`, rate, seconds, () =>
    fetch(`${url}/publish?player=${rand(FLEET)}&shape=typical`, { method: "POST", headers }));
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}
