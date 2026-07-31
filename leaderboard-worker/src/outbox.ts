// D1 transactional-outbox → Cloudflare Queue bridge (LB3-NFR-1b).
//
// D1 is authoritative until terminal consumer completion. Queue acceptance only
// grants a bounded dispatch lease; the cron scanner recreates delivery after a
// failed send, lost lease write, Queue expiry or DLQ exhaustion. The consumer is
// at-least-once, explicitly acknowledges per message and never logs identifiers.

import { blobText } from "./blob";
import { runErasureStep } from "./deletion";
import type { Env } from "./index";
import {
  cleanupDedupId, erasureDedupId, makeOutboxMessage, OUTBOX_ACTIVE_CAP,
  OUTBOX_CLEANUP_ACTIVE_CAP, OUTBOX_COMPLETED_RETENTION_MS,
  OUTBOX_DISPATCH_BATCH, OUTBOX_ERASURE_ACTIVE_CAP, OutboxKind,
  parseOutboxMessage, retryDelaySeconds, SocialOutboxMessage,
} from "./outbox-contract";
export {
  cleanupDedupId, erasureDedupId, makeOutboxMessage,
  parseOutboxMessage, retryDelaySeconds,
} from "./outbox-contract";

const DISPATCH_LEASE_MS = 30 * 60_000;
const PROCESSING_LEASE_MS = 10 * 60_000;
const CLEANUP_PAGE = 200;
const JOURNAL_RECOVERY_BATCH = 25;
const COMPLETED_AGING_PAGE = 200;

type OutboxRow = {
  dedup_id: string;
  kind: OutboxKind;
  payload?: unknown;
  attempts?: number;
  dispatch_failures?: number;
  due_at?: number;
  created_at?: number;
  dispatch_lease_until?: number | null;
  processing_lease_until?: number | null;
  completed_at?: number | null;
  terminal_error_code?: string | null;
};

type QueueDecision =
  | { action: "ack"; outcome: string }
  | { action: "retry"; outcome: string; delaySeconds: number };

type EffectExecutor = (env: Env, row: OutboxRow) => Promise<boolean>;

function neutralLog(level: "info" | "warn" | "error", outcome: string, extra: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ component: "social-outbox", outcome, ...extra });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

async function insertErasureOutbox(
  env: Env, playerId: string, now: number,
): Promise<string> {
  const dedupId = await erasureDedupId(env.IDENTITY_HMAC_KEY_V1, playerId);
  await env.SOCIAL_DB.prepare(
    `INSERT OR IGNORE INTO outbox (dedup_id, kind, payload, due_at, created_at)
     SELECT ?1, 'erasure', ?2, ?3, ?3
     WHERE (SELECT count(*) FROM outbox WHERE completed_at IS NULL) < ?4
       AND (SELECT count(*) FROM outbox
            WHERE completed_at IS NULL AND kind = 'erasure') < ?5`)
    .bind(
      dedupId, new TextEncoder().encode(playerId), now,
      OUTBOX_ACTIVE_CAP, OUTBOX_ERASURE_ACTIVE_CAP,
    ).run();
  return dedupId;
}

/** S1 is stronger than S2: recreate any missing erasure dispatch intent. */
export async function recoverJournalOutboxes(env: Env, now = Date.now()): Promise<number> {
  const pending = await env.ERASURE_DB.prepare(
    `SELECT player_id FROM erasure_saga
     WHERE state NOT IN ('done', 'failed')
     ORDER BY coalesce(outbox_checked_at, 0), requested_at LIMIT ?1`)
    .bind(JOURNAL_RECOVERY_BATCH).all();
  let recovered = 0;
  for (const row of pending.results ?? []) {
    const playerId = String(row.player_id ?? "");
    if (!playerId) continue;
    const dedupId = await insertErasureOutbox(env, playerId, now);
    const exists = await env.SOCIAL_DB.prepare(
      "SELECT 1 AS present FROM outbox WHERE dedup_id = ?1").bind(dedupId).first();
    if (exists) {
      recovered += 1;
      await env.ERASURE_DB.prepare(
        "UPDATE erasure_saga SET outbox_checked_at = ?2 WHERE player_id = ?1")
        .bind(playerId, now).run();
    }
  }
  return recovered;
}

