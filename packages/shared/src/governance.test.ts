import { describe, expect, it } from 'vitest';
import { isGovernanceSignal, parseGovernance } from './governance.js';

describe('parseGovernance', () => {
  it('parses pause TAGMSG', () => {
    const line = '@+freeq.at/governance=pause :coord!u@h TAGMSG worker';
    const g = parseGovernance(line);
    expect(g).not.toBeNull();
    expect(g!.signal).toBe('pause');
    expect(g!.target).toBe('worker');
    expect(g!.source).toBe('coord!u@h');
  });

  it('returns null for non-governance TAGMSG', () => {
    expect(parseGovernance('@+freeq.at/event=task_request TAGMSG #swarm')).toBeNull();
    expect(parseGovernance('PRIVMSG #swarm :hi')).toBeNull();
  });

  it('rejects unknown signal value', () => {
    expect(parseGovernance('@+freeq.at/governance=cuddle TAGMSG worker')).toBeNull();
  });

  it('parses budget_exceeded NOTICE', () => {
    const line = '@+freeq.at/governance=budget_exceeded :server NOTICE worker :exceeded';
    const g = parseGovernance(line);
    expect(g!.signal).toBe('budget_exceeded');
  });

  it('extracts detail tag', () => {
    const line = '@+freeq.at/governance=pause;+freeq.at/detail=for_test :coord TAGMSG worker';
    expect(parseGovernance(line)!.detail).toBe('for_test');
  });

  it('isGovernanceSignal validates the enum', () => {
    expect(isGovernanceSignal('pause')).toBe(true);
    expect(isGovernanceSignal('foo')).toBe(false);
  });
});
