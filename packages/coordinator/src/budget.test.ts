import { describe, expect, it } from 'vitest';
import {
  type BudgetResponse,
  computeWorkerEligibility,
  defaultRestBase,
} from './budget.js';

const BUDGET: BudgetResponse = {
  policy: { max_amount: 5, unit: 'usd', period: 'per_day' },
  current_period: {
    total_spent: 1.5,
    remaining: 3.5,
    percent_used: 30,
    by_agent: [
      { agent_did: 'did:key:hi-spend', spent: 4.5 },
      { agent_did: 'did:key:lo-spend', spent: 0.1 },
    ],
  },
};

describe('computeWorkerEligibility', () => {
  it('marks worker with insufficient remaining ineligible', () => {
    const r = computeWorkerEligibility(BUDGET, ['did:key:hi-spend'], 1.5);
    expect(r[0]!.eligible).toBe(false);
    expect(r[0]!.remaining).toBeCloseTo(0.5);
  });

  it('marks worker with enough remaining eligible', () => {
    const r = computeWorkerEligibility(BUDGET, ['did:key:lo-spend'], 1.5);
    expect(r[0]!.eligible).toBe(true);
  });

  it('defaults spent=0 for workers absent from by_agent', () => {
    const r = computeWorkerEligibility(BUDGET, ['did:key:never-spent'], 1.5);
    expect(r[0]!.spent).toBe(0);
    expect(r[0]!.remaining).toBeCloseTo(5);
    expect(r[0]!.eligible).toBe(true);
  });

  it('handles missing policy as infinite cap', () => {
    const noPolicy: BudgetResponse = {
      policy: null,
      current_period: { total_spent: 0, remaining: 0, percent_used: 0, by_agent: [] },
    };
    const r = computeWorkerEligibility(noPolicy, ['did:key:any'], 100);
    expect(r[0]!.eligible).toBe(true);
  });
});

describe('defaultRestBase', () => {
  it('strips port and uses https', () => {
    expect(defaultRestBase('irc.freeq.at:6697')).toBe('https://irc.freeq.at');
  });
});