/** Coalesced, incarnation-safe standing cleanup; no direct cron executor exists. */
export async function ensureCleanupOutbox(env: Env, now = Date.now()): Promise<void> {
  const dedupId = cleanupDedupId(now);
  await env.SOCIAL_DB.prepare(
    `INSERT OR IGNORE INTO outbox (dedup_id, kind, payload, due_at, created_at)
     SELECT ?1, 'cleanup', NULL, ?2, ?2
     WHERE (SELECT count(*) FROM outbox WHERE completed_at IS NULL) < ?3
       AND (SELECT count(*) FROM outbox
            WHERE completed_at IS NULL AND kind = 'cleanup') < ?4`)
    .bind(dedupId, now, OUTBOX_ACTIVE_CAP, OUTBOX_CLEANUP_ACTIVE_CAP).run();
}

/** Best-effort low-latency send after a request has durably committed S1/S2. */
export async function dispatchOutboxByDedupId(
  env: Env, dedupId: string, now = Date.now(),
): Promise<void> {
  const row = await env.SOCIAL_DB.prepare(
    `SELECT dedup_id, kind, payload, attempts, dispatch_failures,
            due_at, created_at, dispatch_lease_until,
            processing_lease_until, completed_at
     FROM outbox WHERE dedup_id = ?1 AND completed_at IS NULL
       AND due_at <= ?2
       AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?2)
       AND (processing_lease_until IS NULL OR processing_lease_until <= ?2)`)
    .bind(dedupId, now).first<OutboxRow>();
  if (row) await dispatchRow(env, row, now);
}

/** Bounded recovery scan; dispatch only, never a hidden direct executor. */
export async function dispatchDueOutboxes(env: Env, now = Date.now()): Promise<number> {
  const due = await env.SOCIAL_DB.prepare(
    `SELECT dedup_id, kind, payload, attempts, dispatch_failures,
            due_at, created_at, dispatch_lease_until,
            processing_lease_until, completed_at
     FROM outbox
     WHERE completed_at IS NULL AND due_at <= ?1
       AND (dispatch_lease_until IS NULL OR dispatch_lease_until <= ?1)
       AND (processing_lease_until IS NULL OR processing_lease_until <= ?1)
     ORDER BY CASE kind WHEN 'erasure' THEN 0 ELSE 1 END,
              due_at, created_at LIMIT ?2`)
    .bind(now, OUTBOX_DISPATCH_BATCH).all<OutboxRow>();
  let accepted = 0;
  for (const row of due.results ?? []) {
    if (await dispatchRow(env, row, now)) accepted += 1;
  }
  return accepted;
}

async function dispatchRow(env: Env, row: OutboxRow, now: number): Promise<boolean> {
  const normalized = await normalizeLegacyRow(env, row, now);
  if (!normalized) return false;
  row = normalized;
  const dedupId = String(row.dedup_id);
  const kind = row.kind;
  const message = makeOutboxMessage(env.ENV_NAME, env.APP_SLUG, dedupId, kind);
  let accepted = false;
  try {
    await env.SOCIAL_OUTBOX.send(message, { contentType: "json" });
    accepted = true;
    await env.SOCIAL_DB.prepare(
      `UPDATE outbox
       SET dispatched_at = ?2, dispatch_lease_until = ?3,
           dispatch_failures = 0, last_error_code = NULL
       WHERE dedup_id = ?1 AND completed_at IS NULL`)
      .bind(dedupId, now, now + DISPATCH_LEASE_MS).run();
    return true;
  } catch {
    const failures = Number(row.dispatch_failures ?? 0) + 1;
    const delayMs = retryDelaySeconds(dedupId, failures) * 1_000;
    try {
      await env.SOCIAL_DB.prepare(
        `UPDATE outbox
         SET dispatch_failures = dispatch_failures + 1, due_at = ?2,
             last_attempt_at = ?3, last_error_code = ?4
         WHERE dedup_id = ?1 AND completed_at IS NULL`)
        .bind(
          dedupId, now + delayMs, now,
          accepted ? "dispatch_state_write" : "queue_send",
        ).run();
    } catch {
      // The unchanged due row is itself the recovery record. Never hide the
      // original failure behind a second database failure.
    }
    neutralLog("error", accepted ? "dispatch-state-write-failed" : "queue-send-failed", { kind });
    return false;
  }
}

