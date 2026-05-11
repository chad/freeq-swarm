import { z } from 'zod';

// ── Common enums ────────────────────────────────────────────────────────────

export const Verdict = z.enum([
  'approve',
  'approve_with_comments',
  'request_changes',
  'reject',
]);
export type Verdict = z.infer<typeof Verdict>;

export const Severity = z.enum(['none', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;

export const TaskFailureReason = z.enum([
  'consensus_irreconcilable',
  'no_claims',
  'claim_timeout',
  'execution_timeout',
  'all_workers_failed',
  'budget_exceeded',
  'policy_violation',
  'ingestion_error',
  'head_sha_lost',
  'diff_too_large',
]);
export type TaskFailureReason = z.infer<typeof TaskFailureReason>;

export const PresenceState = z.enum([
  'online',
  'idle',
  'active',
  'executing',
  'waiting_for_input',
  'blocked_on_permission',
  'blocked_on_budget',
  'degraded',
  'paused',
  'sandboxed',
  'revoked',
  'offline',
]);
export type PresenceState = z.infer<typeof PresenceState>;

// ── §5.1 Capability advertisement ───────────────────────────────────────────

export const CapabilityModel = z.object({
  provider: z.string(),
  model: z.string(),
  via: z.enum(['api', 'cli', 'max-subscription']),
});

export const CapabilityAdvertisement = z.object({
  kind: z.literal('swarm.capabilities/v1'),
  worker_did: z.string(),
  operator_did: z.string(),
  advertised: z.object({
    task_types: z.array(z.string()).min(1),
    models: z.array(CapabilityModel).min(1),
    max_concurrent: z.number().int().positive(),
    languages: z.array(z.string()),
    max_diff_kloc: z.number().int().positive(),
  }),
  constraints: z.object({
    allowed_repo_patterns: z.array(z.string()),
    max_usd_per_task: z.number().nonnegative(),
    idle_only: z.boolean(),
  }),
});
export type CapabilityAdvertisement = z.infer<typeof CapabilityAdvertisement>;

// ── §5.4 task_request ───────────────────────────────────────────────────────

export const TaskRequest = z.object({
  kind: z.literal('swarm.task/v1'),
  task_type: z.literal('pr_review'),
  // null permitted for failure-detail intermediate state only; coordinator
  // refuses to actually post a task_request with null requester_did.
  requester_did: z.string().nullable(),
  target: z.object({
    repo: z.string(),
    pr: z.number().int().positive(),
    head_sha: z.string(),
  }),
  spec: z.object({
    diff_url: z.string(),
    review_focus: z.array(z.string()),
  }),
  policy: z.object({
    reviewers_needed: z.number().int().positive(),
    claim_window_ms: z.number().int().positive(),
    execution_timeout_ms: z.number().int().positive(),
    max_usd_per_reviewer: z.number().nonnegative(),
  }),
});
export type TaskRequest = z.infer<typeof TaskRequest>;

// ── §5.5 task_accept (claim) ────────────────────────────────────────────────

export const TaskClaim = z.object({
  kind: z.literal('swarm.claim/v1'),
  task_id: z.string(),
  worker_did: z.string(),
});
export type TaskClaim = z.infer<typeof TaskClaim>;

// ── §5.6 assignment (rides on task_update) ──────────────────────────────────

export const TaskAssignment = z.object({
  kind: z.literal('swarm.assignment/v1'),
  task_id: z.string(),
  phase: z.literal('assigned'),
  assigned_to: z.array(z.string()).min(1),
  deadline_unix: z.number().int().positive(),
});
export type TaskAssignment = z.infer<typeof TaskAssignment>;

// ── §5.7 task_update progress ───────────────────────────────────────────────

export const TaskProgress = z.object({
  kind: z.literal('swarm.progress/v1'),
  task_id: z.string(),
  phase: z.enum(['fetching_diff', 'reviewing', 'submitting']),
  detail: z.string(),
});
export type TaskProgress = z.infer<typeof TaskProgress>;

// ── §5.7 evidence_attach (review) ───────────────────────────────────────────

export const ReviewComment = z.object({
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  severity: Severity,
  msg: z.string(),
});
export type ReviewComment = z.infer<typeof ReviewComment>;

export const Review = z.object({
  kind: z.literal('swarm.review/v1'),
  evidence_type: z.literal('code_review'),
  task_id: z.string(),
  verdict: Verdict,
  severity: Severity,
  summary: z.string(),
  comments: z.array(ReviewComment),
  truncated: z.boolean(),
  tokens_used: z.number().int().nonnegative(),
  usd_cost: z.number().nonnegative(),
  model: z.string(),
  via: z.enum(['api', 'cli', 'max-subscription']),
});
export type Review = z.infer<typeof Review>;

// ── §5.9 task_complete ──────────────────────────────────────────────────────

export const TaskCompletion = z.object({
  kind: z.literal('swarm.completion/v1'),
  task_id: z.string(),
  consensus_verdict: Verdict,
  consensus_severity: Severity,
  agreement_score: z.number().min(0).max(1),
  reviewer_dids: z.array(z.string()),
  evidence_event_ids: z.array(z.string()),
  total_usd_cost: z.number().nonnegative(),
  wall_clock_ms: z.number().int().nonnegative(),
});
export type TaskCompletion = z.infer<typeof TaskCompletion>;

// ── §5.9 task_failed ────────────────────────────────────────────────────────

export const TaskFailure = z.object({
  kind: z.literal('swarm.failure/v1'),
  task_id: z.string(),
  reason: TaskFailureReason,
  detail: z.string().optional(),
});
export type TaskFailure = z.infer<typeof TaskFailure>;

// ── Wire event-type constants ───────────────────────────────────────────────
//
// These are the +freeq.at/event=<x> values we send. They are NOT enforced
// by the freeq server (any string is accepted), but using the documented
// vocabulary keeps the audit log + web client cards rendering correctly.

export const EVENT_TYPES = {
  task_request: 'task_request',
  task_accept: 'task_accept',
  task_update: 'task_update',
  evidence_attach: 'evidence_attach',
  task_complete: 'task_complete',
  task_failed: 'task_failed',
  status_update: 'status_update',
  delegation_notice: 'delegation_notice',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
