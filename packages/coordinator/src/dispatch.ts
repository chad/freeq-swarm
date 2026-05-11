// Phase 3 dispatch: collect task_accept claims for `claim_window_ms`, pick
// `reviewers_needed` (oldest claim wins; deterministic hash-tiebreak), post
// task_update :phase=assigned, increment assignments_in_flight.
//
// PLAN §5.5, §5.6, F-15.
import { createHash } from 'node:crypto';
import {
  type InboundCoordinationEvent,
  EVENT_TYPES,
  buildCoordinationEvent,
} from '@freeq-swarm/shared';
import type { FreeqClient } from '@freeq/sdk';
import type { CoordinatorDb } from './db.js';

export interface DispatchDeps {
  client: FreeqClient;
  db: CoordinatorDb;
  channel: string;
  /** Test hook: replace setTimeout/clearTimeout. */
  scheduler?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export interface DispatchHandle {
  /** Process an inbound coordination event (task_request triggers a claim window; task_accept is recorded). */
  handle(evt: InboundCoordinationEvent): void;
  /** For tests: force-assign any pending tasks immediately. */
  flushAll(): void;
  /** Cancel all pending claim-window timers. */
  shutdown(): void;
}

interface PendingTask {
  taskId: string;
  /** Initial expected reviewer count. */
  reviewersNeeded: number;
  /** Timer for claim_window expiry. */
  timer: ReturnType<typeof setTimeout>;
}

export function createDispatcher(deps: DispatchDeps): DispatchHandle {
  const sched = deps.scheduler ?? { setTimeout, clearTimeout };
  const pending = new Map<string, PendingTask>();

  function handle(evt: InboundCoordinationEvent): void {
    if (evt.channel.toLowerCase() !== deps.channel.toLowerCase()) return;
    if (evt.eventType === EVENT_TYPES.task_request) onTaskRequest(evt);
    else if (evt.eventType === EVENT_TYPES.task_accept) onTaskAccept(evt);
  }

  function onTaskRequest(evt: InboundCoordinationEvent): void {
    const t = deps.db.getTask(evt.eventId);
    if (!t) return; // we only dispatch tasks we created (own SQLite row exists)
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
    // Persist claim (PK ensures dedup across echoes).
    deps.db.recordClaim(taskId, workerDid, Math.floor(Date.now() / 1000));
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
      const ev = buildCoordinationEvent(
        deps.channel,
        EVENT_TYPES.task_failed,
        {
          kind: 'swarm.failure/v1',
          task_id: taskId,
          reason: 'no_claims',
          detail: 'no workers claimed within window',
        },
        { eventId: `${taskId}-fail`, humanText: '❌ no claims', taskId },
      );
      deps.client.raw(ev.tagmsg);
      deps.client.raw(ev.privmsg);
      deps.db.setTaskFailed({
        task_id: taskId,
        reason: 'no_claims',
        detail: 'no workers claimed within window',
        completed_at: Math.floor(Date.now() / 1000),
      });
      return;
    }
    // Pick top N (oldest claims first; deterministic hash-tiebreak).
    const sorted = [...claims].sort((a, b) => {
      if (a.claimed_at !== b.claimed_at) return a.claimed_at - b.claimed_at;
      return tieBreak(taskId, a.worker_did) < tieBreak(taskId, b.worker_did) ? -1 : 1;
    });
    const chosen = sorted.slice(0, p.reviewersNeeded);
    const now = Math.floor(Date.now() / 1000);
    const deadline = now + Math.floor((JSON.parse(t.payload_json).policy.execution_timeout_ms as number) / 1000);
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
  }

  function flushAll(): void {
    for (const p of [...pending.values()]) {
      sched.clearTimeout(p.timer);
      assignFromCollected(p.taskId);
    }
  }

  function shutdown(): void {
    for (const p of pending.values()) sched.clearTimeout(p.timer);
    pending.clear();
  }

  return { handle, flushAll, shutdown };
}

function tieBreak(taskId: string, workerDid: string): string {
  return createHash('sha256').update(`${taskId}\0${workerDid}`).digest('hex');
}