/** One-time bridge for unfinished rows created by the superseded direct executor. */
async function normalizeLegacyRow(
  env: Env, row: OutboxRow, now: number,
): Promise<OutboxRow | null> {
  const currentMessage = makeOutboxMessage(
    env.ENV_NAME, env.APP_SLUG, String(row.dedup_id), row.kind,
  );
  if (parseOutboxMessage(currentMessage)) return row;

  let replacement: string | null = null;
  if (row.kind === "erasure") {
    const playerId = blobText(row.payload) ?? "";
    if (playerId) replacement = await erasureDedupId(env.IDENTITY_HMAC_KEY_V1, playerId);
  } else if (row.kind === "cleanup") {
    replacement = cleanupDedupId(Number(row.created_at ?? now));
  }
  if (!replacement) {
    await env.SOCIAL_DB.prepare(
      `UPDATE outbox SET completed_at = ?2, last_error_code = 'legacy_state_invalid'
       WHERE dedup_id = ?1 AND completed_at IS NULL`)
      .bind(row.dedup_id, now).run();
    neutralLog("error", "legacy-state-invalid", { kind: row.kind });
    return null;
  }

  await env.SOCIAL_DB.batch([
    env.SOCIAL_DB.prepare(
      `INSERT OR IGNORE INTO outbox
         (dedup_id, kind, payload, due_at, attempts, created_at, dispatched_at,
          dispatch_lease_until, processing_lease_until, dispatch_failures,
          last_attempt_at, last_error_code, completed_at)
       SELECT ?2, kind, payload, due_at, attempts, created_at, dispatched_at,
              dispatch_lease_until, processing_lease_until, dispatch_failures,
              last_attempt_at, last_error_code, completed_at
       FROM outbox WHERE dedup_id = ?1`)
      .bind(row.dedup_id, replacement),
    env.SOCIAL_DB.prepare("DELETE FROM outbox WHERE dedup_id = ?1").bind(row.dedup_id),
  ]);
  const migrated = await env.SOCIAL_DB.prepare(
    `SELECT dedup_id, kind, payload, attempts, dispatch_failures,
            due_at, created_at, dispatch_lease_until,
            processing_lease_until, completed_at
     FROM outbox WHERE dedup_id = ?1`).bind(replacement).first<OutboxRow>();
  return migrated ?? null;
}

async function claimOutboxRow(
  env: Env, dedupId: string, now: number,
): Promise<OutboxRow | null> {
  const row = await env.SOCIAL_DB.prepare(
    `SELECT dedup_id, kind, payload, attempts, dispatch_failures,
            due_at, created_at, dispatch_lease_until,
            processing_lease_until, completed_at
     FROM outbox WHERE dedup_id = ?1`).bind(dedupId).first<OutboxRow>();
  if (!row || row.completed_at != null) return row ?? null;
  const claim = await env.SOCIAL_DB.prepare(
    `UPDATE outbox SET processing_lease_until = ?2, last_attempt_at = ?3
     WHERE dedup_id = ?1 AND completed_at IS NULL
       AND (processing_lease_until IS NULL OR processing_lease_until <= ?3)`)
    .bind(dedupId, now + PROCESSING_LEASE_MS, now).run();
  return Number(claim.meta.changes ?? 0) === 1 ? row : null;
}

async function executeAuthoritativeEffect(env: Env, row: OutboxRow): Promise<boolean> {
  if (row.kind === "cleanup") return runBoundedCleanup(env);
  const playerId = blobText(row.payload) ?? "";
  if (!playerId) return false;
  const saga = await env.ERASURE_DB.prepare(
    "SELECT state FROM erasure_saga WHERE player_id = ?1").bind(playerId).first();
  if (!saga) {
    // No S1 journal means no authority to erase. Terminally quarantine this
    // outbox record instead of acting on mutable payload alone.
    row.terminal_error_code = "journal_missing";
    neutralLog("error", "journal-missing", { kind: "erasure" });
    return true;
  }
  if (String(saga.state) === "failed") {
    neutralLog("error", "journal-terminal-failed", { kind: "erasure" });
    return false;
  }
  return runErasureStep(env, playerId);
}

