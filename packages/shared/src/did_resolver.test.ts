import { describe, expect, it, vi } from 'vitest';
import { createDidCache } from './did_resolver.js';

function makeDeps() {
  const whoisCalls: string[] = [];
  let memberDidHandler: ((nick: string, did: string) => void) | null = null;
  return {
    whoisCalls,
    triggerMemberDid: (nick: string, did: string) => memberDidHandler?.(nick, did),
    deps: {
      whois: (nick: string) => {
        whoisCalls.push(nick);
      },
      onMemberDid: (h: (nick: string, did: string) => void) => {
        memberDidHandler = h;
        return () => {
          memberDidHandler = null;
        };
      },
      defaultTimeoutMs: 50,
    },
  };
}

describe('did_resolver', () => {
  it('returns cached DID without firing WHOIS', async () => {
    const t = makeDeps();
    const cache = createDidCache(t.deps);
    cache.set('alice', 'did:plc:abc');
    expect(await cache.resolveNick('alice')).toBe('did:plc:abc');
    expect(t.whoisCalls).toEqual([]);
  });

  it('fires WHOIS once for the same unresolved nick within window', async () => {
    const t = makeDeps();
    const cache = createDidCache(t.deps);
    const p1 = cache.resolveNick('bob');
    const p2 = cache.resolveNick('bob');
    expect(t.whoisCalls).toEqual(['bob']);
    t.triggerMemberDid('bob', 'did:plc:bob');
    expect(await p1).toBe('did:plc:bob');
    expect(await p2).toBe('did:plc:bob');
  });

  it('resolves to null after timeout if no WHOIS reply', async () => {
    const t = makeDeps();
    const cache = createDidCache(t.deps);
    expect(await cache.resolveNick('ghost')).toBeNull();
  });

  it('reverse lookup nickForDid', () => {
    const t = makeDeps();
    const cache = createDidCache(t.deps);
    cache.set('alice', 'did:plc:abc');
    expect(cache.nickForDid('did:plc:abc')).toBe('alice');
  });

  it('rebinds previous binding when same DID moves to new nick', () => {
    const t = makeDeps();
    const cache = createDidCache(t.deps);
    cache.set('alice', 'did:plc:abc');
    cache.set('alice2', 'did:plc:abc');
    expect(cache.nickForDid('did:plc:abc')).toBe('alice2');
    expect(cache.didForNick('alice')).toBeUndefined();
  });

  it('case-insensitive nick lookup', () => {
    const t = makeDeps();
    const cache = createDidCache(t.deps);
    cache.set('ALICE', 'did:plc:abc');
    expect(cache.didForNick('alice')).toBe('did:plc:abc');
    expect(cache.didForNick('Alice')).toBe('did:plc:abc');
  });

  it('forgetNick removes both directions', () => {
    const t = makeDeps();
    const cache = createDidCache(t.deps);
    cache.set('alice', 'did:plc:abc');
    cache.forgetNick('alice');
    expect(cache.didForNick('alice')).toBeUndefined();
    expect(cache.nickForDid('did:plc:abc')).toBeUndefined();
  });

  it('triggerMemberDid resolves pending waiters', async () => {
    const t = makeDeps();
    const cache = createDidCache(t.deps);
    const p = cache.resolveNick('lateboi', 5000);
    setTimeout(() => t.triggerMemberDid('lateboi', 'did:key:zL'), 10);
    expect(await p).toBe('did:key:zL');
  });

  it('whois fn that throws does not bubble up', async () => {
    const cache = createDidCache({
      whois: () => {
        throw new Error('socket gone');
      },
      onMemberDid: () => () => {},
      defaultTimeoutMs: 30,
    });
    expect(await cache.resolveNick('throwboi')).toBeNull();
  });
});
