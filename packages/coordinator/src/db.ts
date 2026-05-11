// SQLite schema for swarm-coordinator. PLAN §3.1 + §7 repo layout.
//
// All writes are synchronous (better-sqlite3); recovery and dispatch never race
// because boot order serializes them (PLAN §3.1).
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

export type TaskState =
  | 'pending_claims'
  | 'assigned'
  | 'verifying'
  | 'complete'
  | 'failed';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  task_type TEXT NOT NULL,
  requester_did TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  assigned_at INTEGER,
  completed_at INTEGER,
  consensus_verdict TEXT,
  consensus_severity TEXT,
  agreement_score REAL,
  failure_reason TEXT,
  failure_detail TEXT,
  retries_remaining INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS tasks_state_idx ON tasks(state);
CREATE INDEX IF NOT EXISTS tasks_requester_idx ON tasks(requester_did, completed_at);

CREATE TABLE IF NOT EXISTS claims (
  task_id TEXT NOT NULL,
  worker_did TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, worker_did),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS claims_task_idx ON claims(task_id);

CREATE TABLE IF NOT EXISTS assignments (
  task_id TEXT NOT NULL,
  worker_did TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, worker_did),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS assignments_worker_idx ON assignments(worker_did);

CREATE TABLE IF NOT EXISTS evidence (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  worker_did TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS evidence_task_idx ON evidence(task_id);

CREATE TABLE IF NOT EXISTS capabilities (
  worker_did TEXT PRIMARY KEY,
  operator_did TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers_state (
  worker_did TEXT PRIMARY KEY,
  reputation INTEGER NOT NULL DEFAULT 0,
  last_governance TEXT,
  last_governance_at INTEGER,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS did_to_nick (
  did TEXT PRIMARY KEY,
  nick TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS did_to_nick_nick_idx ON did_to_nick(nick);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

export interface TaskRow {
  task_id: string;
  state: TaskState;
  task_type: string;
  requester_did: string;
  payload_json: string;
  created_at: number;
  assigned_at: number | null;
  completed_at: number | null;
  consensus_verdict: string | null;
  consensus_severity: string | null;
  agreement_score: number | null;
  failure_reason: string | null;
  failure_detail: string | null;
  retries_remaining: number;
}

export interface CapabilityRow {
  worker_did: string;
  operator_did: string;
  payload_json: string;
  updated_at: number;
}

export interface EvidenceRow {
  event_id: string;
  task_id: string;
  worker_did: string;
  payload_json: string;
  received_at: number;
}

export class CoordinatorDb {
  readonly db: DB;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── Meta ──
  setMeta(k: string, v: string): void {
    this.db
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, v);
  }
  getMeta(k: string): string | null {
    const row = this.db.prepare<[string], { v: string }>('SELECT v FROM meta WHERE k = ?').get(k);
    return row?.v ?? null;
  }
  get lastSeenEventTs(): number {
    const v = this.getMeta('last_seen_event_ts');
    return v ? Number(v) : 0;
  }
  set lastSeenEventTs(ts: number) {
    this.setMeta('last_seen_event_ts', String(ts));
  }

  // ── Tasks ──
  insertTask(r: Omit<TaskRow, 'assigned_at' | 'completed_at' | 'consensus_verdict' | 'consensus_severity' | 'agreement_score' | 'failure_reason' | 'failure_detail'>): void {
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, state, task_type, requester_did, payload_json, created_at, retries_remaining)
         VALUES (@task_id, @state, @task_type, @requester_did, @payload_json, @created_at, @retries_remaining)`,
      )
      .run(r);
  }
  getTask(taskId: string): TaskRow | null {
    return (
      this.db.prepare<[string], TaskRow>('SELECT * FROM tasks WHERE task_id = ?').get(taskId) ??
      null
    );
  }
  setTaskState(taskId: string, state: TaskState): void {
    this.db.prepare('UPDATE tasks SET state = ? WHERE task_id = ?').run(state, taskId);
  }
  setTaskAssigned(taskId: string, assignedAt: number): void {
    this.db
      .prepare('UPDATE tasks SET state = ?, assigned_at = ? WHERE task_id = ?')
      .run('assigned', assignedAt, taskId);
  }
  setTaskComplete(args: {
    task_id: string;
    consensus_verdict: string;
    consensus_severity: string;
    agreement_score: number;
    completed_at: number;
  }): void {
    this.db
      .prepare(
        `UPDATE tasks SET state='complete', consensus_verdict=@consensus_verdict,
         consensus_severity=@consensus_severity, agreement_score=@agreement_score,
         completed_at=@completed_at WHERE task_id=@task_id`,
      )
      .run(args);
  }
  setTaskFailed(args: {
    task_id: string;
    reason: string;
    detail: string | null;
    completed_at: number;
  }): void {
    this.db
      .prepare(
        `UPDATE tasks SET state='failed', failure_reason=@reason, failure_detail=@detail,
         completed_at=@completed_at WHERE task_id=@task_id`,
      )
      .run(args);
  }
  decrementRetries(taskId: string): void {
    this.db
      .prepare(
        'UPDATE tasks SET retries_remaining = MAX(retries_remaining - 1, 0) WHERE task_id = ?',
      )
      .run(taskId);
  }
  /** All tasks not in a terminal state. Used by recovery. */
  inFlightTasks(): TaskRow[] {
    return this.db
      .prepare<[], TaskRow>("SELECT * FROM tasks WHERE state NOT IN ('complete','failed')")
      .all();
  }
  /** Tasks completed in last N seconds for a given requester. Used by morning summary. */
  recentTasksFor(requesterDid: string, sinceUnix: number): TaskRow[] {
    return this.db
      .prepare<[string, number], TaskRow>(
        'SELECT * FROM tasks WHERE requester_did = ? AND completed_at >= ? ORDER BY completed_at',
      )
      .all(requesterDid, sinceUnix);
  }

  // ── Claims ──
  recordClaim(taskId: string, workerDid: string, ts: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO claims (task_id, worker_did, claimed_at) VALUES (?, ?, ?)',
      )
      .run(taskId, workerDid, ts);
  }
  claimsFor(taskId: string): Array<{ worker_did: string; claimed_at: number }> {
    return this.db
      .prepare<[string], { worker_did: string; claimed_at: number }>(
        'SELECT worker_did, claimed_at FROM claims WHERE task_id = ? ORDER BY claimed_at',
      )
      .all(taskId);
  }

  // ── Assignments ──
  recordAssignment(taskId: string, workerDid: string, ts: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO assignments (task_id, worker_did, assigned_at) VALUES (?, ?, ?)',
      )
      .run(taskId, workerDid, ts);
  }
  assignmentsFor(taskId: string): string[] {
    return this.db
      .prepare<[string], { worker_did: string }>(
        'SELECT worker_did FROM assignments WHERE task_id = ?',
      )
      .all(taskId)
      .map((r) => r.worker_did);
  }
  /** Open assignments (no matching evidence yet, task not in terminal state) per worker. */
  openAssignmentsByWorker(): Map<string, number> {
    const rows = this.db
      .prepare<[], { worker_did: string; n: number }>(
        `SELECT a.worker_did, COUNT(*) AS n
         FROM assignments a
         JOIN tasks t ON t.task_id = a.task_id
         WHERE t.state NOT IN ('complete','failed')
           AND NOT EXISTS (SELECT 1 FROM evidence e
                            WHERE e.task_id = a.task_id AND e.worker_did = a.worker_did)
         GROUP BY a.worker_did`,
      )
      .all();
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.worker_did, r.n);
    return m;
  }

  // ── Evidence ──
  insertEvidence(r: EvidenceRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO evidence (event_id, task_id, worker_did, payload_json, received_at)
         VALUES (@event_id, @task_id, @worker_did, @payload_json, @received_at)`,
      )
      .run(r);
  }
  evidenceFor(taskId: string): EvidenceRow[] {
    return this.db
      .prepare<[string], EvidenceRow>(
        'SELECT * FROM evidence WHERE task_id = ? ORDER BY received_at',
      )
      .all(taskId);
  }

  // ── Capabilities ──
  upsertCapability(r: CapabilityRow): void {
    this.db
      .prepare(
        `INSERT INTO capabilities (worker_did, operator_did, payload_json, updated_at)
         VALUES (@worker_did, @operator_did, @payload_json, @updated_at)
         ON CONFLICT(worker_did) DO UPDATE SET
           operator_did = excluded.operator_did,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(r);
  }
  capabilityFor(workerDid: string): CapabilityRow | null {
    return (
      this.db
        .prepare<[string], CapabilityRow>('SELECT * FROM capabilities WHERE worker_did = ?')
        .get(workerDid) ?? null
    );
  }
  allCapabilities(): CapabilityRow[] {
    return this.db.prepare<[], CapabilityRow>('SELECT * FROM capabilities').all();
  }

  // ── Workers state ──
  bumpReputation(workerDid: string, delta: number): void {
    this.db
      .prepare(
        `INSERT INTO workers_state (worker_did, reputation) VALUES (?, ?)
         ON CONFLICT(worker_did) DO UPDATE SET reputation = reputation + excluded.reputation`,
      )
      .run(workerDid, delta);
  }
  setWorkerGovernance(workerDid: string, signal: string | null, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO workers_state (worker_did, last_governance, last_governance_at)
         VALUES (?, ?, ?)
         ON CONFLICT(worker_did) DO UPDATE SET
           last_governance = excluded.last_governance,
           last_governance_at = excluded.last_governance_at`,
      )
      .run(workerDid, signal, ts);
  }
  workerState(workerDid: string): {
    worker_did: string;
    reputation: number;
    last_governance: string | null;
    last_governance_at: number | null;
    last_seen_at: number | null;
  } | null {
    return (
      this.db
        .prepare(
          'SELECT worker_did, reputation, last_governance, last_governance_at, last_seen_at FROM workers_state WHERE worker_did = ?',
        )
        .get(workerDid) as any
    ) ?? null;
  }

  // ── DID ↔ nick cache (durable across restarts) ──
  saveDidNick(did: string, nick: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO did_to_nick (did, nick, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(did) DO UPDATE SET nick = excluded.nick, updated_at = excluded.updated_at`,
      )
      .run(did, nick, ts);
  }
  loadDidNickPairs(): Array<{ did: string; nick: string }> {
    return this.db.prepare<[], { did: string; nick: string }>('SELECT did, nick FROM did_to_nick').all();
  }
}
