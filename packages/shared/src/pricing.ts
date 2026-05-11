// Anthropic pricing constants used by the cost estimator.
// `valid_until` is a soft hint — coordinator emits a warning on startup if past,
// and refuses to estimate when stale by >30 days (treated as policy_violation).

export interface ModelPricing {
  valid_until: string; // ISO date
  input_per_mtok: number; // USD per million input tokens
  output_per_mtok: number; // USD per million output tokens
  nominal_output_tokens: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7': {
    valid_until: '2026-08-01',
    input_per_mtok: 15.0,
    output_per_mtok: 75.0,
    nominal_output_tokens: 4096,
  },
  'claude-sonnet-4-6': {
    valid_until: '2026-08-01',
    input_per_mtok: 3.0,
    output_per_mtok: 15.0,
    nominal_output_tokens: 4096,
  },
};

/** Estimate USD cost for a model given input bytes (will be ÷3.5 for input tokens). */
export function estimateUsd(model: string, inputBytes: number): number | null {
  const p = PRICING[model];
  if (!p) return null;
  const inputTokens = Math.ceil(inputBytes / 3.5);
  return (
    (inputTokens * p.input_per_mtok) / 1_000_000 +
    (p.nominal_output_tokens * p.output_per_mtok) / 1_000_000
  );
}

/** True if the model's pricing data is older than 30 days past valid_until. */
export function isStale(model: string, now: Date = new Date()): boolean {
  const p = PRICING[model];
  if (!p) return true;
  const validUntil = new Date(p.valid_until);
  const cutoff = new Date(validUntil.getTime() + 30 * 24 * 60 * 60 * 1000);
  return now > cutoff;
}
