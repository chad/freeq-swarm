// BUDGET issuance + per-worker pre-flight via the freeq REST budget endpoint.
// PLAN §4.3 layer 2 + 3, F-12, F-13.
import type { FreeqClient } from '@freeq/sdk';

export interface BudgetPolicy {
  max_amount: number;
  unit: string;
  period: string;
  sponsor?: string;
}

export interface BudgetByAgent {
  agent_did: string;
  spent: number;
  items?: number;
}

export interface BudgetResponse {
  policy: BudgetPolicy | null;
  current_period: {
    total_spent: number;
    remaining: number;
    percent_used: number;
    by_agent: BudgetByAgent[];
  };
}

export interface IssueBudgetArgs {
  client: FreeqClient;
  channel: string;
  maxAmount: number;
  unit?: 'usd';
  period?: 'per_day' | 'per_week' | 'per_month';
  sponsorDid: string;
}

/**
 * Issue a channel-level BUDGET (`agent_did='*'`), which acts as the per-agent
 * default cap via fallback in `db.get_budget(channel, Some(did))`. PLAN §4.3.
 */
export function issueBudget(args: IssueBudgetArgs): void {
  const unit = args.unit ?? 'usd';
  const period = args.period ?? 'per_day';
  args.client.raw(
    `BUDGET ${args.channel} :max=${args.maxAmount};unit=${unit};period=${period};sponsor=${args.sponsorDid}`,
  );
}

/** Fetch the channel budget snapshot via REST. Returns null on network/parse error. */
export async function fetchBudget(
  baseUrl: string,
  channel: string,
): Promise<BudgetResponse | null> {
  const ch = channel.startsWith('#') ? channel.slice(1) : channel;
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/channels/${encodeURIComponent(ch)}/budget`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as BudgetResponse;
  } catch {
    return null;
  }
}

export interface PerWorkerRemaining {
  worker_did: string;
  spent: number;
  remaining: number;
  eligible: boolean;
}

/**
 * For a set of candidate worker DIDs, compute remaining budget against the
 * policy cap. Workers not in `by_agent[]` default to spent=0 (PLAN §4.3 layer 3).
 */
export function computeWorkerEligibility(
  budget: BudgetResponse,
  candidateDids: readonly string[],
  perReviewerCost: number,
): PerWorkerRemaining[] {
  const cap = budget.policy?.max_amount ?? Number.POSITIVE_INFINITY;
  const spentByDid = new Map(budget.current_period.by_agent.map((a) => [a.agent_did, a.spent]));
  return candidateDids.map((worker_did) => {
    const spent = spentByDid.get(worker_did) ?? 0;
    const remaining = cap - spent;
    return {
      worker_did,
      spent,
      remaining,
      eligible: remaining >= perReviewerCost,
    };
  });
}

/** Default REST base URL inferred from `host:port` IRC server, swapping to https + 80/443. */
export function defaultRestBase(server: string): string {
  const host = server.split(':')[0];
  return `https://${host}`;
}
