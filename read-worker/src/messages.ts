// Broadcast messages v2 (docs/push-messaging.md §6/§8, review-hardened).
//
// Doors:
//   GET  /v1/messages           — PUSH-15 manifest: ≤20 current message envelopes
//                                 PLUS ≤20 active revoke controls (PM-SPEC-005),
//                                 and server_time (max-age 60, inside the
//                                 client's declared uncertainty).
//   POST /v1/admin/broadcast    — the ONE sender: descriptor-hash pinning
//                                 (PUSH-20), mandatory same-UTC-day dry-run,
//                                 CONFIRMED canary before all in prod
//                                 (PM-SPEC-007/012: op "confirm_canary", valid
//                                 the confirm UTC day and the next), UTC-epoch
//                                 caps counting DISTINCT published campaigns
//                                 (PM-SPEC-011), revoke ops (PUSH-19),
//                                 scheduling (PUSH-22) with stable retry
//                                 envelopes, full-payload size gate (PUSH-28).
//   POST /v1/admin/canary       — register/list owner canary device tokens
//                                 (PUSH-21: token-directed, never a topic).
//
// The sender still holds NO copy for greetings and only bounded plain text for
// notices; the client re-validates everything (nothing here can bypass the app).

import type { Env } from "./env";
import { json } from "./http";

const TEMPLATES = new Set([
  "new_content", "feature_note",
  "greeting_christmas", "greeting_new_year", "greeting_advent", "greeting_nikolaus",
  "greeting_unity_day", "greeting_oktoberfest", "greeting_karneval", "greeting_easter",
  "greeting_lunar_new_year", "greeting_diwali", "greeting_eid", "greeting_hanukkah",
  "greeting_holi", "greeting_nowruz", "greeting_halloween", "greeting_valentine",
  "greeting_thanksgiving", "greeting_thanks", "greeting_hello", "greeting_milestone",
]);
const GREETINGS = new Set([...TEMPLATES].filter((t) => t.startsWith("greeting_")));
const DISMISS = new Set(["ack", "expiry"]);
const ROUTES = new Set(["none", "today", "learn", "focus", "words", "insights"]);
const MAX_TTL_HOURS = 7 * 24;
const SENDS_PER_DAY_CAP = 2;
const MAX_ENVELOPE_BYTES = 3072;
const MAX_PROVIDER_BYTES = 4000; // wrapper margin under the 4096 platform ceiling
const MAX_ADMIN_BODY = 8192;
const MAX_SCHEDULE_DAYS = 30;
const MAX_SCHEDULE_ATTEMPTS = 5;
const MAX_SCHEDULE_QUEUE = 64;   // PM-SPEC-005 (owner-ratified): ≤ 64 waiting

// ---- manifest ---------------------------------------------------------------

export async function handleMessagesManifest(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  // PM-SPEC-005 (owner-ratified): messages and revoke CONTROLS are bounded
  // SEPARATELY (≤20 each, oldest-issued first) — a message flood can never
  // crowd a retraction out of the manifest.
  const rows = await env.OPS_DB
    .prepare("SELECT envelope FROM broadcasts WHERE expires_at > ?1 AND json_extract(envelope, '$.op') IS NULL ORDER BY created_at ASC LIMIT 20")
    .bind(now)
    .all<{ envelope: string }>();
  const revokeRows = await env.OPS_DB
    .prepare("SELECT envelope FROM broadcasts WHERE expires_at > ?1 AND json_extract(envelope, '$.op') = 'revoke' ORDER BY created_at ASC LIMIT 20")
    .bind(now)
    .all<{ envelope: string }>();
  const envelopes = (rows.results ?? []).map((r) => JSON.parse(r.envelope));
  const revokes = (revokeRows.results ?? []).map((r) => JSON.parse(r.envelope));
  // server_time inside the body: with max-age 60 its staleness stays within the
  // client's declared +60 s uncertainty (AN-FR-PUSH-23).
  return json({ messages: envelopes, revokes, server_time: now }, 200,
              { "cache-control": "public, max-age=60" });
}

// ---- admin: canary device registry (PUSH-21) -------------------------------

