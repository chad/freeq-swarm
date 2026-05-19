// Channel-driven discovery flow for prospective workers.
//
//   $ swarm-worker discover --channel #freeq-dev --owner did:plc:me
//
// Connects to the freeq server with an ephemeral did:key, joins the channel,
// reads the channel topic to find the coordinator nick (or accepts --coord),
// DMs the coordinator `whoareyou`, parses the swarm.discovery/v1 reply, and
// prints a proposed worker.yaml. With --yes the proposed config is written
// straight to ~/.freeq-swarm/worker/worker.yaml; otherwise it's printed for
// the user to review and write themselves.
import { writeFile } from 'node:fs/promises';
import { FreeqClient } from '@freeq/sdk';
import {
  ensurePathsDir,
  generateDidKey,
  parseDiscoveryResponse,
  paths,
  type SwarmDiscovery,
} from '@freeq-swarm/shared';

// Lightweight YAML emitter — we only need to dump the proposed config and
// would rather not pull in js-yaml as a worker-package dep.
function yamlDump(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') {
    return /^[\w@./:#-]+$/.test(obj) ? obj : JSON.stringify(obj);
  }
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj
      .map((v) => {
        if (typeof v === 'object' && v !== null) {
          const inner = yamlDump(v, indent + 1).split('\n');
          return `${pad}- ${inner[0]!.trimStart()}\n${inner.slice(1).join('\n')}`;
        }
        return `${pad}- ${yamlDump(v, indent + 1)}`;
      })
      .join('\n');
  }
  if (typeof obj === 'object') {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        lines.push(`${pad}${k}:`);
        lines.push(yamlDump(v, indent + 1));
      } else if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
        lines.push(`${pad}${k}:`);
        lines.push(yamlDump(v, indent + 1));
      } else {
        lines.push(`${pad}${k}: ${yamlDump(v, indent + 1)}`);
      }
    }
    return lines.join('\n');
  }
  return String(obj);
}

