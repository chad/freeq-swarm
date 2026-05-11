// Phase 2 ingestion pipeline: parse PRIVMSG → resolve requester DID +
// head_sha → validate (allowlist + repo patterns) → emit task_request OR
// task_failed.
//
// Wires together: ingest.ts, gh.ts, did_resolver, freeq event helpers.
import {
  type CoordinatorConfig,
  type DidCache,
  EVENT_TYPES,
  buildCoordinationEvent,
  matchesAnyRepoPattern,
  newUlid,
} from '@freeq-swarm/shared';
import type { FreeqClient } from '@freeq/sdk';
import type { CoordinatorDb } from './db.js';
import { fetchPrHeadInfo, fetchIssue, type GhOptions } from './gh.js';
import { type ParsedIssueFixSpec, type ParsedReviewSpec, parseTaskCommand, stripAddressing } from './ingest.js';

export interface IngestionDeps {
  client: FreeqClient;
  db: CoordinatorDb;
  config: CoordinatorConfig;
  didCache: DidCache;
  ghOpts?: GhOptions;
}

export interface InboundPrivmsg {
  /** Channel name (`#swarm`) or our own nick (DM). */
  target: string;
  /** Sender nick. */
  from: string;
  /** Message text (trailing parameter). */
  text: string;
}

/**
 * Handle a single inbound PRIVMSG. If addressed to the coordinator and parseable,
 * runs the full ingestion pipeline and emits either task_request or task_failed.
 */
export async function handleInboundPrivmsg(
  deps: IngestionDeps,
  msg: InboundPrivmsg,
): Promise<void> {
  const { client, db, config, didCache } = deps;
  const channel = config.swarm.channel;

  // Ignore messages from ourselves (echo from echo-message cap).
  if (msg.from && msg.from.toLowerCase() === config.swarm.coordinator_nick.toLowerCase()) return;

  // Only handle messages on our swarm channel (skip DMs for v1).
  if (msg.target !== channel) return;

  const body = stripAddressing(msg.text, config.swarm.coordinator_nick);
  if (body === null) return; // not addressed to us

  // Parse the command.
  const parsed = parseTaskCommand(body);
  if (!parsed.ok) {
    notice(client, msg.from, `swarm: ${parsed.detail}`);
    return;
  }

  // Resolve requester DID (need it for allowlist + audit). PLAN §5.4.
  const requesterDid = await didCache.resolveNick(msg.from, 3000);
  if (!requesterDid) {
    notice(client, msg.from, `swarm: could not resolve your DID via WHOIS — refusing task.`);
    return;
  }

  // Allowlist gate.
  if (!config.operator_allowlist.includes(requesterDid)) {
    notice(
      client,
      msg.from,
      `swarm: your DID (${requesterDid}) is not in the operator allowlist for this channel.`,
    );
    return;
  }

  // Repo-pattern gate (intersection: coordinator config + worker constraints
  // applied later at dispatch time; here we only enforce the channel allowlist).
  const taskTypeCfg = config.task_types[parsed.spec.task_type];
  if (!taskTypeCfg) {
    notice(client, msg.from, `swarm: task_type '${parsed.spec.task_type}' not configured`);
    return;
  }
  if (!matchesAnyRepoPattern(parsed.spec.repo, taskTypeCfg.allowed_repo_patterns)) {
    notice(
      client,
      msg.from,
      `swarm: repo '${parsed.spec.repo}' does not match any allowed pattern.`,
    );
    return;
  }

  if (parsed.spec.task_type === 'pr_review') {
    return ingestReview(deps, parsed.spec, taskTypeCfg, requesterDid, msg);
  }
  return ingestFix(deps, parsed.spec, taskTypeCfg, requesterDid, msg);
}