export async function handleAdminCanary(env: Env, request: Request): Promise<Response> {
  const auth = await requireAdmin(env, request);
  if (!auth.ok) return auth.response;
  let body: { token?: string; label?: string };
  try {
    body = await readBoundedJSON(request);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const token = (body.token ?? "").trim();
  if (token.length < 32 || token.length > 4096) return json({ error: "bad token" }, 400);
  await env.OPS_DB
    .prepare("INSERT OR REPLACE INTO canary_devices (token, label) VALUES (?1, ?2)")
    .bind(token, (body.label ?? "owner").slice(0, 40))
    .run();
  const count = await env.OPS_DB
    .prepare("SELECT COUNT(*) AS n FROM canary_devices").first<{ n: number }>();
  return json({ outcome: "registered", devices: count?.n ?? 0 });
}

// ---- admin: broadcast (send / revoke / schedule / cancel) ------------------

interface BroadcastRequest {
  op?: string;                 // absent/"send" | "revoke" | "cancel_scheduled" | "confirm_canary"
  template?: string;
  ttl_hours?: number;
  title?: Record<string, string>;
  body?: Record<string, string>;
  decoration?: string;
  stackable?: boolean;
  dismiss?: string;
  route?: string;
  icon?: string;
  min_build?: number;
  audience?: string;           // "canary" | "all" (default all)
  dry_run?: boolean;
  confirm?: string;            // "SEND"
  preview?: string;            // the pinned descriptor hash (PUSH-20)
  send_at?: number;            // unix seconds, ≤ 30 days out (PUSH-22)
  target_collapse?: string;    // revoke
  cancel_id?: string;          // cancel_scheduled
  note?: string;
}

export async function handleAdminBroadcast(env: Env, request: Request): Promise<Response> {
  const auth = await requireAdmin(env, request);
  if (!auth.ok) return auth.response;
  let body: BroadcastRequest;
  try {
    body = await readBoundedJSON(request);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const day = utcDay(now);

  if (body.op === "cancel_scheduled") {
    const id = body.cancel_id ?? "";
    const result = await env.OPS_DB
      .prepare("UPDATE pending_sends SET status = 'cancelled' WHERE id = ?1 AND status = 'pending'")
      .bind(id).run();
    const cancelled = (result.meta.changes ?? 0) > 0;
    await audit(env, id, "-", cancelled ? "cancelled" : "cancel_miss", body.note ?? "", auth.actor);
    return json({ outcome: cancelled ? "cancelled" : "not_pending" }, cancelled ? 200 : 404);
  }

  if (body.op === "confirm_canary") {
    // PM-SPEC-007 (owner 2026-07-24): "sent" is not "looked at". After the
    // canary lands on an owner device, this explicit confirm writes the audited
    // I-SAW-IT row the all-audience gate requires. PM-SPEC-012: the
    // confirmation is valid on its own UTC day AND the next — an evening
    // canary covers a next-morning scheduled send, never anything older.
    const hash = body.preview ?? "";
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return json({ error: "preview (descriptor hash from dry-run) required" }, 400);
    }
    const canarySentToday = await countAuditForHash(env, ["canary_sent"], day, hash);
    if (canarySentToday === 0) {
      await audit(env, "-", "-", "confirm_refused", "no canary sent today for this descriptor",
                  auth.actor, hash, null);
      return json({ error: "send audience=canary for this descriptor first (same UTC day)" }, 428);
    }
    await audit(env, "-", "-", "canary_confirmed", body.note ?? "", auth.actor, hash, null);
    return json({ outcome: "canary_confirmed", descriptor_hash: hash,
                  valid: "this UTC day and the next" });
  }

  if (body.op === "revoke") {
    // Cap-exempt control message (PUSH-19): manifest row + topic push.
    const target = (body.target_collapse ?? "").trim();
    // PM-SPEC-005: campaign names are ^[a-z0-9_]{1,32}$ — the client refuses
    // anything else, so the sender must too.
    if (!/^[a-z0-9_]{1,32}$/.test(target)) return json({ error: "bad target_collapse" }, 400);
    const revoke = {
      v: 2, op: "revoke", id: crypto.randomUUID(),
      target_collapse: target, revoked_through: now,
      issued_at: now, expires_at: now + MAX_TTL_HOURS * 3600,
    };
    if (body.dry_run !== false) {
      await audit(env, revoke.id, target, "revoke_dry_run", body.note ?? "", auth.actor);
      return json({ outcome: "dry_run", revoke });
    }
    await env.OPS_DB
      .prepare("INSERT INTO broadcasts (id, envelope, expires_at) VALUES (?1, ?2, ?3)")
      .bind(revoke.id, JSON.stringify(revoke), revoke.expires_at).run();
    try {
      await fcmSend(env, { topic: topicFor(env) }, revoke);
      await audit(env, revoke.id, target, "revoked", body.note ?? "", auth.actor);
      return json({ outcome: "revoked", revoke });
    } catch (error) {
      await audit(env, revoke.id, target, "fcm_error", String(error), auth.actor);
      return json({ outcome: "manifest_only", error: String(error), revoke }, 502);
    }
  }

  // ---- send path: validate the DESCRIPTOR (execution materializes the rest)
  const descriptor = normalizeDescriptor(body);
  if ("error" in descriptor) return json({ error: descriptor.error }, 400);
  const hash = await descriptorHash(descriptor.value);

  // Full-payload budget (PUSH-28): preview the exact provider shape.
  const sample = materialize(descriptor.value, now);
  const sampleBytes = new TextEncoder().encode(JSON.stringify(sample)).length;
  const providerBytes = new TextEncoder()
    .encode(JSON.stringify(fcmBody({ topic: topicFor(env) }, sample))).length;
  if (sampleBytes > MAX_ENVELOPE_BYTES || providerBytes > MAX_PROVIDER_BYTES) {
    await audit(env, "-", descriptor.value.template, "refused_size",
                `${sampleBytes}/${providerBytes}B`, auth.actor);
    return json({ error: "payload exceeds the provider budget", envelope_bytes: sampleBytes,
                  provider_bytes: providerBytes }, 413);
  }

  if (body.dry_run !== false || body.confirm !== "SEND") {
    await audit(env, "-", descriptor.value.template, "dry_run", body.note ?? "", auth.actor,
                hash, null);
    return json({ outcome: "dry_run", descriptor: descriptor.value,
                  descriptor_hash: hash, sample_envelope: sample,
                  provider_bytes: providerBytes, would_topic: topicFor(env) });
  }
  // PUSH-20: the pinned hash must match — any drift refuses.
  if (body.preview !== hash) {
    await audit(env, "-", descriptor.value.template, "refused_hash", body.note ?? "",
                auth.actor, hash, null);
    return json({ error: "descriptor drifted since dry-run — re-review", expected: hash }, 409);
  }
  const dryToday = await countAudit(env, ["dry_run"], day, descriptor.value.template);
  if (dryToday === 0) {
    await audit(env, "-", descriptor.value.template, "refused_confirm", "no dry-run today",
                auth.actor, hash, null);
    return json({ error: "dry-run first (same UTC day)" }, 428);
  }

  // Scheduling (PUSH-22): store the pinned descriptor; the cron materializes.
  if (body.send_at) {
    if (body.send_at < now || body.send_at > now + MAX_SCHEDULE_DAYS * 86_400) {
      return json({ error: "send_at out of range (≤ 30 days ahead)" }, 400);
    }
    const waiting = await env.OPS_DB
      .prepare("SELECT COUNT(*) AS n FROM pending_sends WHERE status = 'pending'")
      .first<{ n: number }>();
    if ((waiting?.n ?? 0) >= MAX_SCHEDULE_QUEUE) {
      return json({ error: `scheduled queue full (${MAX_SCHEDULE_QUEUE} waiting)` }, 429);
    }
    const id = crypto.randomUUID();
    await env.OPS_DB
      .prepare("INSERT INTO pending_sends (id, descriptor, descriptor_hash, audience, send_at, status, attempts) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0)")
      .bind(id, JSON.stringify(descriptor.value), hash,
            body.audience === "canary" ? "canary" : "all", body.send_at).run();
    await audit(env, id, descriptor.value.template, "scheduled",
                `at ${new Date(body.send_at * 1000).toISOString()}`, auth.actor, hash, null);
    return json({ outcome: "scheduled", id, send_at: body.send_at, descriptor_hash: hash });
  }

  return await executeSend(env, descriptor.value, hash,
                           body.audience === "canary" ? "canary" : "all",
                           body.note ?? "", auth.actor);
}

// One send path for immediate AND scheduled execution (PUSH-22). A retry of
// one logical scheduled send passes its stored envelope back in as `retryOf`
// (PM-SPEC-011: one stable id across retries, so client dedup makes any
// provider ambiguity harmless).
async function executeSend(env: Env, descriptor: Descriptor, hash: string,
                           audience: "canary" | "all", note: string,
                           actor: string,
                           retryOf?: MaterializedEnvelope): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const day = utcDay(now);
  const envelope = retryOf ?? materialize(descriptor, now);
  const envelopeHash = await sha256hex(canonical(envelope));
  // A retry whose campaign is ALREADY published (manifest row exists) skips
  // every gate — the campaign happened; only the push delivery is retried.
  const alreadyPublished = audience === "all" && retryOf !== undefined
    ? (await env.OPS_DB.prepare("SELECT 1 AS one FROM broadcasts WHERE id = ?1")
        .bind(envelope.id).first<{ one: number }>()) !== null
    : false;
  if (audience === "all" && !alreadyPublished) {
    // Prod ritual (PM-SPEC-007/012 resolved): a CONFIRMED canary of THIS
    // descriptor, confirmed on the execution UTC day or the immediately
    // preceding one, precedes every all-audience send — scheduled or not.
    if (env.ENV_NAME === "prod") {
      const windowStart = utcDay(now - 86_400);
      const confirmed = await countAuditForHash(env, ["canary_confirmed"], windowStart, hash);
      if (confirmed === 0) {
        await audit(env, "-", descriptor.template, "refused_no_canary", note, actor, hash, null);
        return json({ error: "confirmed canary first: dry-run → audience=canary → SEE it → op=confirm_canary (valid that UTC day and the next)" }, 428);
      }
    }
    // PM-SPEC-011: one logical campaign per descriptor per UTC day — after an
    // ambiguous provider outcome the campaign is already riding the manifest,
    // so a same-day re-send of the identical descriptor refuses instead of
    // publishing a second card.
    const publishedSameDescriptor = await countAuditForHash(
      env, ["sent", "manifest_only"], day, hash);
    if (publishedSameDescriptor > 0) {
      await audit(env, "-", descriptor.template, "refused_already_sent",
                  "identical descriptor already published today", actor, hash, null);
      return json({ error: "this exact campaign already went out today — the manifest is delivering it; revoke to retract" }, 409);
    }
    // PUSH-13 + PM-SPEC-011: the cap counts DISTINCT PUBLISHED campaigns
    // (outcomes sent/manifest_only by envelope id) — retries and ambiguous
    // provider outcomes can neither double-charge nor reopen the epoch.
    const publishedToday = await countPublishedCampaigns(env, day);
    if (publishedToday >= SENDS_PER_DAY_CAP) {
      await audit(env, "-", descriptor.template, "refused_cap", `cap ${SENDS_PER_DAY_CAP}/day`,
                  actor, hash, null);
      return json({ error: "daily campaign cap reached (UTC day)" }, 429);
    }
  }
  if (audience === "canary") {
    const tokens = await env.OPS_DB
      .prepare("SELECT token FROM canary_devices").all<{ token: string }>();
    const list = (tokens.results ?? []).map((r) => r.token);
    if (list.length === 0) {
      await audit(env, envelope.id, descriptor.template, "refused_no_canary_devices",
                  note, actor, hash, envelopeHash);
      return json({ error: "no canary devices registered (POST /v1/admin/canary)" }, 428);
    }
    let delivered = 0;
    let lastError = "";
    for (const token of list) {
      try {
        await fcmSend(env, { token }, envelope);
        delivered += 1;
      } catch (error) {
        lastError = String(error);
      }
    }
    const outcome = delivered > 0 ? "canary_sent" : "canary_error";
    await audit(env, envelope.id, descriptor.template, outcome,
                `${delivered}/${list.length} ${lastError.slice(0, 120)}`, actor, hash, envelopeHash);
    return json({ outcome, delivered, devices: list.length, envelope }, delivered > 0 ? 200 : 502);
  }
  // All-audience: manifest FIRST (sync always carries it), then the topic push.
  // OR IGNORE keeps publication idempotent for a retried logical send.
  await env.OPS_DB
    .prepare("INSERT OR IGNORE INTO broadcasts (id, envelope, expires_at) VALUES (?1, ?2, ?3)")
    .bind(envelope.id, JSON.stringify(envelope), envelope.expires_at).run();
  try {
    await fcmSend(env, { topic: topicFor(env) }, envelope);
  } catch (error) {
    // PM-SPEC-011: the provider outcome is UNKNOWN/failed but the campaign IS
    // published (manifest). The row counts the publication exactly once (by
    // id); the push may be retried with the SAME envelope, never re-published.
    await audit(env, envelope.id, descriptor.template, "manifest_only", String(error),
                actor, hash, envelopeHash);
    return json({ outcome: "manifest_only", error: String(error), envelope }, 502);
  }
  await audit(env, envelope.id, descriptor.template, "sent", note, actor, hash, envelopeHash);
  return json({ outcome: "sent", envelope, topic: topicFor(env),
                descriptor_hash: hash, envelope_hash: envelopeHash });
}

