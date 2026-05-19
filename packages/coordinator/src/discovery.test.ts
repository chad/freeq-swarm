import { describe, expect, it } from 'vitest';
import { handleDiscoveryRequest, parseDiscoveryResponse } from './discovery.js';
import { createDidCache, operatorAllowlistFromDids } from '@freeq-swarm/shared';

const CFG: any = {
  swarm: {
    channel: '#freeq-dev',
    founder_did: 'did:plc:founder',
    coordinator_nick: 'swarm',
    freeq_server: 'irc.freeq.at:6697',
  },
  operator_allowlist: ['did:plc:founder', 'did:plc:contributor1'],
  task_types: {
    pr_review: {
      reviewers_needed: 2,
      claim_window_ms: 30000,
      execution_timeout_ms: 300000,
      max_usd_per_reviewer: 1.5,
      allowed_repo_patterns: ['github.com/freeq-org/*'],
      max_retries_on_timeout: 1,
    },
  },
  budget: { daily_usd_per_agent: 5 },
  summary: { default_tz: 'UTC', default_time: '09:00', per_requester_tz: {} },
};

async function makeDeps() {
  const sentLines: string[] = [];
  const client: any = { raw: (l: string) => sentLines.push(l) };
  const didCache = createDidCache({ whois: () => {}, onMemberDid: () => () => {} });
  return {
    sentLines,
    deps: {
      client,
      config: CFG,
      coordinatorDid: 'did:key:zCoord',
      didCache,
      operatorAllowlist: await operatorAllowlistFromDids(CFG.operator_allowlist),
      description: 'Open-source PR review swarm for the freeq project',
    },
  };
}

describe('discovery', async () => {
  it('responds to "whoareyou" DM with a swarm.discovery/v1 payload', async () => {
    const t = await makeDeps();
    handleDiscoveryRequest(t.deps, { target: 'swarm', from: 'newcomer', text: 'whoareyou' });
    expect(t.sentLines).toHaveLength(1);
    const parsed = parseDiscoveryResponse(t.sentLines[0]!);
    expect(parsed).not.toBeNull();
    expect(parsed!.swarm_name).toBe('freeq-dev');
    expect(parsed!.channel).toBe('#freeq-dev');
    expect(parsed!.founder_did).toBe('did:plc:founder');
    expect(parsed!.coordinator_did).toBe('did:key:zCoord');
    expect(parsed!.policy.allowed_repo_patterns).toEqual(['github.com/freeq-org/*']);
    expect(parsed!.policy.daily_usd_per_agent).toBe(5);
    expect(parsed!.operator_allowlist_hint).toContain('did:plc:contributor1');
  });

  it('accepts case-insensitive trigger + aliases', async () => {
    const t = await makeDeps();
    handleDiscoveryRequest(t.deps, { target: 'swarm', from: 'a', text: 'WAI' });
    handleDiscoveryRequest(t.deps, { target: 'swarm', from: 'b', text: '  describe  ' });
    expect(t.sentLines).toHaveLength(2);
  });

  it('ignores non-trigger DMs', async () => {
    const t = await makeDeps();
    handleDiscoveryRequest(t.deps, { target: 'swarm', from: 'a', text: 'hi' });
    handleDiscoveryRequest(t.deps, { target: 'swarm', from: 'a', text: 'whoareyou now' });
    expect(t.sentLines).toHaveLength(0);
  });

  it('ignores DMs not addressed to coordinator nick', async () => {
    const t = await makeDeps();
    handleDiscoveryRequest(t.deps, { target: 'someone-else', from: 'a', text: 'whoareyou' });
    expect(t.sentLines).toHaveLength(0);
  });

  it('strips CRLF from sender nick to defend against injection', async () => {
    const t = await makeDeps();
    handleDiscoveryRequest(t.deps, { target: 'swarm', from: 'a\r\nKICK #x v', text: 'whoareyou' });
    for (const l of t.sentLines) {
      expect(l.indexOf('\r')).toBe(-1);
      expect(l.indexOf('\n')).toBe(-1);
    }
  });

  it('parseDiscoveryResponse returns null for non-discovery PRIVMSGs', async () => {
    expect(parseDiscoveryResponse('PRIVMSG x :hi')).toBeNull();
    expect(parseDiscoveryResponse('@msgid=01 PRIVMSG x :hi')).toBeNull();
  });
});
