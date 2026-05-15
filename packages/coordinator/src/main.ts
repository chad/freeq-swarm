// swarm-coordinator daemon entrypoint. PLAN §3.1 boot order:
//   1. Load SQLite
//   2. Recovery scan (no IRC yet)
//   3. Connect to freeq (SASL)
//   4. Subscribe to authError
//   5. Wire TAGMSG/PRIVMSG handlers
//   6. Start dispatch + summary timers (later phases)
//
// Phase 1 lands steps 1–5 plus the announce sequence and BUDGET issuance.
import {
  type CoordinatorConfig,
  loadCoordinatorConfig,
  loadOperatorAllowlist,
  paths,
  ensurePathsDir,
  connect,
  wireDidCacheToClient,
} from '@freeq-swarm/shared';
import { CoordinatorDb } from './db.js';
import { defaultRestBase, fetchBudget, issueBudget } from './budget.js';
import { handleInboundPrivmsg } from './dispatcher.js';
import { createDispatcher } from './dispatch.js';
import { startSummaryScheduler } from './summary.js';
import { handleDiscoveryRequest } from './discovery.js';
import { subscribeCoordinationEvents } from '@freeq-swarm/shared';

export interface CoordinatorOptions {
  /** Override config path. Defaults to `~/.freeq-swarm/coordinator/coordinator.yaml`. */
  configPath?: string;
}

export async function main(opts: CoordinatorOptions = {}): Promise<void> {
  // ── 0. Resolve paths ──
  const p = paths('coordinator');
  const configPath = opts.configPath ?? p.config;

  // ── 1. Load config ──
  const config: CoordinatorConfig = await loadCoordinatorConfig(configPath);
  console.log(
    `coordinator config: channel=${config.swarm.channel} nick=${config.swarm.coordinator_nick} founder=${config.swarm.founder_did}`,
  );

  await ensurePathsDir(p);

  // ── 2. Load operator allowlist (live-read from coordinator.yaml) ──
  const operatorAllowlist = await loadOperatorAllowlist({ configPath });
  console.log(
    `operator allowlist: ${operatorAllowlist.list().length} entr${operatorAllowlist.list().length === 1 ? 'y' : 'ies'} from coordinator.yaml`,
  );

  // ── 3. Open SQLite ──
  const db = new CoordinatorDb(p.db);
  process.on('exit', () => db.close());

  // ── 3. Recovery scan (placeholder for Phase 5; just log existing in-flight count) ──
  const inflight = db.inFlightTasks();
  if (inflight.length > 0) {
    console.log(`recovery: ${inflight.length} in-flight task(s) found`);
  }

  // ── 4. Connect (bot-kit owns identity load/mint, SASL, announce, JOIN) ──
  const conn = await connect({
    name: 'swarm-coordinator',
    ownerDid: config.swarm.founder_did,
    nick: config.swarm.coordinator_nick,
    server: config.swarm.freeq_server,
    url: config.swarm.freeq_ws_url,
    channels: [config.swarm.channel],
    onNickCollision: 'refuse',
    readyTimeoutMs: 30_000,
  });
  console.log(`coordinator did: ${conn.identity.did}${conn.identity.isFresh ? ' (fresh)' : ''}`);
  console.log(
    `delegation: bot=${conn.delegation.bot_did} creator=${conn.delegation.creator_did} signature=${conn.delegation.signature ?? 'null (declarative)'}`,
  );
  console.log(`connected as ${conn.nick} (did=${conn.did})`);

  // ── 5. Wire DID cache (ephemeral + persisted) ──
  const { cache: didCache } = wireDidCacheToClient(conn.client);
  // Persist every newly-learned binding to SQLite for durable DID→nick lookups.
  conn.client.on('memberDid', (nick, did) => {
    db.saveDidNick(did, nick, Date.now());
  });
  // Pre-warm cache from SQLite on startup.
  for (const { did, nick } of db.loadDidNickPairs()) {
    didCache.set(nick, did);
  }

  // ── 8. Issue BUDGET on startup if not already set ──
  // We always issue; BUDGET is idempotent (server overwrites). Coordinator does
  // NOT block on the REST roundtrip — fire and continue.
  setTimeout(() => {
    issueBudget({
      client: conn.client,
      channel: config.swarm.channel,
      maxAmount: config.budget.daily_usd_per_agent,
      sponsorDid: config.swarm.founder_did,
    });
    console.log(
      `BUDGET issued: max=${config.budget.daily_usd_per_agent} usd/day per-agent on ${config.swarm.channel}`,
    );
  }, 1500);

  // ── 9. After bootstrap, sanity-check budget via REST ──
  setTimeout(async () => {
    const restBase = defaultRestBase(config.swarm.freeq_server);
    const snap = await fetchBudget(restBase, config.swarm.channel);
    if (snap?.policy) {
      console.log(
        `budget snapshot: cap=${snap.policy.max_amount} ${snap.policy.unit}/${snap.policy.period}, ${snap.current_period.by_agent.length} agent(s) with spend`,
      );
    } else {
      console.warn('budget snapshot unavailable (REST returned null)');
    }
  }, 5000);

  // ── 10. Wire inbound PRIVMSG handler (Phase 2 ingestion + discovery) ──
  conn.client.on('message', (channel, m) => {
    const inb = { target: channel, from: m.from ?? '', text: m.text ?? '' };
    // Discovery: a candidate worker DMs us "whoareyou".
    handleDiscoveryRequest(
      {
        client: conn.client,
        config,
        coordinatorDid: conn.identity.did,
        didCache,
        operatorAllowlist,
      },
      inb,
    );
    // Channel ingestion: humans posting "@swarm review <pr>".
    void handleInboundPrivmsg(
      { client: conn.client, db, config, didCache, operatorAllowlist },
      inb,
    );
  });

  // ── 11. Wire claim collector + assignment dispatcher (Phase 3+5) ──
  const dispatcher = createDispatcher({
    client: conn.client,
    db,
    channel: config.swarm.channel,
    didCache,
    operatorAllowlist,
  });
  // Recovery: re-arm timers for any in-flight tasks left over from a previous
  // run BEFORE we wire inbound handlers, so the recovery decisions aren't
  // raced by fresh events.
  dispatcher.recover();
  const unsubEvents = subscribeCoordinationEvents(conn.client, (evt) => {
    dispatcher.handle(evt);
  });

  // ── 12. Summary scheduler (Phase 6) ──
  const summary = startSummaryScheduler({
    client: conn.client,
    db,
    config,
    didCache,
    operatorAllowlist,
  });

  // ── 13. Clean shutdown ──
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`shutdown: ${sig}`);
    dispatcher.shutdown();
    summary.shutdown();
    unsubEvents();
    await conn.stop(`coordinator ${sig}`);
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('coordinator: phase 1 announce complete, idle');
}
