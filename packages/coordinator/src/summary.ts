// Morning summary generator + scheduler. PLAN §5.10.
//
// Per requester DID: at the configured local time (default 09:00 in
// summary.default_tz), build a summary of last-24h activity and send it
// as PRIVMSG to the requester's last-known nick.
import type { CoordinatorConfig, DidCache, OperatorAllowlist } from '@freeq-swarm/shared';
import type { CoordinatorDb, TaskRow } from './db.js';
import type { FreeqClient } from '@freeq/sdk';

export interface SummaryDeps {
  client: FreeqClient;
  db: CoordinatorDb;
  config: CoordinatorConfig;
  didCache: DidCache;
  operatorAllowlist: OperatorAllowlist;
  /** Test override for `now`. */
  now?: () => Date;
  /** Test override for setTimeout/clearTimeout. */
  scheduler?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export interface SummaryHandle {
  /** Build + send the summary for one requester immediately. */
  sendNow(requesterDid: string): Promise<void>;
  /** Cancel scheduler. */
  shutdown(): void;
}

export interface SummaryStats {
  total: number;
  approved: number;
  needsAttention: TaskRow[];
  totalUsd: number;
  contributorCounts: Map<string, number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildStats(tasks: readonly TaskRow[]): SummaryStats {
  let approved = 0;
  let totalUsd = 0;
  const contributorCounts = new Map<string, number>();
  const needsAttention: TaskRow[] = [];
  for (const t of tasks) {
    // Per-evidence reviewer attribution requires walking evidence rows;
    // we'll do that in the renderer where we have db access.
    if (t.state === 'failed') {
      needsAttention.push(t);
      continue;
    }
    if (t.consensus_verdict === 'approve') approved += 1;
    else if (t.consensus_verdict === 'approve_with_comments') approved += 1; // counted as "approved-ish"
    else if (
      t.consensus_verdict === 'request_changes' ||
      t.consensus_verdict === 'reject'
    )
      needsAttention.push(t);
  }
  return { total: tasks.length, approved, needsAttention, totalUsd, contributorCounts };
}

/**
 * Format the summary as a sequence of PRIVMSG body lines (excluding the
 * `PRIVMSG <nick> :` prefix).
 */
export function renderSummaryLines(args: {
  date: Date;
  stats: SummaryStats;
  channel: string;
  sinceUnix: number;
  topContributors: Array<[string, number]>;
}): string[] {
  const { date, stats, channel, sinceUnix, topContributors } = args;
  const dateStr = date.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`☀️ Swarm summary ${dateStr}`);
  lines.push(
    `  • ${stats.total} task${stats.total === 1 ? '' : 's'} completed (${stats.approved} approved)`,
  );
  if (stats.needsAttention.length > 0) {
    lines.push(`  • ${stats.needsAttention.length} need your attention:`);
    for (const t of stats.needsAttention.slice(0, 10)) {
      const tag =
        t.state === 'failed'
          ? `${t.failure_reason ?? 'failed'}`
          : `${t.consensus_verdict ?? 'unknown'}`;
      lines.push(`    - ${t.task_id.slice(0, 12)} : ${tag}`);
    }
  }
  lines.push(`  • Spend: $${stats.totalUsd.toFixed(2)} across ${stats.total} task-runs`);
  if (topContributors.length > 0) {
    const top = topContributors
      .slice(0, 3)
      .map(([d, n]) => `${d.slice(-8)} (${n})`)
      .join(', ');
    lines.push(`  • Top contributors: ${top}`);
  }
  const ch = channel.startsWith('#') ? channel.slice(1) : channel;
  lines.push(`  Audit: GET /api/v1/channels/${ch}/events?since=${sinceUnix}`);
  return lines;
}

/**
 * Compute the next fire time (in ms from `now`) for the configured local
 * time + tz. Fires today if still in the future; otherwise tomorrow.
 */
export function nextFireMs(args: {
  now: Date;
  hhmm: string; // "HH:MM"
  tz: string;
}): number {
  // Resolve the year/month/day in the target tz today.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: args.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(args.now);
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? '00';
  const todayStr = `${get('year')}-${get('month')}-${get('day')}T${args.hhmm}:00`;
  // Convert "today HH:MM in tz" to a UTC instant.
  const utcMsToday = tzWallToUtcMs(todayStr, args.tz);
  if (utcMsToday > args.now.getTime()) return utcMsToday - args.now.getTime();
  // Otherwise, tomorrow.
  const tomorrow = new Date(args.now.getTime() + DAY_MS);
  const tparts = fmt.formatToParts(tomorrow);
  const tget = (t: Intl.DateTimeFormatPartTypes): string =>
    tparts.find((p) => p.type === t)?.value ?? '00';
  const tomorrowStr = `${tget('year')}-${tget('month')}-${tget('day')}T${args.hhmm}:00`;
  return tzWallToUtcMs(tomorrowStr, args.tz) - args.now.getTime();
}

/**
 * Convert a "wall clock" date-time string (`YYYY-MM-DDTHH:MM:SS` interpreted
 * in `tz`) to a UTC milliseconds-since-epoch. Uses Intl to find the correct
 * UTC offset for that wall instant.
 */
function tzWallToUtcMs(wallStr: string, tz: string): number {
  // Parse the wall string components.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wallStr);
  if (!m) throw new Error(`bad wall string: ${wallStr}`);
  const [, y, mo, d, h, mi, s] = m;
  // Take a guess at the UTC offset. Build a UTC date with the same components,
  // then ask Intl what wall time that corresponds to in `tz`. The diff is the
  // offset.
  const guess = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
  );
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(guess));
  const get = (t: Intl.DateTimeFormatPartTypes): number => {
    const v = parts.find((p) => p.type === t)?.value ?? '0';
    return Number(v === '24' ? '00' : v);
  };
  const wallInTz = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  // Offset = wallInTz - guess. Subtract from guess to land at the actual UTC.
  return guess - (wallInTz - guess);
}

