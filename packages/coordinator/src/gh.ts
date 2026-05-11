// Wrapper around the `gh` CLI for PR metadata + diff fetching.
// PLAN §5.4 (head_sha resolution), §5.7 (compare-based diff fetch).
//
// We shell out rather than using octokit so workers + coordinator can lean on
// the user's existing `gh auth`. Failure mapping per §5.4 ingestion errors.
import { spawn } from 'node:child_process';

export type GhFailure =
  | { kind: 'auth_error'; message: string }
  | { kind: 'repo_not_found_or_private'; message: string }
  | { kind: 'network_error'; message: string };

export interface PrHeadInfo {
  head_sha: string;
  base_sha: string;
  diff_url: string;
}

export interface GhOptions {
  /** Override the path to gh (for tests). Default: 'gh'. */
  ghBin?: string;
  /** Per-call timeout. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 15_000;

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGh(args: readonly string[], opts: GhOptions = {}): Promise<GhResult> {
  const bin = opts.ghBin ?? 'gh';
  return new Promise<GhResult>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      timer = null;
      reject(new Error(`gh timeout after ${opts.timeoutMs ?? DEFAULT_TIMEOUT}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT);
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      timer = null;
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Map a non-zero `gh` exit into a structured failure.
 * The `auth` failure is detected by stderr signaling.
 */
export function mapGhFailure(stderr: string, err?: Error): GhFailure {
  const msg = (stderr || err?.message || '').trim();
  const lower = msg.toLowerCase();
  if (
    lower.includes('not logged into') ||
    lower.includes('authentication required') ||
    lower.includes('no such credentials') ||
    lower.includes('http 401')
  ) {
    return { kind: 'auth_error', message: msg };
  }
  if (
    lower.includes('not found') ||
    lower.includes('http 404') ||
    lower.includes('could not resolve to a repository')
  ) {
    return { kind: 'repo_not_found_or_private', message: msg };
  }
  return { kind: 'network_error', message: msg };
}

export interface IssueInfo {
  title: string;
  body: string;
  state: 'open' | 'closed' | string;
  url: string;
}

/**
 * Fetch issue title + body + state via `gh issue view`.
 * Used by issue_fix ingestion to populate the task spec for the worker.
 */
export async function fetchIssue(
  repo: string,
  issue: number,
  opts: GhOptions = {},
): Promise<{ ok: true; info: IssueInfo } | { ok: false; failure: GhFailure }> {
  let res: GhResult;
  try {
    res = await runGh(
      ['issue', 'view', String(issue), '--repo', repo, '--json', 'title,body,state,url'],
      opts,
    );
  } catch (err) {
    return { ok: false, failure: mapGhFailure('', err as Error) };
  }
  if (res.code !== 0) return { ok: false, failure: mapGhFailure(res.stderr) };
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, failure: { kind: 'network_error', message: `bad JSON from gh: ${res.stdout}` } };
  }
  const title = typeof parsed?.title === 'string' ? parsed.title : '';
  const body = typeof parsed?.body === 'string' ? parsed.body : '';
  const state = typeof parsed?.state === 'string' ? parsed.state : 'open';
  const url = typeof parsed?.url === 'string' ? parsed.url : `https://github.com/${repo}/issues/${issue}`;
  if (!title) {
    return { ok: false, failure: { kind: 'network_error', message: 'gh returned no title' } };
  }
  return { ok: true, info: { title, body, state, url } };
}

/**
 * Fetch the PR's head/base SHA + diff URL via `gh pr view`. PLAN §5.4.
 */
export async function fetchPrHeadInfo(
  repo: string, // 'owner/repo' (no 'github.com/' prefix)
  pr: number,
  opts: GhOptions = {},
): Promise<{ ok: true; info: PrHeadInfo } | { ok: false; failure: GhFailure }> {
  let res: GhResult;
  try {
    res = await runGh(
      [
        'pr',
        'view',
        String(pr),
        '--repo',
        repo,
        '--json',
        'headRefOid,baseRefOid,url',
      ],
      opts,
    );
  } catch (err) {
    return { ok: false, failure: mapGhFailure('', err as Error) };
  }
  if (res.code !== 0) {
    return { ok: false, failure: mapGhFailure(res.stderr) };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return {
      ok: false,
      failure: { kind: 'network_error', message: `bad JSON from gh: ${res.stdout}` },
    };
  }
  const head_sha = parsed?.headRefOid;
  const base_sha = parsed?.baseRefOid;
  if (typeof head_sha !== 'string' || typeof base_sha !== 'string') {
    return {
      ok: false,
      failure: { kind: 'network_error', message: 'gh returned no headRefOid/baseRefOid' },
    };
  }
  const url = typeof parsed.url === 'string' ? parsed.url : '';
  const diff_url = url ? `${url.replace(/\/$/, '')}.diff` : `https://github.com/${repo}/pull/${pr}.diff`;
  return { ok: true, info: { head_sha, base_sha, diff_url } };
}
