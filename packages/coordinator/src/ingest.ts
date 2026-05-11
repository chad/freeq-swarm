// Parse human-typed task ingestion messages addressed to the coordinator nick.
// PLAN §5.3.
//
// Input examples (the part after addressing):
//   review https://github.com/foo/bar/pull/42
//   review https://github.com/foo/bar/pull/42 reviewers=3 priority=high
//   fix    https://github.com/foo/bar/issues/123
//   fix    https://github.com/foo/bar/issues/123 test_command="npm test"

export type TaskTypeName = 'review' | 'fix';

export interface ParsedReviewSpec {
  task_type: 'pr_review';
  /** github owner/repo (no 'github.com/' prefix) */
  repo: string;
  pr: number;
  url: string;
  flags: {
    reviewers?: number;
    priority?: 'low' | 'normal' | 'high';
    model?: string;
  };
}

export interface ParsedIssueFixSpec {
  task_type: 'issue_fix';
  repo: string;
  issue: number;
  url: string;
  flags: {
    test_command?: string;
    base_branch?: string;
    max_turns?: number;
    model?: string;
  };
}

export type ParseResult =
  | { ok: true; spec: ParsedReviewSpec | ParsedIssueFixSpec }
  | { ok: false; reason: 'unknown_task_type' | 'missing_url' | 'bad_url' | 'unknown_flag' | 'bad_flag_value'; detail: string };

const ADDRESSING_RE = /^(?:@?(\S+?)[:,]?)\s+(.*)$/s;

const REVIEW_FLAGS = new Set(['reviewers', 'priority', 'model']);
const FIX_FLAGS = new Set(['test_command', 'base_branch', 'max_turns', 'model']);
const ALLOWED_PRIORITY = new Set(['low', 'normal', 'high']);

const PR_URL_RE =
  /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[\/?#].*)?$/;
const ISSUE_URL_RE =
  /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)(?:[\/?#].*)?$/;

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
  const tokens = tokenize(trimmed);
  const taskType = tokens[0]?.toLowerCase();
  if (taskType === 'review') return parseReview(tokens);
  if (taskType === 'fix') return parseFix(tokens);
  return {
    ok: false,
    reason: 'unknown_task_type',
    detail: `unknown task type: '${taskType ?? ''}'. v1 supports: review, fix`,
  };
}

/**
 * Tokenize on whitespace but preserve content inside double-quotes so that
 * test_command="npm run test:ci" is a single token.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i += 1;
    if (i >= input.length) break;
    let token = '';
    let inQuote = false;
    while (i < input.length) {
      const c = input[i]!;
      if (c === '"') {
        inQuote = !inQuote;
        i += 1;
        continue;
      }
      if (!inQuote && /\s/.test(c)) break;
      token += c;
      i += 1;
    }
    tokens.push(token);
  }
  return tokens;
}

function parseReview(tokens: string[]): ParseResult {
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
  if (rejectTraversal(owner!, repoName!)) {
    return { ok: false, reason: 'bad_url', detail: `path-traversal segment in URL: ${url}` };
  }
  const repo = `${owner}/${repoName}`;
  const pr = Number.parseInt(prStr!, 10);

  const flags: ParsedReviewSpec['flags'] = {};
  for (let i = 2; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const eq = t.indexOf('=');
    if (eq < 1) return { ok: false, reason: 'unknown_flag', detail: `bad flag syntax: '${t}'` };
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1);
    if (!REVIEW_FLAGS.has(k)) {
      return {
        ok: false,
        reason: 'unknown_flag',
        detail: `unknown flag '${k}'. allowed: ${[...REVIEW_FLAGS].join(', ')}`,
      };
    }
    if (k === 'reviewers') {
      if (!/^\d{1,4}$/.test(v)) {
        return { ok: false, reason: 'bad_flag_value', detail: `reviewers must be a decimal integer in [1,16]; got '${v}'` };
      }
      const n = Number.parseInt(v, 10);
      if (n < 1 || n > 16) {
        return { ok: false, reason: 'bad_flag_value', detail: `reviewers must be an integer in [1,16]; got '${v}'` };
      }
      flags.reviewers = n;
    } else if (k === 'priority') {
      if (!ALLOWED_PRIORITY.has(v)) {
        return { ok: false, reason: 'bad_flag_value', detail: `priority must be low|normal|high; got '${v}'` };
      }
      flags.priority = v as 'low' | 'normal' | 'high';
    } else if (k === 'model') {
      if (!/^[\w-]+$/.test(v)) return { ok: false, reason: 'bad_flag_value', detail: `model: bad chars in '${v}'` };
      flags.model = v;
    }
  }
  return {
    ok: true,
    spec: { task_type: 'pr_review', repo: `github.com/${repo}`, pr, url, flags },
  };
}

function parseFix(tokens: string[]): ParseResult {
  if (!tokens[1]) {
    return { ok: false, reason: 'missing_url', detail: 'usage: @swarm fix <issue-url> [k=v...]' };
  }
  const url = tokens[1];
  const m = ISSUE_URL_RE.exec(url);
  if (!m) {
    return {
      ok: false,
      reason: 'bad_url',
      detail: `expected a https://github.com/<owner>/<repo>/issues/<n> URL; got: ${url}`,
    };
  }
  const [, owner, repoName, issueStr] = m;
  if (rejectTraversal(owner!, repoName!)) {
    return { ok: false, reason: 'bad_url', detail: `path-traversal segment in URL: ${url}` };
  }
  const repo = `${owner}/${repoName}`;
  const issue = Number.parseInt(issueStr!, 10);

  const flags: ParsedIssueFixSpec['flags'] = {};
  for (let i = 2; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const eq = t.indexOf('=');
    if (eq < 1) return { ok: false, reason: 'unknown_flag', detail: `bad flag syntax: '${t}'` };
    const k = t.slice(0, eq);
    const v = t.slice(eq + 1);
    if (!FIX_FLAGS.has(k)) {
      return {
        ok: false,
        reason: 'unknown_flag',
        detail: `unknown flag '${k}'. allowed: ${[...FIX_FLAGS].join(', ')}`,
      };
    }
    if (k === 'test_command') {
      if (v.length > 256) {
        return { ok: false, reason: 'bad_flag_value', detail: 'test_command must be ≤256 chars' };
      }
      flags.test_command = v;
    } else if (k === 'base_branch') {
      if (!/^[\w./-]+$/.test(v)) {
        return { ok: false, reason: 'bad_flag_value', detail: `base_branch has bad chars: '${v}'` };
      }
      flags.base_branch = v;
    } else if (k === 'max_turns') {
      if (!/^\d{1,3}$/.test(v)) {
        return { ok: false, reason: 'bad_flag_value', detail: `max_turns must be 1..200; got '${v}'` };
      }
      const n = Number.parseInt(v, 10);
      if (n < 1 || n > 200) {
        return { ok: false, reason: 'bad_flag_value', detail: `max_turns must be 1..200; got '${v}'` };
      }
      flags.max_turns = n;
    } else if (k === 'model') {
      if (!/^[\w-]+$/.test(v)) return { ok: false, reason: 'bad_flag_value', detail: `model: bad chars in '${v}'` };
      flags.model = v;
    }
  }
  return {
    ok: true,
    spec: { task_type: 'issue_fix', repo: `github.com/${repo}`, issue, url, flags },
  };
}

function rejectTraversal(owner: string, repoName: string): boolean {
  for (const s of [owner, repoName]) if (s === '..' || s === '.') return true;
  return false;
}