export function startSummaryScheduler(deps: SummaryDeps): SummaryHandle {
  const sched = deps.scheduler ?? { setTimeout, clearTimeout };
  const now = deps.now ?? (() => new Date());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const timeFor = (requesterDid: string): { tz: string; hhmm: string } => {
    const tz = deps.config.summary.per_requester_tz[requesterDid] ?? deps.config.summary.default_tz;
    return { tz, hhmm: deps.config.summary.default_time };
  };

  const armForRequester = (requesterDid: string): void => {
    const existing = timers.get(requesterDid);
    if (existing) sched.clearTimeout(existing);
    const { tz, hhmm } = timeFor(requesterDid);
    const ms = nextFireMs({ now: now(), tz, hhmm });
    const t = sched.setTimeout(() => {
      void sendNow(requesterDid).finally(() => armForRequester(requesterDid));
    }, ms);
    timers.set(requesterDid, t);
  };

  // Arm for each operator-allowlist DID by default.
  for (const entry of deps.operatorAllowlist.list()) {
    armForRequester(entry.did);
  }

  async function sendNow(requesterDid: string): Promise<void> {
    const sinceUnix = Math.floor(now().getTime() / 1000) - 24 * 60 * 60;
    const tasks = deps.db.recentTasksFor(requesterDid, sinceUnix);
    // Compute totalUsd + contributors from evidence rows.
    let totalUsd = 0;
    const contributorCounts = new Map<string, number>();
    for (const t of tasks) {
      const evidence = deps.db.evidenceFor(t.task_id);
      for (const e of evidence) {
        try {
          const p = JSON.parse(e.payload_json);
          totalUsd += Number(p?.usd_cost) || 0;
        } catch {
          /* skip */
        }
        contributorCounts.set(
          e.worker_did,
          (contributorCounts.get(e.worker_did) ?? 0) + 1,
        );
      }
    }
    const stats = buildStats(tasks);
    stats.totalUsd = totalUsd;
    stats.contributorCounts = contributorCounts;
    const topContributors = [...contributorCounts.entries()].sort((a, b) => b[1] - a[1]);
    const lines = renderSummaryLines({
      date: now(),
      stats,
      channel: deps.config.swarm.channel,
      sinceUnix,
      topContributors,
    });
    const nick = deps.didCache.nickForDid(requesterDid);
    if (!nick) {
      console.warn(`summary: no nick known for ${requesterDid} — skipping send`);
      return;
    }
    const safeNick = nick.replace(/[\r\n\0 ]/g, '');
    for (const line of lines) {
      try {
        deps.client.raw(`PRIVMSG ${safeNick} :${line.replace(/[\r\n\0]/g, ' ')}`);
      } catch {
        /* socket gone */
      }
    }
  }

  function shutdown(): void {
    for (const t of timers.values()) sched.clearTimeout(t);
    timers.clear();
  }

  return { sendNow, shutdown };
}