async function ingestReview(
  deps: IngestionDeps,
  spec: ParsedReviewSpec,
  taskTypeCfg: any,
  requesterDid: string,
  msg: InboundPrivmsg,
): Promise<void> {
  const head = await fetchPrHeadInfo(stripGitHubPrefix(spec.repo), spec.pr, deps.ghOpts);
  if (!head.ok) {
    const reasonDetail = `${head.failure.kind}: ${head.failure.message.slice(0, 240)}`;
    return emitTaskFailed(deps, {
      taskId: newUlid(),
      reason: 'ingestion_error',
      detail: reasonDetail,
      humanText: `❌ ingestion failed: ${head.failure.kind}`,
    });
  }
  const reviewersNeeded = spec.flags.reviewers ?? taskTypeCfg.reviewers_needed;
  const taskId = newUlid();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    kind: 'swarm.task/v1' as const,
    task_type: 'pr_review' as const,
    requester_did: requesterDid,
    target: { repo: spec.repo, pr: spec.pr, head_sha: head.info.head_sha },
    spec: { diff_url: head.info.diff_url, review_focus: ['correctness', 'test_coverage'] },
    policy: {
      reviewers_needed: reviewersNeeded,
      claim_window_ms: taskTypeCfg.claim_window_ms,
      execution_timeout_ms: taskTypeCfg.execution_timeout_ms,
      max_usd_per_reviewer: taskTypeCfg.max_usd_per_reviewer,
    },
  };
  deps.db.insertTask({
    task_id: taskId,
    state: 'pending_claims',
    task_type: 'pr_review',
    requester_did: requesterDid,
    payload_json: JSON.stringify(payload),
    created_at: now,
    retries_remaining: taskTypeCfg.max_retries_on_timeout,
  });
  const evt = buildCoordinationEvent(deps.config.swarm.channel, EVENT_TYPES.task_request, payload, {
    eventId: taskId,
    humanText: `📋 review ${spec.repo}#${spec.pr} (head ${head.info.head_sha.slice(0, 7)}) — claims open ${Math.round(taskTypeCfg.claim_window_ms / 1000)}s`,
  });
  deps.client.raw(evt.tagmsg);
  deps.client.raw(evt.privmsg);
}

async function ingestFix(
  deps: IngestionDeps,
  spec: ParsedIssueFixSpec,
  taskTypeCfg: any,
  requesterDid: string,
  msg: InboundPrivmsg,
): Promise<void> {
  const issue = await fetchIssue(stripGitHubPrefix(spec.repo), spec.issue, deps.ghOpts);
  if (!issue.ok) {
    return emitTaskFailed(deps, {
      taskId: newUlid(),
      reason: 'ingestion_error',
      detail: `${issue.failure.kind}: ${issue.failure.message.slice(0, 240)}`,
      humanText: `❌ ingestion failed: ${issue.failure.kind}`,
    });
  }
  // issue_fix is intentionally single-worker by default — first claim wins.
  // The founder can override via task_type config but the natural shape is 1.
  const reviewersNeeded = 1;
  const taskId = newUlid();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    kind: 'swarm.task/v1' as const,
    task_type: 'issue_fix' as const,
    requester_did: requesterDid,
    target: {
      repo: spec.repo,
      issue: spec.issue,
      base_branch: spec.flags.base_branch ?? 'main',
    },
    spec: {
      title: issue.info.title,
      body: issue.info.body,
      test_command: spec.flags.test_command ?? null,
      max_turns: spec.flags.max_turns ?? 30,
    },
    policy: {
      reviewers_needed: reviewersNeeded,
      claim_window_ms: taskTypeCfg.claim_window_ms,
      execution_timeout_ms: taskTypeCfg.execution_timeout_ms,
      max_usd_per_reviewer: taskTypeCfg.max_usd_per_reviewer,
    },
  };
  deps.db.insertTask({
    task_id: taskId,
    state: 'pending_claims',
    task_type: 'issue_fix',
    requester_did: requesterDid,
    payload_json: JSON.stringify(payload),
    created_at: now,
    retries_remaining: taskTypeCfg.max_retries_on_timeout,
  });
  const evt = buildCoordinationEvent(deps.config.swarm.channel, EVENT_TYPES.task_request, payload, {
    eventId: taskId,
    humanText: `🛠 fix ${spec.repo}#${spec.issue} "${issue.info.title.slice(0, 60)}" — claim opens for ${Math.round(taskTypeCfg.claim_window_ms / 1000)}s`,
  });
  deps.client.raw(evt.tagmsg);
  deps.client.raw(evt.privmsg);
}

function emitTaskFailed(
  deps: IngestionDeps,
  args: { taskId: string; reason: string; detail: string; humanText: string },
): void {
  const evt = buildCoordinationEvent(
    deps.config.swarm.channel,
    EVENT_TYPES.task_failed,
    {
      kind: 'swarm.failure/v1',
      task_id: args.taskId,
      reason: args.reason,
      detail: args.detail,
    },
    { eventId: args.taskId, humanText: args.humanText, taskId: args.taskId },
  );
  deps.client.raw(evt.tagmsg);
  deps.client.raw(evt.privmsg);
}

function notice(client: FreeqClient, target: string, text: string): void {
  // Sanitize CR/LF/NUL out of both target and text — without this, a payload
  // like "...\r\nKICK #ch victim" would let the attacker inject arbitrary
  // IRC commands through any error-path NOTICE we send.
  const safeTarget = target.replace(/[\r\n\0 ]/g, '');
  const safeText = text.replace(/[\r\n\0]/g, ' ');
  client.raw(`NOTICE ${safeTarget} :${safeText}`);
}

function stripGitHubPrefix(repo: string): string {
  return repo.startsWith('github.com/') ? repo.slice('github.com/'.length) : repo;
}