/// The cron entry (wrangler [triggers]): fire due scheduled sends through the
/// IDENTICAL path; bounded retries, every attempt audited (PUSH-22).
export async function processScheduledSends(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const due = await env.OPS_DB
    .prepare("SELECT id, descriptor, descriptor_hash, audience, attempts, envelope FROM pending_sends WHERE status = 'pending' AND send_at <= ?1 LIMIT 5")
    .bind(now)
    .all<{ id: string; descriptor: string; descriptor_hash: string; audience: string;
           attempts: number; envelope: string | null }>();
  for (const row of due.results ?? []) {
    const descriptor = JSON.parse(row.descriptor) as Descriptor;
    // PM-SPEC-011: ONE stable logical envelope per scheduled send — materialized
    // on the first attempt and stored DURABLY before any provider call, so every
    // retry reuses the same id and client dedup absorbs any double delivery.
    let stored = row.envelope ? JSON.parse(row.envelope) as MaterializedEnvelope : null;
    if (!stored) {
      stored = materialize(descriptor, now);
      await env.OPS_DB
        .prepare("UPDATE pending_sends SET envelope = ?2 WHERE id = ?1")
        .bind(row.id, JSON.stringify(stored)).run();
    }
    const response = await executeSend(env, descriptor, row.descriptor_hash,
                                       row.audience === "canary" ? "canary" : "all",
                                       `scheduled ${row.id}`, "cron", stored);
    const outcome = (await response.json<{ outcome?: string }>()).outcome ?? "error";
    if (outcome === "sent" || outcome === "canary_sent") {
      await env.OPS_DB.prepare("UPDATE pending_sends SET status = 'done' WHERE id = ?1")
        .bind(row.id).run();
      // Traceability row for the schedule itself; the CAP counts the
      // executeSend "sent" row by envelope id, never this one (PM-SPEC-011).
      await audit(env, row.id, descriptor.template, "sent_scheduled", "", "cron",
                  row.descriptor_hash, null);
    } else if (row.attempts + 1 >= MAX_SCHEDULE_ATTEMPTS) {
      // PM-SPEC-011/012 terminal row: the schedule is dead — either the canary
      // window never opened or the provider stayed unknown/failed through every
      // bounded attempt. If the campaign reached the manifest it stays
      // published (revoke to retract); it never fires again.
      await env.OPS_DB.prepare("UPDATE pending_sends SET status = 'failed' WHERE id = ?1")
        .bind(row.id).run();
      await audit(env, row.id, descriptor.template, "scheduled_gave_up",
                  `after ${MAX_SCHEDULE_ATTEMPTS}: ${outcome}`, "cron", row.descriptor_hash, null);
    } else {
      await env.OPS_DB.prepare("UPDATE pending_sends SET attempts = attempts + 1 WHERE id = ?1")
        .bind(row.id).run();
    }
  }
}

