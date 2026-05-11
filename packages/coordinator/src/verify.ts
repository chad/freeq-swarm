// Pure consensus algorithm for swarm.review/v1 evidence.
// PLAN §5.9.
//
// 1. Bucket reviews by verdict.
// 2. Strict majority (>50%) wins.
// 3. On tie: pick bucket with the highest *max* severity (favors caution).
// 4. If severities also tie: verdict order reject > request_changes >
//    approve_with_comments > approve.
// 5. agreement_score < 0.5 → consensus_irreconcilable.
import type { Severity, Verdict } from '@freeq-swarm/shared';

export interface ReviewSummary {
  worker_did: string;
  verdict: Verdict;
  severity: Severity;
}

export type ConsensusResult =
  | {
      ok: true;
      verdict: Verdict;
      severity: Severity;
      agreement_score: number;
      pickedDids: string[];
      dissenterDids: string[];
    }
  | {
      ok: false;
      reason: 'consensus_irreconcilable';
      detail: string;
      perReviewer: ReviewSummary[];
    };

const SEV_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

const VERDICT_RANK: Record<Verdict, number> = {
  reject: 4,
  request_changes: 3,
  approve_with_comments: 2,
  approve: 1,
};

export function computeConsensus(reviews: readonly ReviewSummary[]): ConsensusResult {
  if (reviews.length === 0) {
    return {
      ok: false,
      reason: 'consensus_irreconcilable',
      detail: 'no reviews submitted',
      perReviewer: [],
    };
  }
  // Bucket.
  const buckets = new Map<Verdict, ReviewSummary[]>();
  for (const r of reviews) {
    const list = buckets.get(r.verdict);
    if (list) list.push(r);
    else buckets.set(r.verdict, [r]);
  }
  // Largest bucket size.
  let largest = 0;
  for (const list of buckets.values()) if (list.length > largest) largest = list.length;
  const agreementScore = largest / reviews.length;
  // Pick candidates that match the largest bucket size.
  const tied: Array<[Verdict, ReviewSummary[]]> = [];
  for (const [v, list] of buckets) if (list.length === largest) tied.push([v, list]);

  if (largest / reviews.length < 0.5) {
    return {
      ok: false,
      reason: 'consensus_irreconcilable',
      detail: buildDissentDetail(reviews),
      perReviewer: [...reviews],
    };
  }

  let pickedVerdict: Verdict;
  let pickedBucket: ReviewSummary[];
  if (tied.length === 1) {
    [pickedVerdict, pickedBucket] = tied[0]!;
  } else {
    // Tie: highest max-severity wins; then verdict order.
    tied.sort(([va, la], [vb, lb]) => {
      const sa = Math.max(...la.map((r) => SEV_RANK[r.severity]));
      const sb = Math.max(...lb.map((r) => SEV_RANK[r.severity]));
      if (sa !== sb) return sb - sa;
      return VERDICT_RANK[vb] - VERDICT_RANK[va];
    });
    [pickedVerdict, pickedBucket] = tied[0]!;
  }
  // consensus_severity = max severity over picked bucket.
  const sev = pickedBucket.reduce<Severity>((acc, r) => {
    return SEV_RANK[r.severity] > SEV_RANK[acc] ? r.severity : acc;
  }, 'none');
  const pickedDids = pickedBucket.map((r) => r.worker_did);
  const dissenterDids = reviews
    .filter((r) => r.verdict !== pickedVerdict)
    .map((r) => r.worker_did);
  return {
    ok: true,
    verdict: pickedVerdict,
    severity: sev,
    agreement_score: agreementScore,
    pickedDids,
    dissenterDids,
  };
}

function buildDissentDetail(reviews: readonly ReviewSummary[]): string {
  const tally: Partial<Record<Verdict, number>> = {};
  for (const r of reviews) tally[r.verdict] = (tally[r.verdict] ?? 0) + 1;
  return `verdicts: ${Object.entries(tally)
    .map(([v, n]) => `${v}=${n}`)
    .join(', ')}`;
}
