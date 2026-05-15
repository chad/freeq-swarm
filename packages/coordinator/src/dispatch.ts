// Phase 3 dispatch: collect task_accept claims for `claim_window_ms`, pick
// `reviewers_needed` (oldest claim wins; deterministic hash-tiebreak), post
// task_update :phase=assigned, increment assignments_in_flight.
//
// PLAN §5.5, §5.6, F-15.
import { createHash } from 'node:crypto';
import {
  type DidCache,
  type InboundCoordinationEvent,
  type OperatorAllowlist,
  type Severity,
  type Verdict,
  EVENT_TYPES,
  buildCoordinationEvent,
  nickFromSource,
} from '@freeq-swarm/shared';
import type { FreeqClient } from '@freeq/sdk';
import type { CoordinatorDb } from './db.js';
import { type ReviewSummary, computeConsensus } from './verify.js';

/** Cap on stored evidence payload (defense against memory-amp attacks). */
const MAX_EVIDENCE_PAYLOAD_BYTES = 16 * 1024;

export interface DispatchDeps {
  client: FreeqClient;
  db: CoordinatorDb;
  channel: string;
  /** Test hook: replace setTimeout/clearTimeout. */
  scheduler?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /**
   * Required for sender-DID verification on task_accept / evidence_attach.
   * If absent, dispatcher rejects all such events to avoid impersonation.
   */
  didCache?: DidCache;
  /**
   * Operator-DID allowlist. Workers whose advertised operator_did (from the
   * capabilities table) is not in this map are silently dropped. If
   * undefined, the allowlist check is skipped (test mode).
   */
  operatorAllowlist?: OperatorAllowlist;
}

export interface DispatchHandle {
  /** Process an inbound coordination event (task_request triggers a claim window; task_accept is recorded). */
  handle(evt: InboundCoordinationEvent): void;
  /** For tests: force-assign any pending tasks immediately. */
  flushAll(): void;
  /** Cancel all pending claim-window timers. */
  shutdown(): void;
  /**
   * Boot-time recovery: rebuild in-memory timers for any in-flight task
   * found in SQLite. PLAN §3.1 recovery scan. Idempotent.
   */
  recover(now?: Date): void;
}

interface PendingTask {
  taskId: string;
  /** Initial expected reviewer count. */
  reviewersNeeded: number;
  /** Timer for claim_window expiry. */
  timer: ReturnType<typeof setTimeout>;
}

interface ExecutingTask {
  taskId: string;
  reviewersNeeded: number;
  startedAt: number;
  /** Timer for execution_timeout expiry. */
  timer: ReturnType<typeof setTimeout>;
}