// ---- descriptor / envelope --------------------------------------------------

interface Descriptor {
  template: string;
  ttl_hours: number;
  title?: Record<string, string>;
  body?: Record<string, string>;
  decoration?: string;
  stackable?: boolean;
  dismiss?: string;
  route?: string;
  icon?: string;
  min_build?: number;
}

function normalizeDescriptor(body: BroadcastRequest): { value: Descriptor } | { error: string } {
  const template = body.template ?? "";
  if (!TEMPLATES.has(template)) return { error: "unknown template" };
  const ttl = body.ttl_hours ?? 24;
  if (!(ttl >= 1 && ttl <= MAX_TTL_HOURS)) return { error: "bad ttl" };
  if (body.dismiss !== undefined && !DISMISS.has(body.dismiss)) return { error: "bad dismiss" };
  if (body.route !== undefined && !ROUTES.has(body.route)) return { error: "bad route" };
  // PM-SPEC-005 (owner-ratified): min_build is a whole number 1…999,999,999.
  if (body.min_build !== undefined
      && (!Number.isInteger(body.min_build)
          || body.min_build < 1 || body.min_build > 999_999_999)) {
    return { error: "bad min_build (1…999999999)" };
  }
  const isGreeting = GREETINGS.has(template);
  if (isGreeting && (body.title || body.body)) return { error: "greetings never carry text" };
  if (isGreeting && body.route && body.route !== "none") return { error: "greetings never route" };
  for (const variants of [body.title, body.body]) {
    if (!variants) continue;
    if (!variants.en) return { error: "en variant required" };
    if (Object.keys(variants).length > 8) return { error: "too many variants" };
    for (const [lang, text] of Object.entries(variants)) {
      if (!/^[a-z]{2}$/.test(lang)) return { error: `bad language key ${lang}` };
      const max = variants === body.title ? 40 : 120;
      if (!isPlainText(text, max)) return { error: `text out of bounds (${lang})` };
    }
  }
  const value: Descriptor = { template, ttl_hours: ttl };
  if (body.title) value.title = body.title;
  if (body.body) value.body = body.body;
  if (body.decoration) value.decoration = body.decoration;
  if (body.stackable !== undefined) value.stackable = body.stackable;
  if (body.dismiss) value.dismiss = body.dismiss;
  if (body.route) value.route = body.route;
  if (body.icon) value.icon = body.icon;
  if (body.min_build !== undefined) value.min_build = body.min_build;
  return { value };
}