export interface DiscoverOptions {
  channel: string;
  ownerDid: string;
  /** Coordinator nick — defaults to "swarm". Override if the channel uses a different nick. */
  coordinatorNick?: string;
  /** WebSocket override (default `wss://<host>/irc`). */
  url?: string;
  /** `host:port`. Default `irc.freeq.at:6697`. */
  server?: string;
  /** If true, write the proposed config to disk after printing. */
  writeConfig?: boolean;
  /** Stream for output (default process.stdout). */
  out?: NodeJS.WritableStream;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Run the discover flow. Returns the parsed SwarmDiscovery payload. */
export async function discover(opts: DiscoverOptions): Promise<SwarmDiscovery> {
  const out = opts.out ?? process.stdout;
  const coordNick = opts.coordinatorNick ?? 'swarm';
  // Ephemeral did:key — no persistence, no cert. Discovery is read-only,
  // so we skip bot-kit's FreeqBot (which mints/persists agent.key +
  // delegation.json) and drive a bare FreeqClient with SASL directly.
  const didKey = await generateDidKey();
  const host = (opts.server ?? 'irc.freeq.at:6697').split(':')[0];
  const url = opts.url ?? `wss://${host}/irc`;
  const nick = `discover-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
  const client = new FreeqClient({
    url,
    nick,
    sasl: { did: didKey.did, method: 'crypto', signer: didKey.signer, token: '', pdsUrl: '' },
    autoMsgSig: false,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ready (30s)`)), 30_000);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('authError', (msg) => {
      clearTimeout(timer);
      reject(new Error(`SASL auth failed: ${msg}`));
    });
    client.connect();
  });
  const conn = { client, disconnect: () => client.disconnect() };

  // Ask the coordinator. We listen on `raw` for the response.
  const payload = await new Promise<SwarmDiscovery>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`discovery timed out after ${DEFAULT_TIMEOUT_MS}ms — is "${coordNick}" online in ${opts.channel}?`));
    }, DEFAULT_TIMEOUT_MS);
    const onRaw = (line: string): void => {
      const got = parseDiscoveryResponse(line);
      if (!got) return;
      cleanup();
      resolve(got);
    };
    function cleanup(): void {
      clearTimeout(timer);
      conn.client.off('raw', onRaw);
    }
    conn.client.on('raw', onRaw);
    // JOIN then DM coordinator.
    conn.client.raw(`JOIN ${opts.channel}`);
    conn.client.raw(`PRIVMSG ${coordNick} :whoareyou`);
  });

  conn.disconnect();

  // Render the proposed worker.yaml.
  const yaml = `${yamlDump(buildProposedConfig(payload, opts.ownerDid))}\n`;

  out.write(`\n┌─ Discovered swarm: ${payload.swarm_name} ─────────────────────────────\n`);
  out.write(`│  Channel:      ${payload.channel}\n`);
  out.write(`│  Founder:      ${payload.founder_did}\n`);
  out.write(`│  Coordinator:  ${payload.coordinator_did} (nick: ${payload.coordinator_nick})\n`);
  out.write(`│  Task types:   ${payload.task_types.join(', ')}\n`);
  out.write(`│  Repos:        ${payload.policy.allowed_repo_patterns.join(', ')}\n`);
  out.write(`│  Per-task cap: $${payload.policy.max_usd_per_task}\n`);
  out.write(`│  Daily cap:    $${payload.policy.daily_usd_per_agent}/day per worker\n`);
  if (payload.description) out.write(`│  About:        ${payload.description}\n`);
  out.write(`└────────────────────────────────────────────────────────────────────\n\n`);

  // Allowlist gate: warn if the user's owner DID isn't in the hint list.
  if (!payload.operator_allowlist_hint.includes(opts.ownerDid)) {
    out.write(`⚠  Your owner DID (${opts.ownerDid}) is NOT in the founder's allowlist.\n`);
    out.write(`   Ask ${payload.founder_did} to add you before launching, or your\n`);
    out.write(`   capability ad will be ignored by the coordinator.\n\n`);
  } else {
    out.write(`✓  Your owner DID is in the allowlist — you're cleared to launch.\n\n`);
  }

  out.write(`Proposed ~/.freeq-swarm/worker/worker.yaml:\n\n`);
  out.write(yaml);
  out.write('\n');

  if (opts.writeConfig) {
    const p = paths('worker');
    await ensurePathsDir(p);
    await writeFile(p.config, yaml, { mode: 0o600 });
    out.write(`\n✓ Wrote ${p.config}\n`);
    out.write(`Next: export ANTHROPIC_API_KEY=... && swarm-worker launch\n`);
  } else {
    out.write(`\n(re-run with --yes to write this config to disk)\n`);
  }
  return payload;
}

/** Build a worker.yaml shape from a discovery payload + owner DID. */
export function buildProposedConfig(payload: SwarmDiscovery, ownerDid: string): unknown {
  const recommended = payload.recommended;
  return {
    worker: {
      nick_hint: process.env.HOSTNAME || `worker-${Math.floor(Math.random() * 9000) + 1000}`,
      swarm_channels: [payload.channel],
      freeq_server: 'irc.freeq.at:6697',
      owner_did: ownerDid,
    },
    capabilities: {
      task_types: payload.task_types,
      max_concurrent: recommended.max_concurrent ?? 1,
      languages: recommended.languages ?? ['typescript', 'rust', 'python'],
      max_diff_kloc: recommended.max_diff_kloc ?? 10,
    },
    runtime: {
      models: [
        {
          provider: 'anthropic',
          model: recommended.model ?? 'claude-opus-4-7',
          via: recommended.via ?? 'api',
        },
      ],
    },
    constraints: {
      allowed_repo_patterns: payload.policy.allowed_repo_patterns,
      max_usd_per_task: payload.policy.max_usd_per_task,
      idle_only: true,
    },
    governance: { on_pause: 'complete_in_flight' },
  };
}
