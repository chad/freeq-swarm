// Bidirectional nick↔DID cache. PLAN §2.1 item 10, §5.0.
//
// freeq-server does NOT inject `account=` on TAGMSG broadcasts and the SDK
// does not request the `account-tag` IRCv3 cap. So we must resolve sender
// DIDs out-of-band: WHOIS reply (numeric 330) → SDK `'memberDid'` event.
//
// Coordinator additionally needs DID→nick lookup at AGENT PAUSE time
// (the command takes a nick, not a DID). PLAN §4.4, F-5.
import type { FreeqClient } from '@freeq/sdk';

export interface DidCache {
  /** Get DID for a known nick, or undefined if not cached. */
  didForNick(nick: string): string | undefined;
  /** Get current nick for a known DID, or undefined if not cached. */
  nickForDid(did: string): string | undefined;
  /** Synchronously record a binding. Called from `'memberDid'` and explicit registers. */
  set(nick: string, did: string): void;
  /** Forget a nick (e.g. on QUIT). */
  forgetNick(nick: string): void;
  /**
   * Resolve a nick to a DID, firing WHOIS if not cached. Resolves with the DID,
   * or null after `timeoutMs` if the WHOIS reply doesn't include a DID
   * (e.g. guest/unauthenticated user).
   */
  resolveNick(nick: string, timeoutMs?: number): Promise<string | null>;
  /** Total cached entries — for tests and metrics. */
  size(): number;
}

export interface DidCacheDeps {
  /** Send a raw IRC line (typically `WHOIS <nick>`). */
  whois: (nick: string) => void;
  /** Subscribe a one-shot listener for `'memberDid'`. */
  onMemberDid: (handler: (nick: string, did: string) => void) => () => void;
  /** Default WHOIS resolution timeout. */
  defaultTimeoutMs?: number;
}

/**
 * In-memory cache. The coordinator backs this up to SQLite on every set();
 * the worker uses it ephemerally.
 */
export function createDidCache(deps: DidCacheDeps): DidCache {
  const nickToDid = new Map<string, string>();
  const didToNick = new Map<string, string>();
  // Pending WHOIS resolves keyed by lowercase nick.
  const pending = new Map<string, Set<(d: string | null) => void>>();
  const defaultTimeout = deps.defaultTimeoutMs ?? 3000;

  // Always-on subscription; unsubscribe handle held for the lifetime of the cache.
  deps.onMemberDid((nick, did) => {
    set(nick, did);
  });

  function set(nick: string, did: string): void {
    const lc = nick.toLowerCase();
    // Update reverse map for previous binding too.
    const prevDid = nickToDid.get(lc);
    if (prevDid && prevDid !== did) didToNick.delete(prevDid);
    const prevNick = didToNick.get(did);
    if (prevNick && prevNick !== lc) nickToDid.delete(prevNick);
    nickToDid.set(lc, did);
    didToNick.set(did, lc);
    // Fire any pending resolves.
    const waiters = pending.get(lc);
    if (waiters) {
      pending.delete(lc);
      for (const w of waiters) w(did);
    }
  }

  function didForNick(nick: string): string | undefined {
    return nickToDid.get(nick.toLowerCase());
  }

  function nickForDid(did: string): string | undefined {
    return didToNick.get(did);
  }

  function forgetNick(nick: string): void {
    const lc = nick.toLowerCase();
    const did = nickToDid.get(lc);
    nickToDid.delete(lc);
    if (did) didToNick.delete(did);
  }

  async function resolveNick(nick: string, timeoutMs?: number): Promise<string | null> {
    const cached = didForNick(nick);
    if (cached) return cached;
    const lc = nick.toLowerCase();
    const t = timeoutMs ?? defaultTimeout;
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const settle = (d: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(d);
      };
      const waiters = pending.get(lc) ?? new Set();
      waiters.add(settle);
      pending.set(lc, waiters);
      const timer = setTimeout(() => {
        waiters.delete(settle);
        if (waiters.size === 0) pending.delete(lc);
        settle(null);
      }, t);
      // Fire WHOIS lazily; if multiple resolves happen for the same nick within
      // the timeout window, they all get the same response.
      if (waiters.size === 1) {
        try {
          deps.whois(nick);
        } catch {
          // Surface as null after timeout; do not throw upstream.
        }
      }
    });
  }

  function size(): number {
    return nickToDid.size;
  }

  return { didForNick, nickForDid, set, forgetNick, resolveNick, size };
}

/**
 * Wire a DidCache against a FreeqClient. Returns a disposer that clears
 * subscriptions (for tests).
 */
export function wireDidCacheToClient(client: FreeqClient): {
  cache: DidCache;
  dispose: () => void;
} {
  const handlers: Array<{ event: string; fn: any }> = [];

  const cache = createDidCache({
    whois: (nick) => client.raw(`WHOIS ${nick}`),
    onMemberDid: (handler) => {
      client.on('memberDid', handler);
      handlers.push({ event: 'memberDid', fn: handler });
      return () => client.off('memberDid', handler);
    },
  });

  // Forget on QUIT (DID may rebind to new nick later).
  const onQuit = (nick: string): void => cache.forgetNick(nick);
  client.on('userQuit', onQuit);
  handlers.push({ event: 'userQuit', fn: onQuit });

  // Track NICK changes (move binding to new nick).
  const onRename = (oldNick: string, newNick: string): void => {
    const did = cache.didForNick(oldNick);
    cache.forgetNick(oldNick);
    if (did) cache.set(newNick, did);
  };
  client.on('userRenamed', onRename);
  handlers.push({ event: 'userRenamed', fn: onRename });

  // Pre-warm via WHOIS on observed JOIN. Cheap and avoids first-contact lag.
  const onJoin = (_channel: string, member: { nick: string }): void => {
    if (!cache.didForNick(member.nick)) {
      try {
        client.raw(`WHOIS ${member.nick}`);
      } catch {
        /* socket gone */
      }
    }
  };
  client.on('memberJoined', onJoin);
  handlers.push({ event: 'memberJoined', fn: onJoin });

  return {
    cache,
    dispose() {
      for (const { event, fn } of handlers) {
        client.off(event as any, fn);
      }
    },
  };
}
