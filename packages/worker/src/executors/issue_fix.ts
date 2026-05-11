// issue_fix executor: clone repo, run Claude in agentic mode against the
// issue, commit, push to a fork, open a cross-fork PR.
//
// This is the "software factory" mode. Workers produce code, not reviews.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { Submission, TestOutcome } from '@freeq-swarm/shared';

export interface IssueFixInput {
  taskId: string;
  workerDid: string;
  /** github owner/repo (no 'github.com/' prefix) */
  repo: string;
  issue: number;
  baseBranch: string;
  title: string;
  body: string;
  testCommand: string | null;
  maxTurns: number;
  model: string;
  via: 'api' | 'cli' | 'max-subscription';
  /** Override the `claude` binary (tests). */
  claudeBin?: string;
  /** Override the `gh` binary (tests). */
  ghBin?: string;
  /** Override the `git` binary (tests). */
  gitBin?: string;
  /** Optional override for the system prompt (tests). */
  systemPromptOverride?: string;
  /** Test seam: a function that performs the agentic "fix" step in place of
   *  `claude -p`. The seam returns the cost + token usage; we capture the
   *  resulting `git status` ourselves to verify changes. */
  agenticRun?: (cwd: string, prompt: string, ctx: AgenticCtx) => Promise<AgenticResult>;
  /** Per-task hard cap (USD). */
  maxUsdPerTask: number;
  /** Log output to this stream (default process.stdout). */
  log?: (line: string) => void;
}

export interface AgenticCtx {
  maxTurns: number;
  model: string;
  systemPrompt: string;
}

export interface AgenticResult {
  tokens_used: number;
  usd_cost: number;
}

const VALID_TOKEN_PATTERNS = /^[\w./@:+-]+$/;

function defaultLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: readonly string[], cwd?: string, timeoutMs = 60_000): Promise<CmdResult> {
  return new Promise<CmdResult>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      timer = null;
      reject(new Error(`${bin} ${args.join(' ')} timeout`));
    }, timeoutMs);
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

async function loadSystemPrompt(override?: string): Promise<string> {
  if (override !== undefined) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(join(here, 'issue_fix.prompt.md'), 'utf8');
}

/** Real `claude -p` invocation. Used as the default agenticRun. */
const defaultAgenticRun = async (
  cwd: string,
  prompt: string,
  ctx: AgenticCtx,
): Promise<AgenticResult> => {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--max-turns',
    String(ctx.maxTurns),
    '--model',
    ctx.model,
    '--allowedTools',
    'Read,Edit,Write,Bash,Grep,Glob',
    '--append-system-prompt',
    ctx.systemPrompt,
  ];
  const res = await run('claude', args, cwd, 30 * 60_000);
  if (res.code !== 0) {
    throw new Error(`claude exited ${res.code}: ${res.stderr.slice(0, 500)}`);
  }
  // claude --output-format json returns a JSON object with usage info.
  try {
    const parsed = JSON.parse(res.stdout);
    return {
      tokens_used: Number(parsed?.total_tokens ?? parsed?.usage?.total_tokens ?? 0),
      usd_cost: Number(parsed?.total_cost_usd ?? parsed?.cost_usd ?? 0),
    };
  } catch {
    return { tokens_used: 0, usd_cost: 0 };
  }
};

