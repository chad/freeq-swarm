// PR review executor: turn a unified diff into a swarm.review/v1 payload via
// the Anthropic SDK. The SDK call is injected so tests can stub it without
// hitting the network.
//
// PLAN §5.7, Phase 4a.
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  type Review,
  type ReviewComment,
  type Severity,
  type Verdict,
  Review as ReviewSchema,
} from '@freeq-swarm/shared';

export interface PrReviewInput {
  taskId: string;
  diff: string;
  reviewFocus: readonly string[];
  model: string;
  via: 'api' | 'cli' | 'max-subscription';
  /** Override the Anthropic call (for tests). */
  callModel?: ModelCall;
  /** Override the system prompt path (for tests). */
  systemPromptOverride?: string;
}

export interface ModelCallResult {
  /** Raw textual model output. */
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type ModelCall = (args: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}) => Promise<ModelCallResult>;

const PRICING_DEFAULTS: Record<string, { in: number; out: number }> = {
  'claude-opus-4-7': { in: 15.0, out: 75.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
};

let cachedSystemPrompt: string | null = null;

async function getSystemPrompt(override?: string): Promise<string> {
  if (override !== undefined) return override;
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, 'pr_review.prompt.md');
  cachedSystemPrompt = await readFile(path, 'utf8');
  return cachedSystemPrompt;
}

export const defaultAnthropicCall: ModelCall = async ({ model, systemPrompt, userPrompt }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    // Prompt-cache the long static system prompt by passing it as a single
    // ephemeral-cached block. (`cache_control` is supported via the betas
    // header in this SDK version; for v1 we send it as plain text. The
    // savings come once the SDK adds first-class typing for this field.)
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const text = res.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  return {
    text,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
  };
};

/** Build the user prompt: review_focus hint + the diff itself. */
export function buildUserPrompt(reviewFocus: readonly string[], diff: string): string {
  const focusStr = reviewFocus.length > 0
    ? `review_focus: ${JSON.stringify(reviewFocus)}\n\n`
    : '';
  return `${focusStr}DIFF:\n\n${diff}`;
}

/**
 * Strip optional ```json fences and other surrounding cruft from the model output,
 * then JSON.parse. Falls back to substring search for the first/last brace.
 */
export function extractJson(raw: string): unknown {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '');
  }
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw new Error('model output did not contain a JSON object');
  }
}

export interface ParsedReview {
  verdict: Verdict;
  severity: Severity;
  summary: string;
  comments: ReviewComment[];
}

const VERDICTS = new Set<Verdict>([
  'approve',
  'approve_with_comments',
  'request_changes',
  'reject',
]);
const SEVERITIES = new Set<Severity>(['none', 'low', 'medium', 'high', 'critical']);

export function normalizeReview(parsed: unknown): ParsedReview {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('review JSON must be an object');
  }
  const o = parsed as Record<string, unknown>;
  const verdict = o.verdict;
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict as Verdict)) {
    throw new Error(`invalid verdict: ${String(verdict)}`);
  }
  const sevIn = o.severity;
  const severity: Severity =
    typeof sevIn === 'string' && SEVERITIES.has(sevIn as Severity) ? (sevIn as Severity) : 'none';
  const summaryRaw = o.summary;
  const summary = typeof summaryRaw === 'string' ? summaryRaw.slice(0, 600) : '';
  const commentsRaw = Array.isArray(o.comments) ? o.comments : [];
  const comments: ReviewComment[] = [];
  for (const c of commentsRaw) {
    if (typeof c !== 'object' || c === null) continue;
    const cc = c as Record<string, unknown>;
    const file = typeof cc.file === 'string' ? cc.file : '';
    if (!file) continue;
    const cSev =
      typeof cc.severity === 'string' && SEVERITIES.has(cc.severity as Severity)
        ? (cc.severity as Severity)
        : 'low';
    const msg = typeof cc.msg === 'string' ? cc.msg.slice(0, 240) : '';
    if (!msg) continue;
    const line = typeof cc.line === 'number' && cc.line >= 0 ? cc.line : undefined;
    comments.push(line === undefined ? { file, severity: cSev, msg } : { file, line, severity: cSev, msg });
  }
  return { verdict: verdict as Verdict, severity, summary, comments };
}

const MAX_PAYLOAD_BYTES = 3_000;

/** Truncate `comments[]` from the end (keep highest-severity) until under cap. */
export function truncateForWire<T extends Review>(payload: T): T {
  const json = JSON.stringify(payload);
  if (json.length <= MAX_PAYLOAD_BYTES) return payload;
  // Sort comments by severity desc (critical > high > medium > low) and try
  // shrinking until we fit.
  const sevOrder: Record<Severity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
    none: 0,
  };
  const sorted = [...payload.comments].sort((a, b) => sevOrder[b.severity] - sevOrder[a.severity]);
  let n = sorted.length;
  while (n > 0) {
    const candidate: T = { ...payload, comments: sorted.slice(0, n), truncated: true };
    if (JSON.stringify(candidate).length <= MAX_PAYLOAD_BYTES) return candidate;
    n -= 1;
  }
  return { ...payload, comments: [], truncated: true };
}

/**
 * Pre-execution cost estimate from the actual diff size. Worker uses this in
 * Phase 4b to refuse with `task_failed :reason=budget_exceeded` before any
 * spend is incurred.
 */
export function estimateReviewCostUsd(model: string, diffBytes: number): number {
  const pricing = PRICING_DEFAULTS[model] ?? { in: 0, out: 0 };
  const inputTokens = Math.ceil(diffBytes / 3.5);
  return (
    (inputTokens * pricing.in) / 1_000_000 +
    (4096 * pricing.out) / 1_000_000
  );
}

export async function runPrReview(input: PrReviewInput): Promise<Review> {
  const systemPrompt = await getSystemPrompt(input.systemPromptOverride);
  const userPrompt = buildUserPrompt(input.reviewFocus, input.diff);
  const callModel = input.callModel ?? defaultAnthropicCall;
  const result = await callModel({ model: input.model, systemPrompt, userPrompt });
  const parsed = normalizeReview(extractJson(result.text));
  const pricing = PRICING_DEFAULTS[input.model] ?? { in: 0, out: 0 };
  const usdCost =
    (result.inputTokens * pricing.in) / 1_000_000 +
    (result.outputTokens * pricing.out) / 1_000_000;
  const review: Review = {
    kind: 'swarm.review/v1',
    evidence_type: 'code_review',
    task_id: input.taskId,
    verdict: parsed.verdict,
    severity: parsed.severity,
    summary: parsed.summary,
    comments: parsed.comments,
    truncated: false,
    tokens_used: result.inputTokens + result.outputTokens,
    usd_cost: Number(usdCost.toFixed(6)),
    model: input.model,
    via: input.via,
  };
  // Validate against zod (defense in depth — catches drift in our own builder).
  ReviewSchema.parse(review);
  return truncateForWire(review);
}
