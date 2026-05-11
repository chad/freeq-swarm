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
} from '@freeq-swarm/shared';
import { buildCapabilityAdvertisement } from './capabilities.js';

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

  // ── 6. After JOIN, advertise capabilities, then PRESENCE=idle ──
  // We listen for our own JOIN ack; first one triggers cap-ad sequence.
  let advertised = false;
  const advertiseAndIdle = (): void => {
    if (advertised) return;
    advertised = true;
    const capAd = buildCapabilityAdvertisement({
      workerDid: identity.did,
      ownerDid: config.worker.owner_did,
      config,
    });
    for (const ch of config.worker.swarm_channels) {
      const evt = buildCoordinationEvent(ch, 'status_update', capAd, {
        humanText: '💪 capabilities advertised',
      });
      conn.client.raw(evt.tagmsg);
      conn.client.raw(evt.privmsg);
    }
    conn.client.raw('PRESENCE :state=idle');
    console.log(`advertised capabilities, transitioned to idle`);
  };
  conn.client.on('channelJoined', (channel) => {
    if (config.worker.swarm_channels.includes(channel)) advertiseAndIdle();
  });

  // Re-publish cap ad every 15 min so late-arriving coordinators learn us.
  const capAdTimer = setInterval(() => {
    if (!advertised) return;
    const capAd = buildCapabilityAdvertisement({
      workerDid: identity.did,
      ownerDid: config.worker.owner_did,
      config,
    });
    for (const ch of config.worker.swarm_channels) {
      const evt = buildCoordinationEvent(ch, 'status_update', capAd, {
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

  // ── 7. Clean shutdown ──
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`shutdown: ${sig}`);
    clearInterval(capAdTimer);
    await handle.stop(`worker ${sig}`);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('worker: phase 1 announce complete, idle');
}
