// Standard config + bot-cert paths. We follow freeq-bot-id's `~/.freeq/bots/<name>/`
// for delegation cert + key (PLAN §4.2 / F-7), and use a separate
// `~/.freeq-swarm/` tree for swarm-specific runtime state (sqlite, config).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export interface SwarmPaths {
  /** Top of the swarm runtime data dir, e.g. ~/.freeq-swarm/ */
  base: string;
  /** Per-role subdir, e.g. ~/.freeq-swarm/coordinator/ */
  roleDir: string;
  /** Coordinator SQLite file. */
  db: string;
  /** YAML config file. */
  config: string;
  /** Bot identity key (ed25519 seed) — owned by freeq-bot-id. */
  agentKey: string;
  /** Delegation cert JSON — owned by freeq-bot-id. */
  delegation: string;
}

export type Role = 'coordinator' | 'worker';

export function paths(role: Role, name?: string): SwarmPaths {
  const base = process.env.FREEQ_SWARM_HOME ?? join(homedir(), '.freeq-swarm');
  const roleDir = join(base, role);
  const botDir = join(homedir(), '.freeq', 'bots', name ?? `swarm-${role}`);
  return {
    base,
    roleDir,
    db: join(roleDir, `${role}.sqlite`),
    config: join(roleDir, `${role}.yaml`),
    agentKey: join(botDir, 'key.ed25519'),
    delegation: join(botDir, 'delegation.json'),
  };
}

export async function ensurePathsDir(p: SwarmPaths): Promise<void> {
  await mkdir(p.roleDir, { recursive: true, mode: 0o700 });
}
