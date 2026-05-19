// swarm-worker daemon entrypoint. PLAN Phase 1.
//   1. Load config + identity + delegation
//   2. Connect with SASL (worker policy: random-suffix on nick collision)
//   3. Run announce sequence (PRESENCE=online), advertise capabilities, then PRESENCE=idle
//
// Phase 3 onwards adds claim/execute/evidence loops.
import {
  type WorkerConfig,
  buildCoordinationEvent,
  loadWorkerConfig,
  paths,
  ensurePathsDir,
  connect,
  wireDidCacheToClient,
  subscribeCoordinationEvents,
} from '@freeq-swarm/shared';
import { buildCapabilityAdvertisement } from './capabilities.js';
import { createWorkerClaimer, type WorkerPresenceState } from './claim.js';
import { fetchPinnedDiff } from './diff.js';
import { estimateReviewCostUsd, runPrReview } from './executors/pr_review.js';
import { runIssueFix } from './executors/issue_fix.js';
import { emitSpend } from './spend.js';
import { attachGovernanceHandler, type GovernanceState } from './governance.js';
import { EVENT_TYPES } from '@freeq-swarm/shared';

export interface WorkerOptions {
  configPath?: string;
}

const CAP_AD_INTERVAL_MS = 15 * 60 * 1000; // PLAN §5.1: re-publish every 15 min