export async function processOutboxMessage(
  env: Env,
  body: unknown,
  deliveryAttempt: number,
  execute: EffectExecutor = executeAuthoritativeEffect,
  now = Date.now(),
): Promise<QueueDecision> {
  const message = parseOutboxMessage(body);
  const fallbackDelay = retryDelaySeconds("invalid", deliveryAttempt);
  if (!message) return { action: "retry", outcome: "message-invalid", delaySeconds: fallbackDelay };
  if (message.env !== env.ENV_NAME || message.app !== env.APP_SLUG) {
    return { action: "retry", outcome: "scope-mismatch", delaySeconds: fallbackDelay };
  }

  const before = await env.SOCIAL_DB.prepare(
    "SELECT kind, completed_at, processing_lease_until FROM outbox WHERE dedup_id = ?1")
    .bind(message.dedupId).first();
  if (!before || before.completed_at != null) {
    return { action: "ack", outcome: before ? "duplicate-complete" : "state-missing" };
  }
  if (String(before.kind) !== message.kind) {
    return { action: "retry", outcome: "kind-mismatch", delaySeconds: fallbackDelay };
  }

  const row = await claimOutboxRow(env, message.dedupId, now);
  if (!row) {
    const after = await env.SOCIAL_DB.prepare(
      "SELECT completed_at FROM outbox WHERE dedup_id = ?1").bind(message.dedupId).first();
    if (after?.completed_at != null) return { action: "ack", outcome: "duplicate-complete" };
    return { action: "retry", outcome: "processing-lease-held", delaySeconds: 30 };
  }
  if (row.completed_at != null) return { action: "ack", outcome: "duplicate-complete" };

  try {
    const done = await execute(env, row);
    if (done) {
      const completion = await env.SOCIAL_DB.prepare(
        `UPDATE outbox
         SET completed_at = ?2, processing_lease_until = NULL,
             dispatch_lease_until = NULL, last_error_code = ?3,
             payload = CASE WHEN kind = 'erasure' THEN NULL ELSE payload END
         WHERE dedup_id = ?1 AND completed_at IS NULL`)
        .bind(message.dedupId, now, row.terminal_error_code ?? null).run();
      if (Number(completion.meta.changes ?? 0) !== 1) {
        const state = await env.SOCIAL_DB.prepare(
          "SELECT completed_at FROM outbox WHERE dedup_id = ?1")
          .bind(message.dedupId).first();
        if (state?.completed_at == null) {
          return {
            action: "retry",
            outcome: "completion-write-lost",
            delaySeconds: retryDelaySeconds(message.dedupId, deliveryAttempt),
          };
        }
      }
      return { action: "ack", outcome: "completed" };
    }
    const attempts = Number(row.attempts ?? 0) + 1;
    const delaySeconds = retryDelaySeconds(message.dedupId, attempts);
    await recordEffectFailure(env, message.dedupId, now, delaySeconds, "effect_incomplete");
    return { action: "retry", outcome: "effect-incomplete", delaySeconds };
  } catch {
    const attempts = Number(row.attempts ?? 0) + 1;
    const delaySeconds = retryDelaySeconds(message.dedupId, attempts);
    try {
      await recordEffectFailure(env, message.dedupId, now, delaySeconds, "effect_error");
    } catch {
      // An expired processing lease lets either Queue redelivery or the scanner
      // recover. The unfinished D1 row is never acknowledged as success.
    }
    return { action: "retry", outcome: "effect-error", delaySeconds };
  }
}

async function recordEffectFailure(
  env: Env, dedupId: string, now: number, delaySeconds: number, code: string,
): Promise<void> {
  await env.SOCIAL_DB.prepare(
    `UPDATE outbox
     SET attempts = attempts + 1, due_at = ?2, processing_lease_until = NULL,
         dispatch_lease_until = ?3, last_attempt_at = ?4, last_error_code = ?5
     WHERE dedup_id = ?1 AND completed_at IS NULL`)
    .bind(
      dedupId, now + delaySeconds * 1_000,
      now + (delaySeconds + 60) * 1_000, now, code,
    ).run();
}

export async function consumeOutboxBatch(
  batch: MessageBatch<unknown>,
  env: Env,
  execute: EffectExecutor = executeAuthoritativeEffect,
): Promise<void> {
  if (batch.queue !== env.SOCIAL_OUTBOX_QUEUE) {
    for (const message of batch.messages) message.retry({ delaySeconds: 300 });
    neutralLog("error", "queue-scope-mismatch", { messages: batch.messages.length });
    return;
  }

  const outcomes: Record<string, number> = {};
  for (const message of batch.messages) {
    let decision: QueueDecision;
    try {
      decision = await processOutboxMessage(env, message.body, message.attempts, execute);
    } catch {
      decision = {
        action: "retry",
        outcome: "state-read-error",
        delaySeconds: retryDelaySeconds("state-read-error", message.attempts),
      };
    }
    outcomes[decision.outcome] = (outcomes[decision.outcome] ?? 0) + 1;
    if (decision.action === "ack") message.ack();
    else message.retry({ delaySeconds: decision.delaySeconds });
  }
  neutralLog("info", "batch-complete", { messages: batch.messages.length, outcomes });
}

