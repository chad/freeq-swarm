// SHA-pinned diff fetcher. PLAN §5.7.
//
// 1. gh api repos/<repo>/pulls/<pr> → confirm head_sha matches; else head_sha_lost.
// 2. gh api repos/<repo>/commits/<head_sha> → confirm SHA reachable.
// 3. gh api repos/<repo>/compare/<base>...<head> → returns {files: [{filename,patch,...}]}.
// 4. Reconstruct unified diff per file (the API returns per-file hunks without headers).
// 5. Refuse PRs with 300-file cap or any non-removed file with patch===null.
import { spawn } from 'node:child_process';

export type DiffFailure =
  | 'head_sha_lost'
  | 'diff_too_large'
  | 'auth_error'
  | 'repo_not_found_or_private'
  | 'network_error';

export interface DiffResult {
  ok: true;
  diff: string;
  files: number;
  totalAdditions: number;
  totalDeletions: number;
}

export interface DiffOptions {
  ghBin?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 20_000;
const GITHUB_FILE_CAP = 300;

interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGh(args: readonly string[], opts: DiffOptions): Promise<GhResult> {
  const bin = opts.ghBin ?? 'gh';
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
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
      reject(new Error(`gh timeout after ${timeout}ms`));
    }, timeout);
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

function classifyFailure(stderr: string): DiffFailure {
  const lower = stderr.toLowerCase();
  if (
    lower.includes('not logged into') ||
    lower.includes('authentication required') ||
    lower.includes('http 401')
  )
    return 'auth_error';
  if (lower.includes('http 404') || lower.includes('not found')) return 'repo_not_found_or_private';
  return 'network_error';
}

interface ComparePatchFile {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  patch?: string | null;
  previous_filename?: string;
}

interface ComparePatchResponse {
  files?: ComparePatchFile[];
  total_commits?: number;
  status?: string;
}

export async function fetchPinnedDiff(args: {
  repo: string; // 'owner/repo'
  pr: number;
  expectedHeadSha: string;
  opts?: DiffOptions;
}): Promise<DiffResult | { ok: false; reason: DiffFailure; detail?: string }> {
  const opts = args.opts ?? {};
  // 1. PR metadata — confirm head still matches.
  let prRes: GhResult;
  try {
    prRes = await runGh(['api', `repos/${args.repo}/pulls/${args.pr}`], opts);
  } catch (e) {
    return { ok: false, reason: 'network_error', detail: (e as Error).message };
  }
  if (prRes.code !== 0) {
    return { ok: false, reason: classifyFailure(prRes.stderr), detail: prRes.stderr.slice(0, 240) };
  }
  let prJson: any;
  try {
    prJson = JSON.parse(prRes.stdout);
  } catch {
    return { ok: false, reason: 'network_error', detail: 'bad PR JSON' };
  }
  const headSha = prJson?.head?.sha;
  const baseSha = prJson?.base?.sha;
  if (typeof headSha !== 'string' || typeof baseSha !== 'string') {
    return { ok: false, reason: 'network_error', detail: 'PR JSON missing sha fields' };
  }
  if (headSha !== args.expectedHeadSha) {
    return {
      ok: false,
      reason: 'head_sha_lost',
      detail: `PR head moved: was ${args.expectedHeadSha}, is ${headSha}`,
    };
  }

  // 2. Confirm SHA reachable (catches edge case of deleted branch but cached PR JSON).
  let commitRes: GhResult;
  try {
    commitRes = await runGh(['api', `repos/${args.repo}/commits/${headSha}`], opts);
  } catch (e) {
    return { ok: false, reason: 'network_error', detail: (e as Error).message };
  }
  if (commitRes.code !== 0) {
    const fail = classifyFailure(commitRes.stderr);
    if (fail === 'repo_not_found_or_private') {
      return { ok: false, reason: 'head_sha_lost', detail: 'commit not reachable' };
    }
    return { ok: false, reason: fail, detail: commitRes.stderr.slice(0, 240) };
  }

  // 3. Compare endpoint for the actual diff.
  let cmpRes: GhResult;
  try {
    cmpRes = await runGh(
      ['api', `repos/${args.repo}/compare/${baseSha}...${headSha}`],
      opts,
    );
  } catch (e) {
    return { ok: false, reason: 'network_error', detail: (e as Error).message };
  }
  if (cmpRes.code !== 0) {
    return { ok: false, reason: classifyFailure(cmpRes.stderr), detail: cmpRes.stderr.slice(0, 240) };
  }
  let cmp: ComparePatchResponse;
  try {
    cmp = JSON.parse(cmpRes.stdout);
  } catch {
    return { ok: false, reason: 'network_error', detail: 'bad compare JSON' };
  }
  const files = cmp.files ?? [];
  if (files.length >= GITHUB_FILE_CAP) {
    return {
      ok: false,
      reason: 'diff_too_large',
      detail: `PR has ≥${GITHUB_FILE_CAP} files (GitHub API cap)`,
    };
  }
  for (const f of files) {
    if (f.patch == null && f.status !== 'removed') {
      return {
        ok: false,
        reason: 'diff_too_large',
        detail: `file ${f.filename} has no patch (binary or too large)`,
      };
    }
  }
  // 4. Reconstruct unified diff.
  const diff = buildUnifiedDiff(files);
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions ?? 0;
    totalDeletions += f.deletions ?? 0;
  }
  return { ok: true, diff, files: files.length, totalAdditions, totalDeletions };
}

export function buildUnifiedDiff(files: readonly ComparePatchFile[]): string {
  const parts: string[] = [];
  for (const f of files) {
    const aPath = f.previous_filename ?? f.filename;
    parts.push(`diff --git a/${aPath} b/${f.filename}`);
    parts.push(`--- a/${aPath}`);
    parts.push(`+++ b/${f.filename}`);
    if (f.patch) parts.push(f.patch);
    parts.push('');
  }
  return parts.join('\n');
}