// Mirrors the client's AN-FR-PUSH-18 rules (defense in depth; the client is authoritative).
function isPlainText(text: string, maxChars: number): boolean {
  const normalized = text.normalize("NFC");
  const chars = [...normalized];
  if (chars.length === 0 || chars.length > maxChars) return false;
  if (normalized.trim().length === 0) return false;
  if (/[ -​-‏‪-‮⁠-⁯]/.test(normalized)) return false;
  if (!/^[\p{L}\p{N} .,!?'’"„“”—–\-:;()&%+…]+$/u.test(normalized)) return false;
  const lowered = normalized.toLowerCase();
  if (lowered.includes("http") || lowered.includes("www.")
      || lowered.includes("/") || lowered.includes("\\")) return false;
  if (/[a-z0-9-]+\.[a-z]{2,}/.test(lowered)) return false;
  return true;
}

type MaterializedEnvelope = ReturnType<typeof materialize>;

function materialize(descriptor: Descriptor, now: number) {
  return {
    v: 2,
    id: crypto.randomUUID(),
    template: descriptor.template,
    issued_at: now,
    expires_at: now + descriptor.ttl_hours * 3600,
    collapse: descriptor.template,
    ...(descriptor.title ? { title: descriptor.title } : {}),
    ...(descriptor.body ? { body: descriptor.body } : {}),
    ...(descriptor.decoration ? { decoration: descriptor.decoration } : {}),
    ...(descriptor.stackable !== undefined ? { stackable: descriptor.stackable } : {}),
    ...(descriptor.dismiss ? { dismiss: descriptor.dismiss } : {}),
    ...(descriptor.route ? { route: descriptor.route } : {}),
    ...(descriptor.icon ? { icon: descriptor.icon } : {}),
    ...(descriptor.min_build !== undefined ? { min_build: descriptor.min_build } : {}),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

async function descriptorHash(descriptor: Descriptor): Promise<string> {
  return sha256hex(canonical(descriptor));
}

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- shared plumbing --------------------------------------------------------

function topicFor(env: Env): string {
  return env.ENV_NAME === "prod" ? "broadcast-prod" : "broadcast-dev";
}

function utcDay(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

async function requireAdmin(env: Env, request: Request):
  Promise<{ ok: true; actor: string; response?: never } | { ok: false; response: Response }> {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!env.ADMIN_BROADCAST_TOKEN || token.length < 32) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }
  // Constant-time by construction: compare fixed-length digests, not secrets.
  const a = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const b = await crypto.subtle.digest("SHA-256",
                                       new TextEncoder().encode(env.ADMIN_BROADCAST_TOKEN));
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i += 1) diff |= av[i] ^ bv[i];
  if (diff !== 0) return { ok: false, response: json({ error: "unauthorized" }, 401) };
  const actor = [...av].slice(0, 6).map((x) => x.toString(16).padStart(2, "0")).join("");
  return { ok: true, actor };
}

async function readBoundedJSON<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (text.length > MAX_ADMIN_BODY) throw new Error("body too large");
  return JSON.parse(text) as T;
}

async function audit(env: Env, id: string, template: string, outcome: string,
                     detail: string, actor: string,
                     descriptorHash?: string | null,
                     envelopeHash?: string | null): Promise<void> {
  await env.OPS_DB
    .prepare("INSERT INTO broadcast_audit (id, template, outcome, detail, actor, descriptor_hash, envelope_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(id, template, outcome, detail.slice(0, 200), actor,
          descriptorHash ?? null, envelopeHash ?? null)
    .run();
}

/// Audit rows for a specific pinned descriptor since a UTC day boundary —
/// drives the canary-confirmation window (PM-SPEC-007/012) and the
/// one-campaign-per-descriptor-per-day idempotency guard (PM-SPEC-011).
async function countAuditForHash(env: Env, outcomes: string[], sinceDay: string,
                                 descriptorHash: string): Promise<number> {
  const placeholders = outcomes.map((_, i) => `?${i + 2}`).join(",");
  const row = await env.OPS_DB
    .prepare(`SELECT COUNT(*) AS n FROM broadcast_audit WHERE created_at >= ?1 AND outcome IN (${placeholders}) AND descriptor_hash = ?${outcomes.length + 2}`)
    .bind(`${sinceDay} 00:00:00`, ...outcomes, descriptorHash)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/// PM-SPEC-011: the daily cap counts DISTINCT PUBLISHED campaigns — by
/// envelope id, over outcomes sent/manifest_only — so a retried logical send
/// and its eventual success count once, and ambiguity never double-charges.
async function countPublishedCampaigns(env: Env, day: string): Promise<number> {
  const row = await env.OPS_DB
    .prepare("SELECT COUNT(DISTINCT id) AS n FROM broadcast_audit WHERE created_at >= ?1 AND outcome IN ('sent','manifest_only')")
    .bind(`${day} 00:00:00`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countAudit(env: Env, outcomes: string[], day: string,
                          template: string | null): Promise<number> {
  const placeholders = outcomes.map((_, i) => `?${i + 2}`).join(",");
  const sql = template
    ? `SELECT COUNT(*) AS n FROM broadcast_audit WHERE created_at >= ?1 AND outcome IN (${placeholders}) AND template = ?${outcomes.length + 2}`
    : `SELECT COUNT(*) AS n FROM broadcast_audit WHERE created_at >= ?1 AND outcome IN (${placeholders})`;
  const bindings: (string | number)[] = [`${day} 00:00:00`, ...outcomes];
  if (template) bindings.push(template);
  const row = await env.OPS_DB.prepare(sql).bind(...bindings).first<{ n: number }>();
  return row?.n ?? 0;
}

// ---- FCM HTTP v1 ------------------------------------------------------------

interface ServiceAccount { client_email: string; private_key: string; project_id: string }
type FcmTarget = { topic: string } | { token: string };

function fcmBody(target: FcmTarget, envelope: { expires_at: number }) {
  return {
    message: {
      ...target,
      data: { gv: JSON.stringify(envelope) },
      apns: {
        headers: {
          "apns-push-type": "background",
          "apns-priority": "5",
          "apns-expiration": String(envelope.expires_at),
        },
        payload: { aps: { "content-available": 1 } },
      },
    },
  };
}

async function fcmSend(env: Env, target: FcmTarget,
                       envelope: { expires_at: number }): Promise<void> {
  if (!env.FCM_SERVICE_ACCOUNT) throw new Error("FCM_SERVICE_ACCOUNT secret missing");
  const account = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  const accessToken = await oauthToken(account);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(fcmBody(target, envelope)),
    },
  );
  if (!response.ok) throw new Error(`fcm ${response.status}: ${(await response.text()).slice(0, 300)}`);
}

async function oauthToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const input = `${header}.${claims}`;
  const pem = account.private_key.replace(/-----[^-]+-----|\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)),
  );
  const jwt = `${input}.${b64urlBytes(signature)}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!response.ok) throw new Error(`oauth ${response.status}`);
  const body = await response.json<{ access_token?: string }>();
  if (!body.access_token) throw new Error("oauth: no access_token");
  return body.access_token;
}

function b64url(text: string): string {
  return b64urlBytes(new TextEncoder().encode(text));
}

function b64urlBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