/** Run the full issue_fix pipeline. Returns the Submission evidence. */
export async function runIssueFix(input: IssueFixInput): Promise<Submission> {
  const log = input.log ?? defaultLog;
  const gh = input.ghBin ?? 'gh';
  const git = input.gitBin ?? 'git';
  const claudeBin = input.claudeBin ?? 'claude';
  void claudeBin; // for test parity; the default agenticRun shells out itself
  const sysPrompt = await loadSystemPrompt(input.systemPromptOverride);

  // ── 1. Refuse if any input has shell-meta we don't trust ──
  if (!safeSegment(input.repo) || !safeSegment(input.baseBranch)) {
    return failed(input, 'gave_up', 'refusing to run: unsafe characters in repo or branch');
  }

  // ── 2. Make a workspace ──
  const workspace = await mkdtemp(join(tmpdir(), `freeq-swarm-fix-${input.taskId.slice(0, 8)}-`));
  try {
    // ── 3. Clone via gh (which handles auth) ──
    log(`cloning ${input.repo} into ${workspace}`);
    const clone = await run(gh, ['repo', 'clone', input.repo, workspace, '--', '--depth=100'], undefined, 5 * 60_000);
    if (clone.code !== 0) {
      return failed(input, 'gave_up', `clone failed: ${clone.stderr.slice(0, 400)}`);
    }

    // ── 4. Make sure base branch is checked out, derive new branch name ──
    const checkout = await run(git, ['checkout', input.baseBranch], workspace);
    if (checkout.code !== 0) {
      // try origin/<base>
      const fallback = await run(git, ['checkout', '-B', input.baseBranch, `origin/${input.baseBranch}`], workspace);
      if (fallback.code !== 0) {
        return failed(input, 'gave_up', `cannot check out ${input.baseBranch}`);
      }
    }
    const branchName = `freeq-swarm/fix-${input.taskId.slice(0, 12).toLowerCase()}`;
    await run(git, ['checkout', '-b', branchName], workspace);

    // ── 5. Run the agentic step ──
    const userPrompt = buildUserPrompt(input);
    const agenticRun = input.agenticRun ?? defaultAgenticRun;
    log(`running claude (model=${input.model}, max_turns=${input.maxTurns})`);
    let agentic: AgenticResult;
    try {
      agentic = await agenticRun(workspace, userPrompt, {
        maxTurns: input.maxTurns,
        model: input.model,
        systemPrompt: sysPrompt,
      });
    } catch (e) {
      return failed(input, 'gave_up', `agentic step crashed: ${String(e).slice(0, 400)}`);
    }
    // Cost guard.
    if (agentic.usd_cost > input.maxUsdPerTask * 1.25) {
      return failed(input, 'gave_up', `cost overrun: $${agentic.usd_cost.toFixed(2)} > cap $${input.maxUsdPerTask}`);
    }

    // ── 6. Verify there ARE changes ──
    const diffStat = await run(git, ['diff', '--stat', input.baseBranch, '--', ':!.gitignore'], workspace);
    const wcDiff = diffStat.stdout.trim();
    if (!wcDiff) {
      return failed(input, 'failed_to_change', 'claude produced no diff against the base branch');
    }
    // Extract files / additions / deletions from the trailing summary.
    const { files, additions, deletions } = parseDiffStat(wcDiff);

    // ── 7. Run the test command if provided ──
    let testOutcome: TestOutcome = 'skipped';
    let testLogTail: string | null = null;
    if (input.testCommand) {
      log(`running test command: ${input.testCommand}`);
      const testRes = await run('sh', ['-c', input.testCommand], workspace, 20 * 60_000);
      testLogTail = (testRes.stdout + '\n' + testRes.stderr).slice(-2000);
      testOutcome = testRes.code === 0 ? 'passed' : 'failed';
      if (testOutcome === 'failed') {
        // We still submit the PR — humans can decide — but the verdict reflects it.
      }
    }

    // ── 8. Commit ──
    await run(git, ['add', '-A'], workspace);
    const commitMsg = `Fix #${input.issue}: ${input.title.slice(0, 60)}\n\nResolves #${input.issue}.\n\nGenerated by freeq-swarm worker ${input.workerDid}.`;
    const commitMsgPath = join(workspace, '.freeq-swarm-commit-msg');
    await writeFile(commitMsgPath, commitMsg);
    const commit = await run(git, ['commit', '-F', commitMsgPath], workspace);
    if (commit.code !== 0) {
      return failed(input, 'failed_to_change', `git commit failed: ${commit.stderr.slice(0, 400)}`);
    }

    // ── 9. Fork the upstream and push ──
    // gh repo fork --clone=false --remote ensures we get an `origin` pointing
    // at the user's fork. If a fork already exists, gh just adopts it.
    const fork = await run(gh, ['repo', 'fork', input.repo, '--remote=false', '--clone=false'], workspace);
    if (fork.code !== 0) {
      log(`note: fork step exited ${fork.code} — ${fork.stderr.slice(0, 200)}`);
      // Fall through — fork may already exist.
    }

    // The clone has `origin = upstream`. We need to push to the fork. gh stores
    // the fork URL in its config; we can resolve owner via `gh api user`.
    const me = await run(gh, ['api', 'user', '--jq', '.login'], workspace);
    if (me.code !== 0) {
      return failed(input, 'gave_up', `cannot resolve gh user: ${me.stderr.slice(0, 200)}`);
    }
    const ghUser = me.stdout.trim();
    const upstreamRepo = input.repo;
    const forkRepo = `${ghUser}/${upstreamRepo.split('/')[1]}`;
    // Push to the fork (auth handled by gh's credential helper).
    const pushUrl = `https://github.com/${forkRepo}.git`;
    const push = await run(git, ['push', pushUrl, `HEAD:${branchName}`, '--force-with-lease'], workspace, 5 * 60_000);
    if (push.code !== 0) {
      return failed(input, 'gave_up', `push failed: ${push.stderr.slice(0, 400)}`);
    }

    // ── 10. Open the PR ──
    const prTitle = `Fix #${input.issue}: ${input.title.slice(0, 80)}`;
    const prBody =
      `Closes #${input.issue}.\n\n` +
      `_Generated by [freeq-swarm](https://github.com/chad/freeq-swarm) worker_\n` +
      `_Operator DID: ${input.workerDid}_\n` +
      `_Task: ${input.taskId}_\n\n` +
      (testOutcome !== 'skipped'
        ? `**Tests:** \`${input.testCommand}\` → \`${testOutcome}\`\n`
        : '');
    const prRes = await run(
      gh,
      [
        'pr',
        'create',
        '--repo',
        upstreamRepo,
        '--base',
        input.baseBranch,
        '--head',
        `${ghUser}:${branchName}`,
        '--title',
        prTitle,
        '--body',
        prBody,
      ],
      workspace,
      2 * 60_000,
    );
    if (prRes.code !== 0) {
      return failed(input, 'gave_up', `gh pr create failed: ${prRes.stderr.slice(0, 400)}`);
    }
    const prUrl = (prRes.stdout.match(/https?:\/\/\S+/) ?? [''])[0] || `https://github.com/${upstreamRepo}/pulls`;

    return {
      kind: 'swarm.submission/v1',
      evidence_type: 'code_submission',
      task_id: input.taskId,
      worker_did: input.workerDid,
      verdict: testOutcome === 'failed' ? 'failed_tests' : 'submitted',
      pr_url: prUrl,
      branch_name: branchName,
      summary: input.title.slice(0, 600),
      files_changed: files,
      additions,
      deletions,
      test_command: input.testCommand,
      test_outcome: testOutcome,
      test_log_tail: testLogTail,
      tokens_used: agentic.tokens_used,
      usd_cost: agentic.usd_cost,
      model: input.model,
      via: input.via,
    };
  } finally {
    // Best-effort cleanup. Workspace can be GBs after a clone+npm-install.
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function failed(input: IssueFixInput, verdict: 'failed_to_change' | 'gave_up' | 'failed_tests', detail: string): Submission {
  return {
    kind: 'swarm.submission/v1',
    evidence_type: 'code_submission',
    task_id: input.taskId,
    worker_did: input.workerDid,
    verdict,
    pr_url: null,
    branch_name: null,
    summary: detail,
    files_changed: 0,
    additions: 0,
    deletions: 0,
    test_command: input.testCommand,
    test_outcome: 'skipped',
    test_log_tail: null,
    tokens_used: 0,
    usd_cost: 0,
    model: input.model,
    via: input.via,
  };
}

export function buildUserPrompt(input: Pick<IssueFixInput, 'title' | 'body' | 'issue' | 'repo'>): string {
  return [
    `Issue: ${input.repo} #${input.issue}`,
    `Title: ${input.title}`,
    '',
    'Body:',
    input.body,
  ].join('\n');
}

export function parseDiffStat(stat: string): { files: number; additions: number; deletions: number } {
  // Last line looks like " 3 files changed, 42 insertions(+), 5 deletions(-)"
  const last = stat.trim().split('\n').pop() ?? '';
  const filesM = /(\d+) files? changed/.exec(last);
  const addsM = /(\d+) insertions?\(\+\)/.exec(last);
  const delsM = /(\d+) deletions?\(-\)/.exec(last);
  return {
    files: filesM ? Number.parseInt(filesM[1]!, 10) : 0,
    additions: addsM ? Number.parseInt(addsM[1]!, 10) : 0,
    deletions: delsM ? Number.parseInt(delsM[1]!, 10) : 0,
  };
}

function safeSegment(s: string): boolean {
  return VALID_TOKEN_PATTERNS.test(s);
}
