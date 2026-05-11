import { describe, expect, it, vi } from 'vitest';
import { attachGovernanceHandler } from './governance.js';

function makeHarness(nick = 'wA') {
  const sentLines: string[] = [];
  const presenceCalls: Array<[string, string | undefined]> = [];
  const stateCalls: Array<[string, string]> = [];
  let revoked = false;
  const fakeClient: any = {
    raw: (l: string) => sentLines.push(l),
    on: () => {},
    off: () => {},
  };
  const h = attachGovernanceHandler({
    client: fakeClient,
    nick: () => nick,
    setPresence: (s, e) => presenceCalls.push([s, e]),
    onStateChange: (s, sig) => stateCalls.push([s, sig]),
    onRevoke: () => {
      revoked = true;
    },
  });
  return { h, sentLines, presenceCalls, stateCalls, isRevoked: () => revoked };
}

describe('attachGovernanceHandler', () => {
  it('starts in normal state', () => {
    const t = makeHarness();
    expect(t.h.state()).toBe('normal');
  });

  it('transitions to paused on +freeq.at/governance=pause', () => {
    const t = makeHarness('wA');
    t.h.feed('@+freeq.at/governance=pause :coord!u@h TAGMSG wA');
    expect(t.h.state()).toBe('paused');
    expect(t.presenceCalls[0]).toEqual(['paused', 'paused by issuer']);
    expect(t.stateCalls[0]).toEqual(['paused', 'pause']);
  });

  it('returns to normal on resume', () => {
    const t = makeHarness('wA');
    t.h.feed('@+freeq.at/governance=pause :c TAGMSG wA');
    t.h.feed('@+freeq.at/governance=resume :c TAGMSG wA');
    expect(t.h.state()).toBe('normal');
    expect(t.presenceCalls).toEqual([['paused', 'paused by issuer'], ['idle', undefined]]);
  });

  it('blocked_on_budget on budget_exceeded', () => {
    const t = makeHarness('wA');
    t.h.feed('@+freeq.at/governance=budget_exceeded :server TAGMSG wA');
    expect(t.h.state()).toBe('blocked_on_budget');
  });

  it('revoke fires onRevoke and freezes state', () => {
    const t = makeHarness('wA');
    t.h.feed('@+freeq.at/governance=revoke :c TAGMSG wA');
    expect(t.h.state()).toBe('revoked');
    expect(t.isRevoked()).toBe(true);
    // Subsequent signals are no-ops.
    t.h.feed('@+freeq.at/governance=resume :c TAGMSG wA');
    expect(t.h.state()).toBe('revoked');
  });

  it('ignores signals targeted at other nicks', () => {
    const t = makeHarness('wA');
    t.h.feed('@+freeq.at/governance=pause :c TAGMSG wB');
    expect(t.h.state()).toBe('normal');
  });

  it('case-insensitive nick match', () => {
    const t = makeHarness('WA');
    t.h.feed('@+freeq.at/governance=pause :c TAGMSG wa');
    expect(t.h.state()).toBe('paused');
  });

  it('approval_granted / approval_denied are no-ops in v1', () => {
    const t = makeHarness();
    t.h.feed('@+freeq.at/governance=approval_granted :c TAGMSG wA');
    t.h.feed('@+freeq.at/governance=approval_denied :c TAGMSG wA');
    expect(t.h.state()).toBe('normal');
  });

  it('ignores non-governance TAGMSG', () => {
    const t = makeHarness();
    t.h.feed('@+freeq.at/event=task_request TAGMSG #swarm');
    expect(t.h.state()).toBe('normal');
  });

  it('ignores PRIVMSG without governance tag', () => {
    const t = makeHarness();
    t.h.feed('PRIVMSG wA :hello');
    expect(t.h.state()).toBe('normal');
  });
});