export async function main(opts: WorkerOptions = {}): Promise<void> {
  const p = paths('worker');
  const configPath = opts.configPath ?? p.config;

  // ── 1. Load config ──
  const config: WorkerConfig = await loadWorkerConfig(configPath);
  console.log(
    `worker config: nick=${config.worker.nick_hint} channels=${config.worker.swarm_channels.join(',')} owner=${config.worker.owner_did}`,
  );

  await ensurePathsDir(p);

  // ── 2. Connect (bot-kit owns identity load/mint, SASL, announce, JOIN) ──
  const conn = await connect({
    name: 'swarm-worker',
    ownerDid: config.worker.owner_did,
    nick: config.worker.nick_hint,
    server: config.worker.freeq_server,
    url: config.worker.freeq_ws_url,
    channels: config.worker.swarm_channels,
    onNickCollision: 'random-suffix',
    readyTimeoutMs: 30_000,
  });
  const identity = conn.identity;
  console.log(`worker did: ${identity.did}${identity.isFresh ? ' (fresh)' : ''}`);
  console.log(
    `delegation: bot=${conn.delegation.bot_did} creator=${conn.delegation.creator_did} signature=${conn.delegation.signature ?? 'null (declarative)'}`,
  );
  console.log(`connected as ${conn.nick} (did=${conn.did})`);

  // ── 3. DID cache ──
  wireDidCacheToClient(conn.client);

  // ── 6. Worker presence + in-flight tracking (Phase 3 needs both for eligibility) ──
  let presence: WorkerPresenceState = 'online';
  // In-flight assignments tracked by task_id to avoid double-counting echoes.
  const inFlightTasks = new Set<string>();
  const setPresence = (state: WorkerPresenceState, status?: string, taskId?: string): void => {
    presence = state;
    const tail = [`state=${state}`];
    if (status) tail.push(`status=${status}`);
    if (taskId) tail.push(`task=${taskId}`);
    try {
      conn.client.raw(`PRESENCE :${tail.join(';')}`);
    } catch {
      /* socket gone */
    }
  };
  const cap = buildCapabilityAdvertisement({
    workerDid: identity.did,
    ownerDid: config.worker.owner_did,
    config,
  });

  // ── 7. After JOIN, advertise capabilities, then PRESENCE=idle ──
  let advertised = false;
  const advertiseAndIdle = (): void => {
    if (advertised) return;
    advertised = true;
    for (const ch of config.worker.swarm_channels) {
      const evt = buildCoordinationEvent(ch, 'status_update', cap, {
        humanText: '💪 capabilities advertised',
      });
      conn.client.raw(evt.tagmsg);
      conn.client.raw(evt.privmsg);
    }
    setPresence('idle');
    console.log(`advertised capabilities, transitioned to idle`);
  };
  conn.client.on('channelJoined', (channel) => {
    if (config.worker.swarm_channels.includes(channel)) advertiseAndIdle();
  });

  // Re-publish cap ad every 15 min so late-arriving coordinators learn us.
  const capAdTimer = setInterval(() => {
    if (!advertised) return;
    for (const ch of config.worker.swarm_channels) {
      const evt = buildCoordinationEvent(ch, 'status_update', cap, {
        humanText: '💪 capabilities (refresh)',
      });
      try {
        conn.client.raw(evt.tagmsg);
        conn.client.raw(evt.privmsg);
      } catch {
        /* socket gone */
      }
    }
  }, CAP_AD_INTERVAL_MS);

  // ── 8. Governance handler (Phase 4b) ──
  let govState: GovernanceState = 'normal';
  const govHandle = attachGovernanceHandler({
    client: conn.client,
    nick: () => conn.nick,
    setPresence: (s, extra) => setPresence(s as WorkerPresenceState, extra),
    onStateChange: (s) => {
      govState = s;
      console.log(`governance: state=${s}`);
    },
    onRevoke: () => {
      console.log('governance: revoked, exiting');
      try {
        conn.client.disconnect();
      } catch {
        /* gone */
      }
      process.exit(0);
    },
  });

  // ── 9. Wire the claimer to inbound coordination events ──
  const claimer = createWorkerClaimer({
    client: conn.client,
    workerDid: identity.did,
    config,
    capability: cap,
    // While paused / blocked / revoked, advertise no eligible channels so the
    // claimer never claims (Phase 4b governance integration).
    channels: govState === 'normal' ? config.worker.swarm_channels : [],
    getPresence: () => presence,
    getInFlight: () => inFlightTasks.size,
    onClaim: (taskId) => {
      inFlightTasks.add(taskId);
    },
    onIneligible: (taskId, reason) => {
      console.log(`skip ${taskId.slice(0, 8)}: ${reason}`);
    },
  });
  const unsubEvents = subscribeCoordinationEvents(conn.client, (evt) => {
    // Don't accept new claims while not in normal governance state.
    if (govState === 'normal') claimer(evt);
    // Detect assignment events naming us → transition to executing; otherwise release the slot.
    if (evt.eventType === 'task_update') {
      const a = evt.payload as any;
      if (a?.kind === 'swarm.assignment/v1' && Array.isArray(a.assigned_to)) {
        const tid = a.task_id as string;
        // CHATHISTORY replay: if the coord's exec deadline has already passed,
        // the task is dead. Acting on it would strand presence in 'executing'
        // (no task_payload in cache → workflow never runs → releaseSlot never
        // called → all subsequent task_requests rejected as idle_only).
        const deadlineMs = typeof a.deadline_unix === 'number' ? a.deadline_unix * 1000 : 0;
        if (deadlineMs > 0 && Date.now() > deadlineMs) {
          console.log(`ignore stale assignment ${tid.slice(0, 8)} (deadline passed)`);
          return;
        }
        if (a.assigned_to.includes(identity.did)) {
          setPresence('executing', `working on ${tid.slice(0, 8)}`, tid);
          // Find the source task_request payload from cached state. For v1
          // we re-fetch from the channel event log; here we keep the task
          // payload in memory keyed by task id.
          const task = pendingTaskPayloads.get(tid);
          if (task) {
            void runWorkflow(tid, task);
          }
        } else {
          inFlightTasks.delete(tid);
        }
      }
    }
    // Capture task_request payloads so the assignment handler can replay them.
    if (evt.eventType === EVENT_TYPES.task_request) {
      pendingTaskPayloads.set(evt.eventId, evt.payload);
    }
  });

  // Map of task_id → captured task_request payload, used when our worker is assigned.
  const pendingTaskPayloads = new Map<string, unknown>();

  const releaseSlot = (tid: string): void => {
    inFlightTasks.delete(tid);
    pendingTaskPayloads.delete(tid);
    setPresence('idle');
  };

  const emitFailed = (tid: string, reason: string, detail: string): void => {
    for (const ch of config.worker.swarm_channels) {
      const ev = buildCoordinationEvent(
        ch,
        EVENT_TYPES.task_failed,
        { kind: 'swarm.failure/v1', task_id: tid, reason, detail },
        { eventId: `${tid}-fail`, humanText: `❌ ${reason}`, taskId: tid },
      );
      conn.client.raw(ev.tagmsg);
      conn.client.raw(ev.privmsg);
    }
    releaseSlot(tid);
  };

  async function runWorkflow(taskId: string, taskPayload: any): Promise<void> {
    if (taskPayload?.task_type === 'issue_fix') return runIssueFixWorkflow(taskId, taskPayload);
    return runReviewWorkflow(taskId, taskPayload);
  }

  async function runIssueFixWorkflow(taskId: string, taskPayload: any): Promise<void> {
    const target = taskPayload?.target ?? {};
    const spec = taskPayload?.spec ?? {};
    const repo = String(target.repo ?? '').replace(/^github\.com\//, '');
    const issue = Number(target.issue);
    const baseBranch = String(target.base_branch ?? 'main');
    const model = config.runtime.models[0]!;
    try {
      const submission = await runIssueFix({
        taskId,
        workerDid: identity.did,
        repo,
        issue,
        baseBranch,
        title: String(spec.title ?? ''),
        body: String(spec.body ?? ''),
        testCommand: spec.test_command ?? null,
        maxTurns: Number(spec.max_turns ?? 30),
        model: model.model,
        via: model.via,
        maxUsdPerTask: config.constraints.max_usd_per_task,
      });
      for (const ch of config.worker.swarm_channels) {
        const ev = buildCoordinationEvent(ch, EVENT_TYPES.evidence_attach, submission, {
          eventId: `${taskId}-evidence`,
          humanText:
            submission.verdict === 'submitted'
              ? `🚀 PR opened: ${submission.pr_url}`
              : `⚠ ${submission.verdict}: ${submission.summary}`,
          taskId,
          evidenceType: 'code_submission',
        });
        conn.client.raw(ev.tagmsg);
        conn.client.raw(ev.privmsg);
        if (submission.usd_cost > 0) {
          emitSpend({ client: conn.client, channel: ch, amount: submission.usd_cost, taskId });
        }
      }
    } catch (e) {
      emitFailed(taskId, 'all_workers_failed', String(e).slice(0, 240));
      return;
    }
    releaseSlot(taskId);
  }

  async function runReviewWorkflow(taskId: string, taskPayload: any): Promise<void> {
    const target = taskPayload?.target ?? {};
    const repo = String(target.repo ?? '').replace(/^github\.com\//, '');
    const pr = Number(target.pr);
    const headSha = String(target.head_sha ?? '');
    const reviewFocus: string[] = Array.isArray(taskPayload?.spec?.review_focus)
      ? taskPayload.spec.review_focus
      : ['correctness'];
    const model = config.runtime.models[0]!;
    // Fetch diff (gh api SHA-pinned).
    const channels = config.worker.swarm_channels;
    for (const ch of channels) {
      const ev = buildCoordinationEvent(
        ch,
        EVENT_TYPES.task_update,
        { kind: 'swarm.progress/v1', task_id: taskId, phase: 'fetching_diff', detail: `${repo}#${pr}` },
        { eventId: `${taskId}-progress-fetch`, humanText: '⚙ fetching diff', taskId },
      );
      conn.client.raw(ev.tagmsg);
      conn.client.raw(ev.privmsg);
    }
    const diffRes = await fetchPinnedDiff({ repo, pr, expectedHeadSha: headSha });
    if (!diffRes.ok) {
      emitFailed(taskId, diffRes.reason, diffRes.detail ?? '');
      return;
    }
    // Per-execution cost guard from actual diff bytes (Phase 4b).
    const diffBytes = Buffer.byteLength(diffRes.diff, 'utf8');
    const est = estimateReviewCostUsd(model.model, diffBytes);
    if (est > config.constraints.max_usd_per_task) {
      emitFailed(
        taskId,
        'budget_exceeded',
        `est_usd ${est.toFixed(3)} > max_usd_per_task ${config.constraints.max_usd_per_task}`,
      );
      return;
    }
    // Run review.
    for (const ch of channels) {
      const ev = buildCoordinationEvent(
        ch,
        EVENT_TYPES.task_update,
        {
          kind: 'swarm.progress/v1',
          task_id: taskId,
          phase: 'reviewing',
          detail: `${diffRes.files} files, +${diffRes.totalAdditions}/-${diffRes.totalDeletions}`,
        },
        { eventId: `${taskId}-progress-review`, humanText: '⚙ reviewing', taskId },
      );
      conn.client.raw(ev.tagmsg);
      conn.client.raw(ev.privmsg);
    }
    let review;
    try {
      review = await runPrReview({
        taskId,
        diff: diffRes.diff,
        reviewFocus,
        model: model.model,
        via: model.via,
      });
    } catch (e) {
      emitFailed(taskId, 'all_workers_failed', String(e).slice(0, 240));
      return;
    }
    // Emit evidence.
    for (const ch of channels) {
      const ev = buildCoordinationEvent(ch, EVENT_TYPES.evidence_attach, review, {
        eventId: `${taskId}-evidence`,
        humanText: `📎 review submitted (verdict=${review.verdict})`,
        taskId,
        evidenceType: 'code_review',
      });
      conn.client.raw(ev.tagmsg);
      conn.client.raw(ev.privmsg);
      emitSpend({ client: conn.client, channel: ch, amount: review.usd_cost, taskId });
    }
    releaseSlot(taskId);
  }

  // ── 7. Clean shutdown ──
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`shutdown: ${sig}`);
    clearInterval(capAdTimer);
    unsubEvents();
    govHandle.dispose();
    await conn.stop(`worker ${sig}`);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('worker: phase 1 announce complete, idle');
}
