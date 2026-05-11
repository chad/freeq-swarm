// swarm-worker daemon entrypoint. PLAN Phase 1.
//   1. Load config + identity + delegation
//   2. Connect with SASL (worker policy: random-suffix on nick collision)
//   3. Run announce sequence (PRESENCE=online), advertise capabilities, then PRESENCE=idle
//
// Phase 3 onwards adds claim/execute/evidence loops.
import {
  type WorkerConfig,
  buildCoordinationEvent,
  loadOrCreateIdentity,
  loadOrMintDelegation,
  loadWorkerConfig,
  paths,
  ensurePathsDir,
  startAnnounce,
  connectClient,
  wireDidCacheToClient,
  subscribeCoordinationEvents,
} from '@freeq-swarm/shared';
import { buildCapabilityAdvertisement } from './capabilities.js';
import { createWorkerClaimer, type WorkerPresenceState } from './claim.js';

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

  // ── 2. Load identity + delegation ──
  const identity = await loadOrCreateIdentity(p.agentKey);
  console.log(`worker did: ${identity.did}${identity.isFresh ? ' (fresh)' : ''}`);
  const delegation = await loadOrMintDelegation({
    agent: identity,
    ownerDid: config.worker.owner_did,
    certPath: p.delegation,
  });
  console.log(
    `delegation: bot=${delegation.bot_did} creator=${delegation.creator_did} signature=${delegation.signature ?? 'null (declarative)'}`,
  );

  // ── 3. Connect with random-suffix-on-collision ──
  const conn = await connectClient({
    identity,
    nick: config.worker.nick_hint,
    server: config.worker.freeq_server,
    url: config.worker.freeq_ws_url,
    onNickCollision: 'random-suffix',
    maxNickRetries: 3,
    readyTimeoutMs: 30_000,
  });
  console.log(`connected as ${conn.nick} (did=${conn.did})`);

  // ── 4. DID cache ──
  wireDidCacheToClient(conn.client);

  // ── 5. Announce + JOIN ──
  const handle = startAnnounce({
    client: conn.client,
    delegation,
    channels: config.worker.swarm_channels,
    initialPresence: 'online',
  });

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

  // ── 8. Wire the claimer to inbound coordination events ──
  const claimer = createWorkerClaimer({
    client: conn.client,
    workerDid: identity.did,
    config,
    capability: cap,
    channels: config.worker.swarm_channels,
    getPresence: () => presence,
    getInFlight: () => inFlightTasks.size,
    onClaim: (taskId) => {
      // Reserve the slot synchronously to close the race between accept and
      // the assignment landing. PLAN F-15.
      inFlightTasks.add(taskId);
    },
  });
  const unsubEvents = subscribeCoordinationEvents(conn.client, (evt) => {
    // Filter our own echoes (we don't claim our own task_request — we're a worker, not a coordinator,
    // so this can only match if we're misconfigured. Defense in depth.).
    claimer(evt);
    // Detect assignment events naming us → transition to executing; otherwise release the slot.
    if (evt.eventType === 'task_update') {
      const a = evt.payload as any;
      if (a?.kind === 'swarm.assignment/v1' && Array.isArray(a.assigned_to)) {
        const tid = a.task_id as string;
        if (a.assigned_to.includes(identity.did)) {
          setPresence('executing', `working on ${tid.slice(0, 8)}`, tid);
          // Phase 4a will execute here. For Phase 3, we just hold the slot
          // and release on a synthetic "complete" trigger from upstream.
        } else {
          // Not assigned: release the speculative reservation.
          inFlightTasks.delete(tid);
        }
      }
    }
  });

  // ── 7. Clean shutdown ──
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`shutdown: ${sig}`);
    clearInterval(capAdTimer);
    unsubEvents();
    await handle.stop(`worker ${sig}`);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('worker: phase 1 announce complete, idle');
}
