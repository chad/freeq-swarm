// Parse human-typed task ingestion messages addressed to the coordinator nick.
// PLAN §5.3.
//
// Input examples (the part after addressing):
//   "review https://github.com/foo/bar/pull/42"
//   "review https://github.com/foo/bar/pull/42 reviewers=3 priority=high"
//
// Output: a parsed task spec or a structured error explaining the refusal.

export type TaskTypeName = 'review';

export interface ParsedReviewSpec {
  task_type: 'pr_review';
  /** github owner/repo */
  repo: string;
  pr: number;
  url: string;
  flags: {
    reviewers?: number;
    priority?: 'low' | 'normal' | 'high';
    model?: string;
  };
}

export type ParseResult =
  | { ok: true; spec: ParsedReviewSpec }
  | { ok: false; reason: 'unknown_task_type' | 'missing_url' | 'bad_url' | 'unknown_flag' | 'bad_flag_value'; detail: string };

const ADDRESSING_RE = /^(?:@?(\S+?)[:,]?)\s+(.*)$/s;

const ALLOWED_FLAGS = new Set(['reviewers', 'priority', 'model']);
const ALLOWED_PRIORITY = new Set(['low', 'normal', 'high']);

const PR_URL_RE =
  /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[\/?#].*)?$/;

/**
 * Strip the `@swarm` / `swarm:` / `swarm,` addressing prefix from a PRIVMSG body.
 * Returns the remainder if `nick` matched (case-insensitive), null otherwise.
 */
export function stripAddressing(text: string, coordinatorNick: string): string | null {
  const m = ADDRESSING_RE.exec(text);
  if (!m) return null;
  const addressedTo = m[1]!.toLowerCase();
  if (addressedTo !== coordinatorNick.toLowerCase()) return null;
  return m[2]!;
}

export function parseTaskCommand(body: string): ParseResult {
  const trimmed = body.trim();
  const tokens = trimmed.split(/\s+/);
  const taskType = tokens[0]?.toLowerCase();
  if (taskType !== 'review') {
    return {
      ok: false,
      reason: 'unknown_task_type',
      detail: `unknown task type: '${taskType ?? ''}'. v1 supports: review`,
    };
  }
  if (!tokens[1]) {
    return { ok: false, reason: 'missing_url', detail: 'usage: @swarm review <pr-url> [k=v...]' };
  }

  const url = tokens[1];
  const m = PR_URL_RE.exec(url);
  if (!m) {
    return {
      ok: false,
      reason: 'bad_url',
      detail: `expected a https://github.com/<owner>/<repo>/pull/<n> URL; got: ${url}`,
    };
  }
  const [, owner, repoName, prStr] = m;
  const repo = `${owner}/${repoName}`;
  const pr = Number.parseInt(prStr!, 10);

  const flags: ParsedReviewSpec['flags'] = {};
  for (let i = 2; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const eq = t.indexOf('=');
    if (eq < 1) {
      return { ok: false, reason: 'unknown_flag', detail: `bad flag syntax: '${t}'` };
    }
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1);
    if (!ALLOWED_FLAGS.has(k)) {
      return {
        ok: false,
        reason: 'unknown_flag',
        detail: `unknown flag '${k}'. allowed: ${Array.from(ALLOWED_FLAGS).join(', ')}`,
      };
    }
    if (k === 'reviewers') {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1 || n > 16) {
        return {
          ok: false,
          reason: 'bad_flag_value',
          detail: `reviewers must be an integer in [1,16]; got '${v}'`,
        };
      }
      flags.reviewers = n;
    } else if (k === 'priority') {
      if (!ALLOWED_PRIORITY.has(v)) {
        return {
          ok: false,
          reason: 'bad_flag_value',
          detail: `priority must be low|normal|high; got '${v}'`,
        };
      }
      flags.priority = v as 'low' | 'normal' | 'high';
    } else if (k === 'model') {
      // Validation against PRICING table happens later (we don't want to
      // import PRICING here to keep this module pure).
      if (!/^[\w-]+$/.test(v)) {
        return { ok: false, reason: 'bad_flag_value', detail: `model: bad chars in '${v}'` };
      }
      flags.model = v;
    }
  }

  return {
    ok: true,
    spec: { task_type: 'pr_review', repo: `github.com/${repo}`, pr, url, flags },
  };
}
