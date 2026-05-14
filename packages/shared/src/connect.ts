// FreeqBot adapter. Replaces the hand-rolled
// `loadOrCreateIdentity + loadOrMintDelegation + connectClient + startAnnounce`
// four-step with a single `connect()` that delegates to @freeq/bot-kit.
//
// bot-kit owns: did:key SASL, PROVENANCE, AGENT REGISTER, PRESENCE, HEARTBEAT,
// channel JOIN, reconnect re-announce. Swarm-specific concerns (nick collision
// policy, ws-url derivation from `host:port`, key-filename compat shim) stay
// here.
import {
  FreeqBot,
  type AgentIdentity,
  type DelegationCert,
  type FreeqClient,
  type NickCollisionPolicy,
} from '@freeq/bot-kit';

export type { AgentIdentity, DelegationCert, FreeqClient } from '@freeq/bot-kit';

export interface ConnectOptions {
  /** Bot name under `~/.freeq/bots/`. Swarm uses `swarm-coordinator` / `swarm-worker`. */
  name: string;
  /** Founder/owner DID — used only if delegation.json must be minted. */
  ownerDid: string;
  /** Requested IRC nick. Server may rename us (ghost reclaim). */
  nick: string;
  /** Channels to JOIN after announce. */
  channels: string[];
  /** Full WebSocket URL. Takes precedence over `server`. */
  url?: string;
  /** `host:port` (TLS); derives `wss://<host>/irc`. */
  server?: string;
  /** Default: `refuse` (coordinator). Workers use `random-suffix`. */
  onNickCollision?: NickCollisionPolicy;
  readyTimeoutMs?: number;
  heartbeatMs?: number;
  /** Initial PRESENCE state. Default: `online` (matches the previous swarm
   *  announce-sequence default; bot-kit's own default is `active`). */
  initialPresence?: string;
}

export interface Connected {
  client: FreeqClient;
  identity: AgentIdentity;
  delegation: DelegationCert;
  /** Agent DID (alias for `identity.did`). */
  did: string;
  /** Nick the server registered us with (may differ from requested). */
  nick: string;
  /** Stop heartbeat, send PRESENCE=offline + QUIT, disconnect. Idempotent. */
  stop(reason?: string): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function deriveUrl(opts: ConnectOptions): string {
  if (opts.url) return opts.url;
  const host = (opts.server ?? 'irc.freeq.at:6697').split(':')[0];
  return `wss://${host}/irc`;
}

export async function connect(opts: ConnectOptions): Promise<Connected> {
  const bot = await FreeqBot.create({
    name: opts.name,
    ownerDid: opts.ownerDid,
    nick: opts.nick,
    url: deriveUrl(opts),
    channels: opts.channels,
    onNickCollision: opts.onNickCollision,
    heartbeatMs: opts.heartbeatMs,
    initialState: opts.initialPresence ?? 'online',
  });

  await bot.start({ timeoutMs: opts.readyTimeoutMs ?? DEFAULT_TIMEOUT_MS });

  return {
    client: bot.client,
    identity: bot.identity,
    delegation: bot.delegation,
    did: bot.identity.did,
    nick: bot.client.nick || opts.nick,
    stop: (reason?: string) => bot.stop(reason ?? 'swarm stop'),
  };
}
