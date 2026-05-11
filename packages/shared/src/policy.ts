// YAML config loaders for coordinator + worker. PLAN §3.2.
import { readFile } from 'node:fs/promises';
import { load as yamlLoad } from 'js-yaml';
import { z } from 'zod';

// ── Coordinator config ───────────────────────────────────────────────────────

const TaskTypeConfig = z.object({
  reviewers_needed: z.number().int().positive(),
  claim_window_ms: z.number().int().positive(),
  execution_timeout_ms: z.number().int().positive(),
  max_usd_per_reviewer: z.number().nonnegative(),
  allowed_repo_patterns: z.array(z.string()),
  max_retries_on_timeout: z.number().int().nonnegative().default(1),
});

export const CoordinatorConfig = z.object({
  swarm: z.object({
    channel: z.string().regex(/^#/, 'channel must start with #'),
    founder_did: z.string().startsWith('did:'),
    coordinator_nick: z.string().min(1).default('swarm'),
    freeq_server: z.string().default('irc.freeq.at:6697'),
    /** WebSocket URL override; if absent, derived as wss://<host>/irc */
    freeq_ws_url: z.string().optional(),
  }),
  operator_allowlist: z.array(z.string().startsWith('did:')).min(1),
  task_types: z.record(z.string(), TaskTypeConfig),
  budget: z.object({
    daily_usd_per_agent: z.number().nonnegative(),
  }),
  summary: z.object({
    default_tz: z.string().default('UTC'),
    // HH:MM with HH ∈ [00,23] and MM ∈ [00,59] — strict, not just digit-shape.
    default_time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('09:00'),
    per_requester_tz: z.record(z.string(), z.string()).default({}),
  }),
});
export type CoordinatorConfig = z.infer<typeof CoordinatorConfig>;

// ── Worker config ────────────────────────────────────────────────────────────

const WorkerCapabilities = z.object({
  task_types: z.array(z.string()).min(1),
  max_concurrent: z.number().int().positive(),
  languages: z.array(z.string()),
  max_diff_kloc: z.number().int().positive(),
});

const WorkerRuntimeModel = z.object({
  provider: z.string(),
  model: z.string(),
  via: z.enum(['api', 'cli', 'max-subscription']),
});

const WorkerConstraints = z.object({
  allowed_repo_patterns: z.array(z.string()),
  max_usd_per_task: z.number().nonnegative(),
  idle_only: z.boolean().default(true),
});

export const WorkerConfig = z.object({
  worker: z.object({
    nick_hint: z.string().min(1),
    swarm_channels: z.array(z.string().regex(/^#/)).min(1),
    freeq_server: z.string().default('irc.freeq.at:6697'),
    freeq_ws_url: z.string().optional(),
    /** owner did (did:plc:...) — required to mint delegation cert */
    owner_did: z.string().startsWith('did:'),
  }),
  capabilities: WorkerCapabilities,
  runtime: z.object({
    models: z.array(WorkerRuntimeModel).min(1),
  }),
  constraints: WorkerConstraints,
  governance: z
    .object({
      on_pause: z.enum(['complete_in_flight', 'abort_in_flight']).default('complete_in_flight'),
    })
    .default({ on_pause: 'complete_in_flight' }),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

// ── Loaders ──────────────────────────────────────────────────────────────────

export async function loadCoordinatorConfig(path: string): Promise<CoordinatorConfig> {
  const raw = await readFile(path, 'utf8');
  const parsed = yamlLoad(raw) as unknown;
  return CoordinatorConfig.parse(parsed);
}

export async function loadWorkerConfig(path: string): Promise<WorkerConfig> {
  const raw = await readFile(path, 'utf8');
  const parsed = yamlLoad(raw) as unknown;
  return WorkerConfig.parse(parsed);
}

// ── Repo pattern matching ────────────────────────────────────────────────────

/** Glob match for `github.com/owner/*` style patterns. Currently supports `*` only at the end. */
export function matchesRepoPattern(repo: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return repo.startsWith(prefix);
  }
  return repo === pattern;
}

export function matchesAnyRepoPattern(repo: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (matchesRepoPattern(repo, p)) return true;
  }
  return false;
}