/** One small page per table; catalogue-size or backlog cannot monopolize D1. */
async function runBoundedCleanup(env: Env): Promise<boolean> {
  const now = Date.now();
  await env.SOCIAL_DB.batch([
    env.SOCIAL_DB.prepare(
      `UPDATE invites SET state = 'expired' WHERE token_hash IN
       (SELECT token_hash FROM invites WHERE state = 'pending' AND expires_at < ?1
        ORDER BY expires_at LIMIT ?2)`).bind(now, CLEANUP_PAGE),
    env.SOCIAL_DB.prepare(
      `DELETE FROM nonces WHERE nonce IN
       (SELECT nonce FROM nonces WHERE expires_at < ?1 ORDER BY expires_at LIMIT ?2)`)
      .bind(now, CLEANUP_PAGE),
    env.SOCIAL_DB.prepare(
      `DELETE FROM idempotency WHERE (player_id, route, idem_key) IN
       (SELECT player_id, route, idem_key FROM idempotency
        WHERE expires_at < ?1 ORDER BY expires_at LIMIT ?2)`).bind(now, CLEANUP_PAGE),
    env.SOCIAL_DB.prepare(
      `DELETE FROM refresh_sessions WHERE family IN
       (SELECT family FROM refresh_sessions WHERE revoked = 1 AND rotated_at < ?1
        ORDER BY rotated_at LIMIT ?2)`).bind(now - 30 * 86_400_000, CLEANUP_PAGE),
  ]);
  await env.ERASURE_DB.batch([
    env.ERASURE_DB.prepare(
      `DELETE FROM erasure_saga WHERE player_id IN
       (SELECT player_id FROM erasure_saga WHERE expires_at < ?1 AND state = 'done'
        ORDER BY expires_at LIMIT ?2)`).bind(now, CLEANUP_PAGE),
    env.ERASURE_DB.prepare(
      `DELETE FROM erasure_markers WHERE player_id IN
       (SELECT player_id FROM erasure_markers
        WHERE expires_at < ?1 AND completed_at IS NOT NULL
        ORDER BY expires_at LIMIT ?2)`).bind(now, CLEANUP_PAGE),
  ]);
  return true;
}

async function ageCompletedOutboxes(env: Env, now: number): Promise<void> {
  await env.SOCIAL_DB.prepare(
    `DELETE FROM outbox WHERE dedup_id IN
     (SELECT dedup_id FROM outbox WHERE completed_at < ?1
      ORDER BY completed_at LIMIT ?2)`)
    .bind(now - OUTBOX_COMPLETED_RETENTION_MS, COMPLETED_AGING_PAGE).run();
}

async function emitOperationalSnapshot(env: Env, now: number): Promise<void> {
  const [outbox, journal, queue] = await Promise.all([
    env.SOCIAL_DB.prepare(
      `SELECT count(*) AS jobs, min(created_at) AS oldest,
              coalesce(sum(length(payload)), 0) AS payload_bytes
       FROM outbox WHERE completed_at IS NULL`).first(),
    env.ERASURE_DB.prepare(
      `SELECT count(*) AS jobs, min(updated_at) AS oldest
       FROM erasure_saga WHERE state NOT IN ('done', 'failed')`).first(),
    env.SOCIAL_OUTBOX.metrics().catch(() => null),
  ]);
  neutralLog("info", "operational-snapshot", {
    d1Jobs: Number(outbox?.jobs ?? 0),
    d1OldestSeconds: outbox?.oldest ? Math.max(0, Math.floor((now - Number(outbox.oldest)) / 1_000)) : 0,
    d1PayloadBytes: Number(outbox?.payload_bytes ?? 0),
    deletionJobs: Number(journal?.jobs ?? 0),
    deletionOldestSeconds: journal?.oldest ? Math.max(0, Math.floor((now - Number(journal.oldest)) / 1_000)) : 0,
    queueBacklog: queue?.backlogCount ?? null,
    queueBacklogBytes: queue?.backlogBytes ?? null,
    queueOldestSeconds: queue?.oldestMessageTimestamp
      ? Math.max(0, Math.floor((now - queue.oldestMessageTimestamp.getTime()) / 1_000)) : 0,
  });
}

export async function runOutboxMaintenance(env: Env, now = Date.now()): Promise<void> {
  await recoverJournalOutboxes(env, now);
  await ensureCleanupOutbox(env, now);
  await dispatchDueOutboxes(env, now);
  await ageCompletedOutboxes(env, now);
  await emitOperationalSnapshot(env, now);
}
