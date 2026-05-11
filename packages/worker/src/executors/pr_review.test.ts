import { describe, expect, it } from 'vitest';
import {
  buildUserPrompt,
  extractJson,
  normalizeReview,
  runPrReview,
  truncateForWire,
} from './pr_review.js';
import type { Review } from '@freeq-swarm/shared';

const STUB_PROMPT = 'system prompt for tests';

describe('buildUserPrompt', () => {
  it('inlines review_focus when present', () => {
    expect(buildUserPrompt(['correctness'], 'DIFF')).toContain('review_focus: ["correctness"]');
  });
  it('omits review_focus when empty', () => {
    expect(buildUserPrompt([], 'DIFF')).not.toContain('review_focus');
  });
});

describe('extractJson', () => {
  it('parses a plain JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('strips bare ``` fences', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('falls back to first/last brace', () => {
    expect(extractJson('preamble {"a":1} trailing')).toEqual({ a: 1 });
  });
  it('throws when no JSON object present', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('normalizeReview', () => {
  it('passes through a clean review', () => {
    const out = normalizeReview({
      verdict: 'approve_with_comments',
      severity: 'low',
      summary: 'lgtm',
      comments: [{ file: 'a.ts', line: 1, severity: 'low', msg: 'nit' }],
    });
    expect(out.verdict).toBe('approve_with_comments');
    expect(out.comments).toHaveLength(1);
  });
  it('rejects bad verdict', () => {
    expect(() => normalizeReview({ verdict: 'meh' })).toThrow();
  });
  it('coerces unknown severity to none', () => {
    const out = normalizeReview({ verdict: 'approve', severity: 'super-high', summary: '' });
    expect(out.severity).toBe('none');
  });
  it('truncates summary to 600 chars', () => {
    const out = normalizeReview({
      verdict: 'approve',
      severity: 'none',
      summary: 'x'.repeat(2000),
    });
    expect(out.summary.length).toBe(600);
  });
  it('drops comments missing required fields', () => {
    const out = normalizeReview({
      verdict: 'approve',
      severity: 'none',
      summary: '',
      comments: [
        { file: 'a.ts', severity: 'low', msg: 'ok' },
        { file: '', severity: 'low', msg: 'no file' },
        { file: 'b.ts', severity: 'low', msg: '' },
      ],
    });
    expect(out.comments).toHaveLength(1);
  });
  it('truncates comment msg to 240 chars', () => {
    const out = normalizeReview({
      verdict: 'approve',
      severity: 'none',
      summary: '',
      comments: [{ file: 'a.ts', severity: 'low', msg: 'x'.repeat(1000) }],
    });
    expect(out.comments[0]!.msg.length).toBe(240);
  });
  it('omits negative line numbers', () => {
    const out = normalizeReview({
      verdict: 'approve',
      severity: 'none',
      summary: '',
      comments: [{ file: 'a.ts', line: -5, severity: 'low', msg: 'x' }],
    });
    expect(out.comments[0]!.line).toBeUndefined();
  });
});

describe('truncateForWire', () => {
  function makeReview(commentCount: number): Review {
    const comments = Array.from({ length: commentCount }, (_, i) => ({
      file: `f${i}.ts`,
      line: i,
      severity: 'low' as const,
      msg: 'x'.repeat(200),
    }));
    return {
      kind: 'swarm.review/v1',
      evidence_type: 'code_review',
      task_id: '01TASK',
      verdict: 'approve_with_comments',
      severity: 'low',
      summary: 'ok',
      comments,
      truncated: false,
      tokens_used: 100,
      usd_cost: 0.01,
      model: 'claude-opus-4-7',
      via: 'api',
    };
  }
  it('passes through small payloads unchanged', () => {
    const r = makeReview(2);
    expect(truncateForWire(r)).toEqual(r);
  });
  it('marks truncated and shrinks comments when too big', () => {
    const r = makeReview(50);
    const t = truncateForWire(r);
    expect(t.truncated).toBe(true);
    expect(t.comments.length).toBeLessThan(r.comments.length);
    expect(JSON.stringify(t).length).toBeLessThanOrEqual(3_000);
  });
  it('keeps higher-severity comments first', () => {
    const r = makeReview(2);
    r.comments[0]!.severity = 'low';
    r.comments[1]!.severity = 'critical';
    // pad with bulk to force trimming
    for (let i = 0; i < 80; i += 1) {
      r.comments.push({ file: `pad${i}.ts`, severity: 'low', msg: 'x'.repeat(100) });
    }
    const t = truncateForWire(r);
    const sevs = t.comments.map((c) => c.severity);
    expect(sevs[0]).toBe('critical');
  });
});

describe('runPrReview', () => {
  it('builds a valid swarm.review/v1 from the model output', async () => {
    const stubCall = async () => ({
      text: JSON.stringify({
        verdict: 'approve_with_comments',
        severity: 'low',
        summary: 'two nits',
        comments: [
          { file: 'a.ts', line: 1, severity: 'low', msg: 'rename foo' },
          { file: 'a.ts', line: 5, severity: 'low', msg: 'add a test' },
        ],
      }),
      inputTokens: 500,
      outputTokens: 200,
    });
    const out = await runPrReview({
      taskId: '01TASK',
      diff: 'diff --git a/a.ts b/a.ts\n+x',
      reviewFocus: ['correctness'],
      model: 'claude-opus-4-7',
      via: 'api',
      callModel: stubCall,
      systemPromptOverride: STUB_PROMPT,
    });
    expect(out.kind).toBe('swarm.review/v1');
    expect(out.task_id).toBe('01TASK');
    expect(out.verdict).toBe('approve_with_comments');
    expect(out.comments).toHaveLength(2);
    expect(out.tokens_used).toBe(700);
    expect(out.usd_cost).toBeGreaterThan(0);
    expect(out.model).toBe('claude-opus-4-7');
    expect(out.via).toBe('api');
  });

  it('fails loudly on malformed model output', async () => {
    await expect(
      runPrReview({
        taskId: '01TASK',
        diff: 'x',
        reviewFocus: [],
        model: 'claude-opus-4-7',
        via: 'api',
        callModel: async () => ({ text: 'lorem ipsum no json', inputTokens: 1, outputTokens: 1 }),
        systemPromptOverride: STUB_PROMPT,
      }),
    ).rejects.toThrow();
  });

  it('returns truncated flag for an oversized review', async () => {
    const huge = JSON.stringify({
      verdict: 'request_changes',
      severity: 'high',
      summary: 'many problems',
      comments: Array.from({ length: 100 }, (_, i) => ({
        file: `f${i}.ts`,
        line: i,
        severity: 'medium',
        msg: 'x'.repeat(200),
      })),
    });
    const out = await runPrReview({
      taskId: '01TASK',
      diff: 'x',
      reviewFocus: [],
      model: 'claude-opus-4-7',
      via: 'api',
      callModel: async () => ({ text: huge, inputTokens: 5000, outputTokens: 4000 }),
      systemPromptOverride: STUB_PROMPT,
    });
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(3_000);
  });
});
