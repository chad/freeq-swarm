// FreeqBot adapter. Replaces the hand-rolled
// `loadOrCreateIdentity + loadOrMintDelegation + connectClient + startAnnounce`
// four-step with a single `connect()` that delegates to @freeq/bot-kit.
//
// bot-kit owns: did:key SASL, PROVENANCE, AGENT REGISTER, PRESENCE, HEARTBEAT,
// channel JOIN, reconnect re-announce. Swarm-specific concerns (nick collision
// policy, ws-url derivation from `host:port`, legacy key-file guard) stay here.
import {
  FreeqBot,
  type AgentIdentity,
  type DelegationCert,
  type FreeqClient,
  type MentionMatcher,
  type MentionResult,
  type NickCollisionPolicy,
} from '@freeq/bot-kit';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access } from 'node:fs/promises';

export type { AgentIdentity, DelegationCert, FreeqClient, MentionMatcher, MentionResult } from '@freeq/bot-kit';

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
  /** Custom addressing matcher (text, liveNick) => stripped | null. Swarm
   *  passes its start-anchored stripAddressing here; bot-kit's default
   *  matcher is anywhere-match, which is the wrong policy for the coord.
   *  When set, the per-channel mention cooldown is disabled (the
   *  coordinator must process every task request, never rate-limit). */
  mentionMatcher?: MentionMatcher;
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
  /** Resolve a sender's DID: account-tag → cache → WHOIS (with the
   *  userRenamed/userQuit cache invalidation bot-kit's resolver provides).
   *  Returns null if unresolvable within the WHOIS timeout. */
  resolveSenderDid(msg: { from: string; tags?: Record<string, string> }): Promise<string | null>;
  /** Classify a channel message as addressed-to-the-coordinator using the
   *  configured matcher + live server nick. cooldown disabled for swarm, so
   *  the result is only `ignore` or `respond`. */
  checkMention(channel: string, text: string): MentionResult;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function deriveUrl(opts: ConnectOptions): string {
  if (opts.url) return opts.url;
  const host = (opts.server ?? 'irc.freeq.at:6697').split(':')[0];
  return `wss://${host}/irc`;
}

/**
 * Pre-bot-kit swarm wrote the ed25519 seed as `key.ed25519`; bot-kit reads
 * `agent.key`. If the new name is absent but the legacy one is present,
 * refuse to start — proceeding would have FreeqBot.create mint a fresh key
 * and silently change the bot's DID. The fix is one manual `mv`.
 */
async function guardLegacyKeyFile(name: string): Promise<void> {
  const dir = join(homedir(), '.freeq', 'bots', name);
  const agentKey = join(dir, 'agent.key');
  const legacyKey = join(dir, 'key.ed25519');
  const exists = async (p: string): Promise<boolean> => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };
  if (await exists(agentKey)) return; // already on the new name
  if (!(await exists(legacyKey))) return; // fresh install — nothing to guard
  throw new Error(
    `legacy key file detected: ${legacyKey}\n` +
      `bot-kit reads the ed25519 seed at ${agentKey}.\n` +
      `Migrate manually:  mv ${legacyKey} ${agentKey}\n` +
      `Or delete ${legacyKey} to mint a fresh identity (the bot DID will change).`,
  );
}

export async function connect(opts: ConnectOptions): Promise<Connected> {
  await guardLegacyKeyFile(opts.name);

  const bot = await FreeqBot.create({
    name: opts.name,
    ownerDid: opts.ownerDid,
    nick: opts.nick,
    url: deriveUrl(opts),
    channels: opts.channels,
    onNickCollision: opts.onNickCollision,
    heartbeatMs: opts.heartbeatMs,
    initialState: opts.initialPresence ?? 'online',
    ...(opts.mentionMatcher
      ? { mention: { matcher: opts.mentionMatcher, cooldownMs: 0 } }
      : {}),
  });

  await bot.start({ timeoutMs: opts.readyTimeoutMs ?? DEFAULT_TIMEOUT_MS });

  return {
    client: bot.client,
    identity: bot.identity,
    delegation: bot.delegation,
    did: bot.identity.did,
    nick: bot.client.nick || opts.nick,
    stop: (reason?: string) => bot.stop(reason ?? 'swarm stop'),
    resolveSenderDid: (msg) => bot.resolveSenderDid(msg),
    checkMention: (channel, text) => bot.checkMention(channel, text),
  };
}
