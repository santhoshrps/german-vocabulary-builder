// Broadcast messages (analytics.md §4.4, owner-scoped 2026-07-23 to broadcasts).
//
// Two doors, strictly separated:
//   GET  /v1/messages          — the PUSH-15 catch-up manifest: session-authenticated,
//                                returns current unexpired envelopes. Same JSON the
//                                push carries; no per-user record is created or read.
//   POST /v1/admin/broadcast   — the ONE trusted sender (PUSH-10/13): admin-secret
//                                auth, MANDATORY dry-run before a real send, explicit
//                                confirm word, immutable audit row for every attempt,
//                                a per-day cap counted in D1, then the FCM HTTP v1
//                                topic send. The console composer is never used.
//
// The sender holds NO copy: the envelope is template id + timing only — the client
// owns every word and route, so a leaked admin credential can ping within caps but
// can never inject content (the accepted blast radius, recorded in the spec).

import type { Env } from "./env";
import { json } from "./http";

// The template allowlist MUST mirror the client's (ServerMessageTemplate) — a
// template the app cannot fully surface is not sendable either.
const TEMPLATES = new Set(["new_content"]);
const MAX_TTL_HOURS = 7 * 24;
const SENDS_PER_DAY_CAP = 2; // mirrors the client's inbox cap

export async function handleMessagesManifest(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.OPS_DB
    .prepare("SELECT envelope FROM broadcasts WHERE expires_at > ?1 ORDER BY expires_at DESC LIMIT 10")
    .bind(now)
    .all<{ envelope: string }>();
  const envelopes = (rows.results ?? []).map((r) => JSON.parse(r.envelope));
  // Generic for everyone; cacheable briefly at the edge — there is nothing
  // personal to vary on.
  return json({ messages: envelopes }, 200, { "cache-control": "public, max-age=300" });
}

interface BroadcastRequest {
  template?: string;
  ttl_hours?: number;
  dry_run?: boolean;
  confirm?: string;
  note?: string;
}

export async function handleAdminBroadcast(env: Env, request: Request): Promise<Response> {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!env.ADMIN_BROADCAST_TOKEN || token.length < 32 || token !== env.ADMIN_BROADCAST_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  // Audit actor: a fingerprint prefix of the credential, never the credential.
  const actorHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actor = [...new Uint8Array(actorHash)].slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  let body: BroadcastRequest;
  try {
    body = await request.json<BroadcastRequest>();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const template = body.template ?? "";
  const ttlHours = body.ttl_hours ?? 24;
  if (!TEMPLATES.has(template)) return json({ error: "unknown template" }, 400);
  if (!(ttlHours >= 1 && ttlHours <= MAX_TTL_HOURS)) return json({ error: "bad ttl" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const envelope = {
    v: 1,
    id,
    template,
    issued_at: now,
    expires_at: now + ttlHours * 3600,
    collapse: template, // one live message per template — newer supersedes on-device
  };

  const audit = (outcome: string, detail: string) =>
    env.OPS_DB
      .prepare("INSERT INTO broadcast_audit (id, template, outcome, detail, actor) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, template, outcome, detail.slice(0, 200), actor)
      .run();

  // MANDATORY dry-run gate (PUSH-10): a real send requires BOTH a prior dry-run
  // this calendar day (proven in the audit) AND the explicit confirm word.
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  if (body.dry_run !== false || body.confirm !== "SEND") {
    await audit("dry_run", body.note ?? "");
    return json({ outcome: "dry_run", envelope, would_topic: topicFor(env) });
  }
  const dryRunToday = await env.OPS_DB
    .prepare("SELECT COUNT(*) AS n FROM broadcast_audit WHERE template = ?1 AND outcome = 'dry_run' AND created_at >= ?2")
    .bind(template, `${day} 00:00:00`)
    .first<{ n: number }>();
  if (!dryRunToday || dryRunToday.n === 0) {
    await audit("refused_confirm", "no dry-run today");
    return json({ error: "dry-run first: repeat with dry_run true, review, then send" }, 428);
  }
  const sentToday = await env.OPS_DB
    .prepare("SELECT COUNT(*) AS n FROM broadcast_audit WHERE outcome = 'sent' AND created_at >= ?1")
    .bind(`${day} 00:00:00`)
    .first<{ n: number }>();
  if ((sentToday?.n ?? 0) >= SENDS_PER_DAY_CAP) {
    await audit("refused_cap", `cap ${SENDS_PER_DAY_CAP}/day`);
    return json({ error: "daily campaign cap reached" }, 429);
  }

  // Persist for the manifest FIRST (PUSH-7: sync also carries it), then push.
  await env.OPS_DB
    .prepare("INSERT INTO broadcasts (id, envelope, expires_at) VALUES (?1, ?2, ?3)")
    .bind(id, JSON.stringify(envelope), envelope.expires_at)
    .run();

  try {
    await fcmTopicSend(env, envelope);
  } catch (error) {
    await audit("fcm_error", String(error));
    // The manifest row stands — sync still delivers; push was only the fast path.
    return json({ outcome: "manifest_only", error: String(error), envelope }, 502);
  }
  await audit("sent", body.note ?? "");
  return json({ outcome: "sent", envelope, topic: topicFor(env) });
}

function topicFor(env: Env): string {
  return env.ENV_NAME === "prod" ? "broadcast-prod" : "broadcast-dev";
}

// ---- FCM HTTP v1 (service-account OAuth, no SDK) ---------------------------

interface ServiceAccount { client_email: string; private_key: string; project_id: string }

async function fcmTopicSend(env: Env, envelope: unknown): Promise<void> {
  if (!env.FCM_SERVICE_ACCOUNT) throw new Error("FCM_SERVICE_ACCOUNT secret missing");
  const account = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  const accessToken = await oauthToken(account);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          topic: topicFor(env),
          data: { gv: JSON.stringify(envelope) },
          apns: {
            headers: {
              "apns-push-type": "background",
              "apns-priority": "5", // low priority (PUSH-11)
              "apns-expiration": String((envelope as { expires_at: number }).expires_at),
            },
            payload: { aps: { "content-available": 1 } },
          },
        },
      }),
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