export function createDispatcher(deps: DispatchDeps): DispatchHandle {
  const sched = deps.scheduler ?? { setTimeout, clearTimeout };
  const pending = new Map<string, PendingTask>();
  const executing = new Map<string, ExecutingTask>();

  function handle(evt: InboundCoordinationEvent): void {
    if (evt.channel.toLowerCase() !== deps.channel.toLowerCase()) return;
    if (evt.eventType === EVENT_TYPES.task_request) onTaskRequest(evt);
    else if (evt.eventType === EVENT_TYPES.task_accept) onTaskAccept(evt);
    else if (evt.eventType === EVENT_TYPES.evidence_attach) onEvidence(evt);
    else if (evt.eventType === EVENT_TYPES.task_failed) onWorkerFailure(evt);
    else if (evt.eventType === EVENT_TYPES.status_update) onStatusUpdate(evt);
  }

  /**
   * Capture capability advertisements published by workers. These power the
   * operator-DID allowlist gate at task_accept time.
   */
  function onStatusUpdate(evt: InboundCoordinationEvent): void {
    const payload = evt.payload as any;
    if (payload?.kind !== 'swarm.capabilities/v1') return;
    const workerDid = payload.worker_did;
    const operatorDid = payload.operator_did;
    if (typeof workerDid !== 'string' || typeof operatorDid !== 'string') return;
    // Verify the source DID matches the advertised worker_did so a malicious
    // user can't forge a cap ad for a victim DID.
    const senderDid = resolveSenderDid(evt);
    if (senderDid && senderDid !== workerDid) return;
    deps.db.upsertCapability({
      worker_did: workerDid,
      operator_did: operatorDid,
      payload_json: JSON.stringify(payload),
      updated_at: Math.floor(Date.now() / 1000),
    });
  }

  function onTaskRequest(evt: InboundCoordinationEvent): void {
    const t = deps.db.getTask(evt.eventId);
    if (!t) return; // we only dispatch tasks we created (own SQLite row exists)
    // Replay defense: never re-arm a claim window for a task already in a
    // terminal state, or one that's already mid-execution.
    if (t.state === 'complete' || t.state === 'failed') return;
    if (t.state === 'assigned' || t.state === 'verifying') return;
    const payload = JSON.parse(t.payload_json) as any;
    const reviewersNeeded = payload.policy.reviewers_needed as number;
    const claimWindowMs = payload.policy.claim_window_ms as number;
    // Idempotent: ignore second task_request for same id (echo-message).
    if (pending.has(evt.eventId)) return;
    const timer = sched.setTimeout(() => assignFromCollected(evt.eventId), claimWindowMs);
    pending.set(evt.eventId, { taskId: evt.eventId, reviewersNeeded, timer });
  }

  function onTaskAccept(evt: InboundCoordinationEvent): void {
    const taskId = evt.taskId ?? (evt.payload as any)?.task_id;
    if (!taskId) return;
    const claim = evt.payload as any;
    const workerDid = claim?.worker_did;
    if (!workerDid) return;
    // ── Security: verify the sender's DID matches the worker_did the payload claims. ──
    const senderDid = resolveSenderDid(evt);
    if (!senderDid || senderDid !== workerDid) return;
    // ── Security: enforce operator-DID allowlist (via stored capability ad). ──
    if (deps.operatorAllowlist) {
      const cap = deps.db.capabilityFor(workerDid);
      if (!cap || !deps.operatorAllowlist.has(cap.operator_did)) return;
    }
    // Persist claim (PK ensures dedup across echoes).
    deps.db.recordClaim(taskId, workerDid, Math.floor(Date.now() / 1000));
  }

  function resolveSenderDid(evt: InboundCoordinationEvent): string | undefined {
    if (!deps.didCache) return undefined;
    const nick = nickFromSource(evt.source);
    if (!nick) return undefined;
    return deps.didCache.didForNick(nick);
  }

  function assignFromCollected(taskId: string): void {
    const p = pending.get(taskId);
    if (!p) return;
    pending.delete(taskId);
    const claims = deps.db.claimsFor(taskId);
    const t = deps.db.getTask(taskId);
    if (!t) return;
    if (claims.length === 0) {
      // No claims arrived → task_failed :reason=no_claims.
      emitFailed(taskId, 'no_claims', 'no workers claimed within window');
      return;
    }
    // Pick top N (oldest claims first; deterministic hash-tiebreak).
    const sorted = [...claims].sort((a, b) => {
      if (a.claimed_at !== b.claimed_at) return a.claimed_at - b.claimed_at;
      return tieBreak(taskId, a.worker_did) < tieBreak(taskId, b.worker_did) ? -1 : 1;
    });
    const chosen = sorted.slice(0, p.reviewersNeeded);
    const now = Math.floor(Date.now() / 1000);
    const taskPayload = JSON.parse(t.payload_json) as any;
    const execTimeoutMs = taskPayload.policy.execution_timeout_ms as number;
    const deadline = now + Math.floor(execTimeoutMs / 1000);
    // Persist assignments synchronously (these power assignments_in_flight).
    for (const c of chosen) {
      deps.db.recordAssignment(taskId, c.worker_did, now);
    }
    deps.db.setTaskAssigned(taskId, now);
    // Emit assignment event.
    const assignmentPayload = {
      kind: 'swarm.assignment/v1' as const,
      task_id: taskId,
      phase: 'assigned' as const,
      assigned_to: chosen.map((c) => c.worker_did),
      deadline_unix: deadline,
    };
    const ev = buildCoordinationEvent(deps.channel, EVENT_TYPES.task_update, assignmentPayload, {
      eventId: `${taskId}-assign`,
      humanText: `→ assigned to ${chosen.length} reviewer(s)`,
      taskId,
    });
    deps.client.raw(ev.tagmsg);
    deps.client.raw(ev.privmsg);
    // Arm execution timeout.
    const timer = sched.setTimeout(() => onExecutionTimeout(taskId), execTimeoutMs);
    executing.set(taskId, {
      taskId,
      reviewersNeeded: p.reviewersNeeded,
      startedAt: now,
      timer,
    });
  }

  function onEvidence(evt: InboundCoordinationEvent): void {
    const taskId = evt.taskId ?? (evt.payload as any)?.task_id;
    if (!taskId) return;
    const t = deps.db.getTask(taskId);
    if (!t || t.state === 'complete' || t.state === 'failed') return;
    const payload = evt.payload as any;
    const claimedDid = payload?.worker_did;
    // ── Security: verify sender's DID matches payload's claimed worker_did. ──
    const senderDid = resolveSenderDid(evt);
    if (!senderDid) return;
    const workerDid = claimedDid ?? senderDid;
    if (claimedDid && claimedDid !== senderDid) return;
    // ── Security: must be an assigned reviewer. ──
    if (!deps.db.assignmentsFor(taskId).includes(workerDid)) return;
    // ── Security: payload size cap. ──
    const payloadJson = JSON.stringify(payload);
    if (payloadJson.length > MAX_EVIDENCE_PAYLOAD_BYTES) return;
    deps.db.insertEvidence({
      event_id: evt.eventId,
      task_id: taskId,
      worker_did: workerDid,
      payload_json: payloadJson,
      received_at: Math.floor(Date.now() / 1000),
    });
    maybeFinalize(taskId);
  }

  function onWorkerFailure(evt: InboundCoordinationEvent): void {
    // A worker may emit task_failed for itself (e.g. budget_exceeded). We
    // treat that as a missing review and let consensus / timeout finalize.
    const taskId = evt.taskId ?? (evt.payload as any)?.task_id;
    if (!taskId) return;
    const t = deps.db.getTask(taskId);
    if (!t || t.state === 'complete' || t.state === 'failed') return;
    // Don't insert into `evidence` — worker failure is not evidence. We rely
    // on the execution_timeout to fire if too few evidence pieces show up.
    maybeFinalize(taskId);
  }

  function maybeFinalize(taskId: string): void {
    const x = executing.get(taskId);
    if (!x) return;
    const evidence = deps.db.evidenceFor(taskId);
    // Only count *parseable* evidence (review or submission) toward the threshold —
    // malformed payloads sit in SQLite for audit but don't satisfy reviewers_needed.
    let valid = 0;
    for (const e of evidence) {
      try {
        const p = JSON.parse(e.payload_json);
        if (p?.kind === 'swarm.review/v1' && typeof p.verdict === 'string') valid += 1;
        else if (p?.kind === 'swarm.submission/v1' && typeof p.verdict === 'string') valid += 1;
      } catch {
        /* skip */
      }
    }
    if (valid < x.reviewersNeeded) return;
    sched.clearTimeout(x.timer);
    executing.delete(taskId);
    finalize(taskId);
  }

  function onExecutionTimeout(taskId: string): void {
    const x = executing.get(taskId);
    if (!x) return;
    executing.delete(taskId);
    const t = deps.db.getTask(taskId);
    if (!t) return;
    if (t.retries_remaining > 0) {
      // Retry policy (Phase 5): re-emit a fresh task_request payload. Keeps
      // the same task_id so audit trails line up.
      deps.db.decrementRetries(taskId);
      // Reset task to pending_claims; clear assignments + claims so a new
      // window picks fresh workers.
      deps.db.clearClaims(taskId);
      deps.db.clearAssignments(taskId);
      deps.db.setTaskState(taskId, 'pending_claims');
      const payload = JSON.parse(t.payload_json) as any;
      const ev = buildCoordinationEvent(
        deps.channel,
        EVENT_TYPES.task_request,
        payload,
        {
          eventId: taskId,
          humanText: `🔁 retry on execution_timeout (${t.retries_remaining}/${t.retries_remaining + 1} left)`,
        },
      );
      deps.client.raw(ev.tagmsg);
      deps.client.raw(ev.privmsg);
      // Re-open claim window.
      onTaskRequest({
        ...({} as InboundCoordinationEvent),
        channel: deps.channel,
        eventType: EVENT_TYPES.task_request,
        eventId: taskId,
        verb: 'TAGMSG',
        tags: {},
        payload,
      } as InboundCoordinationEvent);
      return;
    }
    // No retries left → finalize what we have, or fail.
    finalize(taskId, true);
  }

  function finalize(taskId: string, fromTimeout = false): void {
    const evidence = deps.db.evidenceFor(taskId);
    const t = deps.db.getTask(taskId);
    const isFix = t?.task_type === 'issue_fix';

    if (isFix) {
      // Software-factory mode: pick the first valid submission with verdict=submitted.
      // If none submitted but some came in (failed_to_change / failed_tests), report
      // task_failed with details. If none arrived at all on timeout, execution_timeout.
      const submissions: Array<{ worker_did: string; payload: any }> = [];
      for (const e of evidence) {
        try {
          const p = JSON.parse(e.payload_json);
          if (p?.kind === 'swarm.submission/v1' && typeof p.verdict === 'string') {
            submissions.push({ worker_did: e.worker_did, payload: p });
          }
        } catch { /* skip */ }
      }
      if (submissions.length === 0 && fromTimeout) {
        emitFailed(taskId, 'execution_timeout', 'no submission within deadline');
        return;
      }
      const winners = submissions.filter((s) => s.payload.verdict === 'submitted');
      if (winners.length === 0) {
        const reasons = submissions.map((s) => `${s.payload.verdict}`).join(', ') || 'no submissions';
        emitFailed(taskId, 'all_workers_failed', `workers tried but didn't ship: ${reasons}`);
        return;
      }
      const winner = winners[0]!;
      const completionPayload = {
        kind: 'swarm.completion/v1' as const,
        task_id: taskId,
        consensus_verdict: 'submitted',
        consensus_severity: 'none',
        agreement_score: 1.0,
        reviewer_dids: [winner.worker_did],
        evidence_event_ids: evidence.map((e) => e.event_id),
        pr_url: winner.payload.pr_url,
        total_usd_cost: submissions.reduce((a, s) => a + (s.payload.usd_cost ?? 0), 0),
        wall_clock_ms: 0,
      };
      const ev = buildCoordinationEvent(
        deps.channel,
        EVENT_TYPES.task_complete,
        completionPayload,
        {
          eventId: `${taskId}-complete`,
          humanText: `🚀 ${taskId.slice(0, 8)} → ${winner.payload.pr_url}`,
          taskId,
        },
      );
      deps.client.raw(ev.tagmsg);
      deps.client.raw(ev.privmsg);
      deps.db.setTaskComplete({
        task_id: taskId,
        consensus_verdict: 'submitted',
        consensus_severity: 'none',
        agreement_score: 1.0,
        completed_at: Math.floor(Date.now() / 1000),
      });
      deps.db.bumpReputation(winner.worker_did, 1);
      return;
    }

    // pr_review path (default)
    const reviews: ReviewSummary[] = [];
    for (const e of evidence) {
      try {
        const p = JSON.parse(e.payload_json);
        if (p?.kind === 'swarm.review/v1' && typeof p.verdict === 'string') {
          reviews.push({
            worker_did: e.worker_did,
            verdict: p.verdict as Verdict,
            severity: (p.severity as Severity) ?? 'none',
          });
        }
      } catch {
        /* skip malformed evidence */
      }
    }
    if (reviews.length === 0 && fromTimeout) {
      emitFailed(taskId, 'execution_timeout', 'no evidence within deadline');
      return;
    }
    const consensus = computeConsensus(reviews);
    if (!consensus.ok) {
      emitFailed(taskId, 'consensus_irreconcilable', consensus.detail);
      return;
    }
    // Emit task_complete.
    const completionPayload = {
      kind: 'swarm.completion/v1' as const,
      task_id: taskId,
      consensus_verdict: consensus.verdict,
      consensus_severity: consensus.severity,
      agreement_score: consensus.agreement_score,
      reviewer_dids: reviews.map((r) => r.worker_did),
      evidence_event_ids: evidence.map((e) => e.event_id),
      total_usd_cost: evidence.reduce((acc, e) => {
        try {
          return acc + (JSON.parse(e.payload_json).usd_cost as number ?? 0);
        } catch {
          return acc;
        }
      }, 0),
      wall_clock_ms: 0,
    };
    const ev = buildCoordinationEvent(
      deps.channel,
      EVENT_TYPES.task_complete,
      completionPayload,
      {
        eventId: `${taskId}-complete`,
        humanText: `✅ ${taskId.slice(0, 8)} — ${consensus.verdict} (${reviews.length}/${reviews.length})`,
        taskId,
      },
    );
    deps.client.raw(ev.tagmsg);
    deps.client.raw(ev.privmsg);
    deps.db.setTaskComplete({
      task_id: taskId,
      consensus_verdict: consensus.verdict,
      consensus_severity: consensus.severity,
      agreement_score: consensus.agreement_score,
      completed_at: Math.floor(Date.now() / 1000),
    });
    // Reputation update (kept for v2 dispatch consultation).
    for (const did of consensus.pickedDids) deps.db.bumpReputation(did, 1);
  }

  function emitFailed(taskId: string, reason: string, detail: string): void {
    const ev = buildCoordinationEvent(
      deps.channel,
      EVENT_TYPES.task_failed,
      { kind: 'swarm.failure/v1', task_id: taskId, reason, detail },
      { eventId: `${taskId}-fail`, humanText: `❌ ${reason}`, taskId },
    );
    deps.client.raw(ev.tagmsg);
    deps.client.raw(ev.privmsg);
    deps.db.setTaskFailed({
      task_id: taskId,
      reason,
      detail,
      completed_at: Math.floor(Date.now() / 1000),
    });
  }

  function flushAll(): void {
    for (const p of [...pending.values()]) {
      sched.clearTimeout(p.timer);
      assignFromCollected(p.taskId);
    }
    for (const e of [...executing.values()]) {
      sched.clearTimeout(e.timer);
      onExecutionTimeout(e.taskId);
    }
  }

  function shutdown(): void {
    for (const p of pending.values()) sched.clearTimeout(p.timer);
    for (const e of executing.values()) sched.clearTimeout(e.timer);
    pending.clear();
    executing.clear();
  }

  /** Boot-time recovery: walks `tasks` rows that are not in a terminal state
   *  and rebuilds the appropriate timer / runs synchronous finalize.
   *
   *  PLAN §3.1 recovery state machine:
   *    pending_claims:
   *      now - created_at < claim_window_ms  → re-arm timer for remaining
   *      else if claims arrived              → assign now
   *      else                                → fail no_claims
   *    assigned / verifying:
   *      now - assigned_at < execution_timeout_ms → re-arm exec timer
   *      else                                       → finalize what's in
   */
  function recover(now: Date = new Date()): void {
    const nowSec = Math.floor(now.getTime() / 1000);
    for (const t of deps.db.inFlightTasks()) {
      const payload = JSON.parse(t.payload_json) as any;
      const claimWindowMs = payload.policy.claim_window_ms as number;
      const execTimeoutMs = payload.policy.execution_timeout_ms as number;
      const reviewersNeeded = payload.policy.reviewers_needed as number;

      if (t.state === 'pending_claims') {
        const elapsedMs = (nowSec - t.created_at) * 1000;
        if (elapsedMs < claimWindowMs) {
          if (pending.has(t.task_id)) continue;
          const remainingMs = Math.max(claimWindowMs - elapsedMs, 0);
          const timer = sched.setTimeout(() => assignFromCollected(t.task_id), remainingMs);
          pending.set(t.task_id, { taskId: t.task_id, reviewersNeeded, timer });
        } else {
          // Window already expired; let assignFromCollected dispatch or fail.
          if (pending.has(t.task_id)) continue;
          // Use a degenerate timer that fires synchronously so existing
          // semantics hold (assignFromCollected pulls from `pending`).
          const timer = sched.setTimeout(() => assignFromCollected(t.task_id), 0);
          pending.set(t.task_id, { taskId: t.task_id, reviewersNeeded, timer });
        }
        continue;
      }

      if (t.state === 'assigned' || t.state === 'verifying') {
        if (executing.has(t.task_id)) continue;
        const startedAt = t.assigned_at ?? t.created_at;
        const deadlineSec = startedAt + Math.floor(execTimeoutMs / 1000);
        const remainingMs = Math.max((deadlineSec - nowSec) * 1000, 0);
        if (remainingMs > 0) {
          const timer = sched.setTimeout(() => onExecutionTimeout(t.task_id), remainingMs);
          executing.set(t.task_id, {
            taskId: t.task_id,
            reviewersNeeded,
            startedAt,
            timer,
          });
        } else {
          // Past deadline; finalize on whatever evidence is in (or
          // fall through to retry-on-timeout policy).
          onExecutionTimeout(t.task_id);
        }
      }
    }
  }

  return { handle, flushAll, shutdown, recover };
}

function tieBreak(taskId: string, workerDid: string): string {
  return createHash('sha256').update(`${taskId}\0${workerDid}`).digest('hex');
}
