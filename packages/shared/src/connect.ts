// Higher-level connect: SASL ATPROTO-CHALLENGE, autoMsgSig=false, and
// hard-edge guards for nick collision (refuse-on-coordinator) and SASL failure.
//
// PLAN §6 (autoMsgSig=false, server-side fallback signing).
// PLAN §4.6 (nick collision policy).
// PLAN F-16 (subscribe to authError → exit).
import { FreeqClient } from '@freeq/sdk';
import type { AgentIdentity } from './identity.js';

export interface ConnectOptions {
  identity: AgentIdentity;
  nick: string;
  /** Defaults to `wss://<host>/irc` derived from `server` when unset. */
  url?: string;
  /** Format `host:port` (TLS port). Used to derive default URL. */
  server?: string;
  /**
   * Behavior on `433 ERR_NICKNAMEINUSE` for the requested nick:
   *  - `refuse` (coordinator default): disconnect + reject.
   *  - `random-suffix` (worker default): pick a fresh suffix and try again.
   *    On exhaustion of `maxRetries` (default 3), reject.
   */
  onNickCollision?: 'refuse' | 'random-suffix';
  maxNickRetries?: number;
  /** Maximum time to wait for `'ready'`. Default 30_000. */
  readyTimeoutMs?: number;
}

export interface Connected {
  client: FreeqClient;
  /** The DID we authenticated as. */
  did: string;
  /** The nick the server registered us with. */
  nick: string;
  disconnect(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function deriveUrl(opts: ConnectOptions): string {
  if (opts.url) return opts.url;
  const host = (opts.server ?? 'irc.freeq.at:6697').split(':')[0];
  return `wss://${host}/irc`;
}

function randomNickSuffix(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/**
 * Connect, perform SASL, wait for `'ready'`. Caller is responsible for
 * starting the announce sequence (PROVENANCE/...) — we don't bundle them
 * because tests want to assert each step independently.
 */
export async function connectClient(opts: ConnectOptions): Promise<Connected> {
  const url = deriveUrl(opts);
  const onCollision = opts.onNickCollision ?? 'refuse';
  const maxRetries = opts.maxNickRetries ?? 3;
  const timeoutMs = opts.readyTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  let attemptNick = opts.nick;
  let retriesLeft = maxRetries;

  // Outer loop on collision when policy = random-suffix.
  // We re-create the client on each retry because the SDK's 433 handler
  // auto-suffixes with `_` which we want to override.
  for (;;) {
    const client = new FreeqClient({
      url,
      nick: attemptNick,
      sasl: {
        did: opts.identity.did,
        method: 'crypto',
        signer: opts.identity.didKey.signer,
        token: '',
        pdsUrl: '',
      },
      autoMsgSig: false,
    });

    let collision = false;
    let collisionMessage = '';

    // 433 = ERR_NICKNAMEINUSE. params[1] is the rejected nick.
    const onRaw = (line: string, parsed: any): void => {
      if (parsed?.command !== '433') return;
      const rejected = parsed?.params?.[1];
      if (rejected !== attemptNick) return;
      collision = true;
      collisionMessage = `nick \`${attemptNick}\` is already taken on this server.`;
      // Best-effort: disconnect now to short-circuit the SDK's `_`-suffix retry.
      try {
        client.disconnect();
      } catch {
        /* ignore */
      }
    };
    client.on('raw', onRaw);

    try {
      const result = await waitForReady(client, attemptNick, opts.identity.did, timeoutMs);
      client.off('raw', onRaw);
      return result;
    } catch (err) {
      client.off('raw', onRaw);
      if (collision) {
        if (onCollision === 'refuse') {
          throw new Error(collisionMessage);
        }
        // random-suffix path
        retriesLeft -= 1;
        if (retriesLeft <= 0) {
          throw new Error(`exhausted ${maxRetries} retries for nick ${opts.nick} (collision)`);
        }
        attemptNick = `${opts.nick}-${randomNickSuffix()}`;
        continue;
      }
      throw err;
    }
  }
}

async function waitForReady(
  client: FreeqClient,
  expectedNick: string,
  expectedDid: string,
  timeoutMs: number,
): Promise<Connected> {
  return new Promise<Connected>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      cleanup();
      fn();
    };
    const onReady = (): void => {
      finish(() =>
        resolve({
          client,
          did: expectedDid,
          nick: client.nick || expectedNick,
          disconnect: () => client.disconnect(),
        }),
      );
    };
    const onError = (msg: string): void => {
      finish(() => reject(new Error(`server error: ${msg}`)));
    };
    const onAuthError = (msg: string): void => {
      finish(() => reject(new Error(`SASL auth failed: ${msg}`)));
    };
    const onState = (state: any): void => {
      if (state === 'disconnected') {
        finish(() => reject(new Error('disconnected before ready')));
      }
    };
    const cleanup = (): void => {
      client.off('ready', onReady);
      client.off('error', onError);
      client.off('authError', onAuthError);
      client.off('connectionStateChanged', onState);
      clearTimeout(timer);
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`timeout waiting for ready (${timeoutMs}ms)`))),
      timeoutMs,
    );
    client.on('ready', onReady);
    client.on('error', onError);
    client.on('authError', onAuthError);
    client.on('connectionStateChanged', onState);
    client.connect();
  });
}
