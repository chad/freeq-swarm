# Collaborative Compute on Freeq — Implementation Plan

> Working name in code: **freeq-swarm**.
> Source doc: chad's *Freeq Collaborative Compute Network v0.1* (May 2026).
> Status: revision 4 — final, post-3-reviews, implementation begins.

---

## 1. Goal

Build the smallest end-to-end demonstration of the Collaborative Compute Network the design doc describes, layered on freeq's existing primitives, runnable in a trusted channel by a small group of collaborators.

### 1.1 Demoable success criterion (the north star)

Three users on `irc.freeq.at` join `#swarm`. Each has a `freeq-swarm-worker` daemon on their laptop. One user types:

```
@swarm review https://github.com/foo/bar/pull/42
```

The swarm coordinator (a separate daemon, also in the channel) parses the request, resolves the PR's head SHA, posts a `task_request` event with the PR refs, and tracks which workers are idle. Two idle workers post `task_accept` events; the coordinator picks both and announces assignment. They each fetch the diff (pinned to head SHA), run a structured review using their local Claude (CLI or API), post `evidence_attach` events with reviews. The coordinator runs a consensus check (do the verdicts agree?), posts `task_complete` with the consensus verdict, and DMs the originating user a morning summary the next day.

One channel, one task type, two-of-N workers, consensus verification, summary. Everything else is v2+.

### 1.2 Non-goals (v1)

- Public marketplace / Tier 4 trust. v1 is Tier 2 only — operator-DID allowlist on the coordinator.
- Payments, credits, reciprocal-contribution accounting.
- Anonymous or sybil-resistant participation.
- Multi-channel federation of swarms.
- More than one task type. PR review is the chosen primitive.
- Heterogeneous nodes — local MLX, browser WASM, OpenAI/Gemini wrappers. v1 ships with Anthropic only.
- Bypassing or "cleverly using" any subscription provider's TOS.
- Bot-to-bot delegation chains. v1 is flat.
- Wallets, autonomous payments, autonomous legal authority.
- **Deterministic test execution as a verification mode.** v1 verifies via consensus only.
- **Cryptographically-verified delegation certs.** v1 ships unsigned certs (declarative); trust = operator-DID allowlist.
- **Coordinator-hosted HTTP blob server.** Cut. Reviews ride inline (≤3 KB; truncate `comments[]` if larger). Audit via existing `/api/v1/channels/{c}/events`.
- **`+freeq.at/sig` on TAGMSG.** Cut. Server doesn't verify; SDK doesn't auto-sign. Server-side fallback signing on the companion PRIVMSG provides DID-attested attestation.
- **Per-session MSGSIG registration.** Set `autoMsgSig: false` on the SDK. Server-side fallback signing covers attestation without us needing a registered session key (see §6).

---

## 2. What freeq already gives us (don't reinvent)

Verified against `/Users/chad/src/freeq` as of 2026-05-10 with editorial reviews #1–#3 input. Re-verify before each phase begins — that repo is active.

| Need | Freeq primitive | Verified at |
|---|---|---|
| Worker / coordinator identity | `did:key` ed25519 SASL via `ATPROTO-CHALLENGE` | freeqcc reference impl |
| Owner-bound agent identity | `FreeqBotDelegation/v1` cert (declarative, unsigned in v1) | `freeq-bot-id/src/main.rs:68-87` |
| Cert storage (canonical paths) | `~/.freeq/bots/<name>/{delegation.json,key.ed25519}` | `freeq-bot-id/src/main.rs:100-106` |
| Declaring an agent's origin | `AGENT REGISTER :class=agent` + `PROVENANCE :<JSON>` | `freeq-server/src/connection/mod.rs:2208-2300` |
| PRIVMSG attestation | Server-side fallback signing on PRIVMSG when sender is authenticated (no MSGSIG required) | `freeq-server/src/connection/messaging.rs:18-58` |
| Coordination events on the wire | **TAGMSG only** persists events; `+freeq.at/event=<type>` + percent-encoded JSON | `freeq-server/src/connection/messaging.rs:60-205` |
| **Web-client card rendering uses PRIVMSG, not TAGMSG.** Companion PRIVMSG must carry the full coordination-event tag set so cards render. | TAGMSG path doesn't emit `'message'` events to the SDK | `freeq-app/src/components/CoordinationCards.tsx:25-31, 130-156, 183`; `freeq-sdk-js/src/client.ts:881-920` |
| Stable event id | `msgid` IRCv3 tag stored as `event_id` (use ULID) | `messaging.rs:164-169` |
| Task ref / threading | `+freeq.at/task-id` (= `+freeq.at/ref`; both stored as `ref_id`) | `messaging.rs:167-169` |
| Task lookup REST | `GET /api/v1/tasks/{event_id}`, `/api/v1/channels/{c}/events?type=...&ref_id=...&since=...` | `freeq-server/src/db.rs:2128-2146`; `web.rs` |
| Member listing | IRC `NAMES` (SDK fires `'membersList'`) + per-nick WHOIS for DIDs. **`/api/v1/channels/{c}/sessions` returns AV sessions, NOT IRC members — do not use for member list.** | `freeq-server/src/web.rs:3669-3725` (AV); `freeq-sdk-js/src/client.ts` (NAMES) |
| Evidence inline | `Evidence.raw` ≤ ~4 KB; v1 caps at 3 KB | `docs/agent-native/PHASE-3-COORDINATED-WORK.md:222-240` |
| Idle detection (canonical) | `GET /api/v1/actors/{did}` returns structured `presence.{state,status,...}` and `online: bool` | `freeq-server/src/web.rs:806-932` |
| Liveness | `HEARTBEAT :state=...;ttl=N`; server auto-degrades on missed TTL | `docs/agents.md` |
| Echo of own messages | IRCv3 `echo-message` cap is **negotiated by the SDK by default** and respected by server on TAGMSG → outbound events come back via `client.on('raw')` | `freeq-sdk-js/src/client.ts:1180-1185`; `freeq-server/src/connection/messaging.rs:346-348` |
| Per-agent spend | `SPEND #channel :amount=...;unit=usd;task=<id>` (per-DID) | `freeq-server/src/connection/mod.rs:2017-2103` |
| Per-agent budget cap | `BUDGET #channel :max=...;sponsor=did:plc:...` is **per-agent**. Coordinator-issued BUDGET (no agent_did) stores under `agent_did='*'` and acts as the per-agent default for every authenticated DID via fallback in `db.get_budget(channel, Some(did))`. Per-DID overrides also possible. **There is no shared channel pool.** | `mod.rs:2058-2103, 2105-2200`; `db.rs:2317-2456` |
| Budget REST | `GET /api/v1/channels/{c}/budget` returns `{policy, current_period: {total_spent, remaining, percent_used, by_agent: [{agent_did, spent, items}]}}`. `by_agent[]` only contains DIDs with prior spend this period — default `spent=0` for absent DIDs. | `freeq-server/src/web.rs:732-773` |
| Spend REST | `GET /api/v1/channels/{c}/spend` | `web.rs` |
| Coordinator op grant | Founder runs `MODE #swarm +o <coordinator-nick>` once; server writes coordinator's DID into `chan.did_ops`; coordinator auto-opped on every JOIN thereafter | `freeq-server/src/connection/channel.rs:251, 794-838` |
| Governance | `AGENT PAUSE/RESUME/REVOKE <nick>` (op-only, **nick-only**); workers must visibly transition (`PRESENCE :state=paused`) within 10 s of `+freeq.at/governance=*` or be force-disconnected | `mod.rs:1486-1700`; PHASE-2 doc:213, 266 |
| Governance signal set | `pause`, `resume`, `revoke`, `approval_granted`, `approval_denied`, `budget_exceeded` | `mod.rs:1532, 1632, 1690, 2087` |
| History on restart | `GET /api/v1/channels/{c}/events?since=<ts>` | `freeq-server/src/web.rs` |
| DID resolution | WHOIS reply (numeric 330) → SDK `'memberDid'` event. `account=` IRC tag is **NOT** server-injected on TAGMSG; on PRIVMSG only when the recipient holds `account-tag` cap (which the SDK does not request). v1 uses WHOIS-cache only. | `freeq-server/src/connection/messaging.rs:340-361` (no TAGMSG injection); `freeq-sdk-js/src/client.ts:1180-1185` (no `account-tag` cap requested); freeqcc `daemon.ts:163-202` (WHOIS-cache pattern) |
| TS SDK | `@freeq/sdk` (freeq-sdk-js) — SASL, IRC parsing, `client.raw()`, `client.on('raw')`. **No coordination-event helpers, no public signed-PRIVMSG-with-custom-tags API — we use `client.raw('PRIVMSG ...')` and rely on server-side signing.** | `freeq-sdk-js/src/client.ts:179-244, 377, 525-534` |
| Reference daemon | `freeqcc` (TS Claude Code daemon) — owner-DID gate, delegation cert mint flow, presence + heartbeat scaffolding, WHOIS-cache pattern | `freeq/freeqcc/` |

### 2.1 What v1 must add (the actual work)

1. **TS coordination-event helper layer** — emit/consume `+freeq.at/event=*` events with percent-encoded JSON, msgid generation. Modeled on Rust SDK `freeq-sdk/src/client.rs:emit_event` and freeqcc `connect.ts:announce`.
2. **Inbound coordination-event parser** — subscribes to `client.on('raw')`, filters TAGMSGs with `+freeq.at/event`, parses tags + percent-decodes payload, validates against zod schemas, fans out to typed handlers.
3. **Capability advertisement schema.**
4. **Coordinator state machine + recovery** — task queue, claim/assign, timeout, retry, verification dispatch, in-flight assignment tracking, restart replay.
5. **Routing / capability matching** — broadcast `task_request`, race-claim on `task_accept`, oldest claim wins.
6. **Verification layer** — multi-agent consensus only.
7. **Aggregation** — morning summary generator + DM delivery (read tz from config; no chat-command override).
8. **Trust-tier policy enforcement** — operator-DID allowlist; per-task spend via per-agent BUDGET; per-repo allowlist worker-side.
9. **PR-review work executor** — diff fetcher (SHA-pinned), structured review prompt, comment formatter.
10. **Sender-DID resolution layer** — nick→DID **and** DID→nick caches populated from WHOIS (`memberDid` SDK event) on every observed JOIN/NICK and on cache miss with ≤3 s queue (mirror freeqcc `daemon.ts:163-202`). DID→nick is required for `AGENT PAUSE/RESUME/REVOKE` since those commands accept nick only.

---

## 3. Architecture

```
                     #swarm channel on irc.freeq.at
        ┌─────────────────────────────────────────────────────────┐
        │                                                         │
   ┌────┴────┐    ┌─────────────────────┐         ┌────────────┐ │
   │ Humans  │    │  swarm-coordinator  │◄───────►│  Worker A  │ │
   │ (post   │───►│  (op in #swarm)     │         │ (Claude)   │ │
   │  tasks) │    │  - task queue        │        └────────────┘ │
   └─────────┘    │  - capability reg.   │        ┌────────────┐ │
                  │  - verification      │◄──────►│  Worker B  │ │
                  │  - summary           │         │ (Claude)   │ │
                  │  - per-agent budget  │        └────────────┘ │
                  │  - did↔nick cache    │        ┌────────────┐ │
                  └──────────┬──────────┘  ◄────► │  Worker C  │ │
                             │                    │ (Claude)   │ │
                             │                    └────────────┘ │
                             ▼                                    │
                    ┌────────────────┐                            │
                    │ swarm.sqlite   │                            │
                    │ - tasks        │                            │
                    │ - claims       │                            │
                    │ - evidence     │                            │
                    │ - capabilities │                            │
                    │ - did_nick     │                            │
                    │ - last_seen_ts │                            │
                    └────────────────┘                            │
                                                                  │
        └──────────────────────────────────────────────────────────┘
```

### 3.1 Process model + restart recovery

Two distinct daemon binaries:

- **`swarm-coordinator`** — single instance per swarm channel. Owned by the channel founder. Founder grants the coordinator op via `MODE #swarm +o <coordinator-nick>` once after first JOIN; the coordinator's DID is then in `chan.did_ops` and it's auto-opped on every JOIN thereafter.
- **`swarm-worker`** — one per machine. Owned by that machine's user. Forks from `freeqcc` skeleton. Worker monitors coordinator presence; pauses claim-attempts when coordinator is `degraded`/`offline`/`paused`.

**Coordinator boot order (single-process, sync-SQLite invariant):**

1. Load SQLite (`better-sqlite3` open).
2. Run recovery scan (below). All SQLite mutations happen here, before any IRC handlers are wired.
3. Connect to freeq, perform SASL, announce sequence.
4. Subscribe to `client.on('authError')` → log + exit non-zero (otherwise `client.raw` calls would silently no-op).
5. Wire up TAGMSG / PRIVMSG handlers, coordination-event subscriber.
6. Start dispatch and summary timers.

This guarantees recovery and runtime never race on SQLite (`better-sqlite3` is sync within JS event-loop turns; only one phase runs at a time).

**Recovery scan:**

1. Replay channel events from `last_seen_event_ts` via `GET /api/v1/channels/{c}/events?since=<ts>` and merge into local state.
2. For each `tasks` row not in a terminal state, walk a recovery state machine:

| Stored `task.state` | Recovery action |
|---|---|
| `pending_claims` | If `now - task_created_at < claim_window_ms`: resume claim collection (re-arm timer for remaining window). Else if any claims arrived: run assignment now. Else: emit `task_failed :reason=claim_timeout`. |
| `assigned` (alias: `awaiting_evidence`) | If `now - assigned_at < execution_timeout_ms`: continue waiting for evidence. Else: jump to `verifying` with whatever evidence is in. |
| `verifying` | Re-run consensus on all evidence_attach for this task; emit `task_complete` or `task_failed`. |
| `complete` / `failed` | No-op. |

3. **Rebuild `assignments_in_flight[did]` from scratch** by counting (assigned tasks with this DID in `assigned_to`) − (matching evidence_attach OR task_failed events from this DID) per worker. This is derived state; never read from a persisted counter.

Workers have no persistent state. On restart they re-announce, re-advertise, set presence=idle.

### 3.2 Configuration model

Coordinator config (YAML, beside the binary):

```yaml
# ~/.freeq-swarm/coordinator.yaml
swarm:
  channel: "#swarm"
  founder_did: did:plc:abc...
  coordinator_nick: swarm    # if taken on connect: refuse to start (see §4.6)
  freeq_server: irc.freeq.at:6697
operator_allowlist:
  - did:plc:abc...     # founder
  - did:plc:def...     # collaborator
task_types:
  pr_review:
    reviewers_needed: 2
    claim_window_ms: 30000
    execution_timeout_ms: 300000
    max_usd_per_reviewer: 1.50
    allowed_repo_patterns:
      - "github.com/freeq-org/*"
      - "github.com/chad-blueyard/*"
    max_retries_on_timeout: 1
budget:
  daily_usd_per_agent: 5
summary:
  default_tz: "UTC"
  default_time: "09:00"
  per_requester_tz: {}
```

Worker config:

```yaml
# ~/.freeq-swarm/worker.yaml
worker:
  nick_hint: alice-laptop-1     # if taken: append random 4-digit suffix
  swarm_channels:
    - "#swarm"
  freeq_server: irc.freeq.at:6697
capabilities:
  task_types: [pr_review]
  max_concurrent: 1
  languages: [typescript, rust, python]
  max_diff_kloc: 10
runtime:
  models:
    - provider: anthropic
      model: claude-opus-4-7
      via: api    # api | cli | max-subscription
constraints:
  allowed_repo_patterns:
    - "github.com/freeq-org/*"
    - "github.com/chad-blueyard/*"
  max_usd_per_task: 1.50
  idle_only: true
governance:
  on_pause: complete_in_flight   # or abort_in_flight
```

### 3.3 Why two daemons, not one

- Coordinator is **trust-elevated** (sees all task state, holds op).
- Different liveness contracts (always-on vs intermittent).
- Coordinator carries SQLite state; workers are stateless. Cleaner blast-radius.

### 3.4 Coordinator-presence handling

Workers poll `GET /api/v1/actors/{coordinator_did}` every 30 s and read `presence.state` and `online`. When coordinator `state ∈ {degraded, offline, paused}` or `online == false`:

- Skip new claim attempts.
- Continue any in-flight execution.
- Resume claims when coordinator returns to `{online, idle, executing}` and `online == true`.

---

## 4. Identity, trust, policy

### 4.1 Identities

- **Channel founder** — a `did:plc:...`. Trust root for the swarm.
- **Coordinator** — `did:key:...` with a declarative `FreeqBotDelegation/v1` cert (unsigned). Founder runs `MODE #swarm +o <coordinator-nick>` once after the coordinator's first JOIN. From then on coordinator is auto-opped (its DID is in `chan.did_ops`). This satisfies the `ch.ops.contains(session_id)` check that `AGENT PAUSE/RESUME/REVOKE` require.
- **Each worker** — `did:key:...` with a declarative `FreeqBotDelegation/v1` cert.

Coordinator maintains an **operator allowlist** in config. Admission per worker:

1. Inspect worker's session DID (from SASL).
2. Inspect worker's declared `operator_did` in capability ad payload.
3. Fetch `GET /api/v1/actors/{worker_did}` and read `provenance.creator_did`.

Worker is admitted iff `operator_did ∈ allowlist` AND `provenance.creator_did == operator_did` (byte-equal). Match is **declarative — not cryptographic** in v1. Trust assumption: "I trust the operator-DID allowlist; impersonating an allowlisted DID still requires controlling an allowlisted machine."

If admission fails: NOTICE once, ignore subsequent claims, escalate to `AGENT PAUSE` (via DID→nick reverse cache) after 3 unsolicited claims.

### 4.2 Cert format (v1: declarative / unsigned)

Use `freeq-bot-id`'s native cert format (`freeq-bot-id/src/main.rs:68-87`):

```json
{
  "type": "FreeqBotDelegation/v1",
  "bot_did": "did:key:z6Mk...",
  "bot_public_key": "z6Mk...",
  "creator_did": "did:plc:abc...",
  "created_at": "2026-05-10T...Z",
  "revocation_authority": "did:plc:abc...",
  "signature": null
}
```

`bot_public_key` is **multibase** (typically `z`-prefixed Base58btc), not base64.

Server stores the cert and marks `provenance._verified: false` with reason "Cert has no signature; declarative only." v1 accepts this and uses the operator-DID allowlist as the trust gate.

**Mint command:** `freeq-bot-id create --name swarm-{coordinator|worker} --creator-did did:plc:...` (no `--creator-key`). Cert lands at `~/.freeq/bots/swarm-<role>/delegation.json`; key at `~/.freeq/bots/swarm-<role>/key.ed25519`. Daemon shells out on first launch if cert missing.

### 4.3 Spend & capability caps — using freeq's per-agent BUDGET

Three layers:

1. **Worker-side hard cap** — `constraints.max_usd_per_task` and `allowed_repo_patterns` in worker config. Worker self-aborts with `task_failed :reason=policy_violation` or `:reason=budget_exceeded` before any spend.
2. **Server-enforced per-agent budget** — coordinator runs `BUDGET #swarm :max=5;unit=usd;period=per_day;sponsor=<founder-did>` on startup. Server stores under `agent_did='*'` (channel-level row, used as per-agent default by fallback in `db.get_budget(channel, Some(did))`). On worker SPEND: server enforces per-agent (`record_spend(channel, did, ...)`); on overage emits `+freeq.at/governance=budget_exceeded` to that worker and broadcasts a 🛑 NOTICE. Coordinator listens and marks worker `blocked_on_budget` until next period. **No shared channel pool.**
3. **Coordinator pre-flight per-worker estimate** — for each candidate worker DID, query `GET /api/v1/channels/swarm/budget` (returns `policy.max_amount` + `current_period.by_agent[]` — DIDs with no prior spend this period are absent; default `spent=0`). Compute `remaining = policy.max_amount - spent`. Drop workers where `remaining < max_usd_per_reviewer`. If fewer than `reviewers_needed` candidates remain, emit `task_failed :reason=budget_exceeded` (with detail listing per-worker remaining).

Estimator (`packages/shared/src/pricing.ts`):

```ts
export const PRICING = {
  "claude-opus-4-7": {
    valid_until: "2026-08-01",
    input_per_mtok: 15.00,
    output_per_mtok: 75.00,
    nominal_output_tokens: 4096,
  },
};
```

Coordinator startup logs warning if `valid_until < now`. Coordinator refuses to estimate (treat as `policy_violation`) when stale by >30 days.

`input_tokens ≈ ceil(diff_bytes / 3.5); est_usd = input_tokens × input_per_mtok / 1e6 + nominal_output_tokens × output_per_mtok / 1e6`.

### 4.4 Governance signal handling

Workers and coordinator subscribe to channel TAGMSGs and process `+freeq.at/governance=*`. **Note: AGENT PAUSE/RESUME/REVOKE accept nicks only**, so the coordinator must maintain `did_to_nick: Map<DID, nick>` (populated from inbound JOIN, NICK changes, WHOIS) and look up the current nick before issuing the command. On nick miss: fire WHOIS, wait ≤3 s, retry once; on persistent miss, log + skip with a NOTICE to the channel.

| Signal | Worker response (v1) |
|---|---|
| `pause`              | Within 10 s: emit `PRESENCE :state=paused;status=paused by <issuer>` (this is the ACK PHASE-2:213 expects; missing it triggers force-disconnect). Stop accepting new claims. In-flight execution: per `governance.on_pause` config (default `complete_in_flight`). |
| `resume`             | Emit `PRESENCE :state=idle`. Re-enable dispatch. |
| `revoke`             | Server sends `ERROR :Revoked by <nick>` and force-disconnects. Worker detects ERROR, exits without reconnect. |
| `approval_granted`   | Log + ignore in v1. |
| `approval_denied`    | Log + ignore in v1. |
| `budget_exceeded`    | Self-mark `blocked_on_budget`; emit `PRESENCE :state=blocked_on_budget`. Resume on next budget period (worker polls budget REST every 5 min while blocked). |

Coordinator handles these for itself the same way (and tracks each worker's governance state in SQLite to avoid dispatching to paused/revoked/blocked workers).

### 4.5 Out of scope for v1

- Cryptographically-verified delegation certs.
- `+freeq.at/sig` on TAGMSG.
- Per-session MSGSIG registration (we rely on server-side fallback signing — see §6).
- Slashing / economic penalties.
- Cross-channel reputation.
- Encrypted task content.
- Coordinator-DID rotation.

### 4.6 Nick collision handling

- **Coordinator nick:** config says `coordinator_nick: swarm`. The SDK's 433 handler at `client.ts:669-672` auto-appends `_` and re-sends NICK. To enforce refuse-on-collision, coordinator subscribes to `client.on('raw')` and on `433 ERR_NICKNAMEINUSE` for `params[1] === coordinator_nick`, sets a "collision" flag, calls `client.disconnect()`, exits with: "nick `swarm` is already taken on this server. Pick a different `coordinator_nick` in your config or coordinate with the current holder."
- **Worker nick:** config says `nick_hint: alice-laptop-1`. The SDK's auto-suffix is acceptable, but we override to use a random 4-digit suffix (`alice-laptop-1-7392`) on `client.on('raw')` 433, with up to 3 retries before failing. Reasoning: `_`-suffixes aren't unique under contention; a random suffix is.

---

## 5. Wire protocol — concrete event shapes

### 5.0 Conventions

All conventions verified against `freeq-server/src/connection/messaging.rs:18-205`.

- **Server stores events from TAGMSG only.** `coordination_events` storage is inside `handle_tagmsg` (`messaging.rs:60-205`); the PRIVMSG path doesn't store. We emit a TAGMSG for storage.
- **Web client renders cards from PRIVMSG.** `CoordinationCards.tsx:25-31, 130-156, 183` reads `+freeq.at/event` etc. off `Message` objects, which only come from PRIVMSG. We emit a parallel PRIVMSG with **the full coordination-event tag set** (`+freeq.at/event`, `+freeq.at/payload`, `+freeq.at/task-id`, `+freeq.at/evidence-type`) so the web UI renders.
- **Therefore: every event = one TAGMSG (for storage) + one PRIVMSG (for rendering), both carrying the same full set of `+freeq.at/*` tags.** The PRIVMSG body is short human-readable text.
- **Payload encoding: percent-encoded JSON.** Sender JSON-stringifies, then percent-escapes `;` and ASCII space. Server decodes via `urlencoding::decode()` (`messaging.rs:170-175`). The IRCv3 tag-escape (`\\`, `\:`, `\s`, `\r`, `\n`) is applied transparently by `serializeTags` and pct-encoded JSON contains none of those, so it survives unchanged. Unit test `shared/src/freeq.test.ts` round-trips `parse(format(emit(payload)))` and asserts equality.
- **Event id: ULID, passed via `msgid` IRC tag on the TAGMSG.** Server stores `msgid` as `event_id`. We pre-mint a ULID, set `msgid=<ulid>` on outgoing tags. Use it as the canonical task id throughout. `+freeq.at/task-id` and `+freeq.at/ref` are interchangeable to the server (both stored as `ref_id`); v1 uses `+freeq.at/task-id`.
- **Sender DID resolution: WHOIS-cache only.** `account=` is not server-injected on TAGMSG and the SDK does not request `account-tag` cap. Mirror freeqcc `daemon.ts:163-202`: pre-warm cache from `client.on('memberDid', ...)` (numeric 330), populate on every observed JOIN/NICK, on cache miss fire WHOIS + queue inbound for ≤3 s.
- **PRIVMSG signing: server-side fallback.** SDK `autoMsgSig: false`. Server signs as the authenticated DID (`messaging.rs:18-58`) when no per-session sig is supplied — recipients see signature-verified messages without us registering MSGSIG.
- **Echo-message: negotiated by SDK by default.** Outbound TAGMSGs come back via `client.on('raw')`. Coordinator can use the echoed event_id as "server accepted the event" confirmation, but v1 doesn't require this.
- **Rate limit: 5 coordination-event TAGMSGs / 2 s per session.** Workers coalesce progress updates at ≥400 ms intervals; coordinator paces dispatch.
- **Timestamps in payloads: unix seconds (UTC).**
- **Payload size: ≤3 KB inline cap.** Larger reviews truncate `comments[]` from the end (keep highest-severity), set `truncated: true`. Full text remains in coordinator's local SQLite for the morning summary.

### 5.0.1 Helper invariant

`emitCoordinationEvent(client, channel, eventType, payload, opts)` MUST:

1. Pre-mint a ULID `event_id = opts.eventId ?? newULID()`.
2. Build tag set: `{ msgid: event_id, '+freeq.at/event': eventType, '+freeq.at/payload': pctEncode(JSON.stringify(payload)), ...optTags }`.
3. Send TAGMSG via `client.raw(format('TAGMSG', [channel], tags))`.
4. Send PRIVMSG via `client.raw(format('PRIVMSG', [channel, humanText], tags))` carrying THE SAME tag set (with optional override of `humanText`).
5. Return `event_id` to caller for downstream `task-id` references.

### 5.1 Worker → channel: capability advertisement

Posted **after** the announce sequence (PROVENANCE → AGENT REGISTER → PRESENCE=online → HEARTBEAT → JOIN). After the cap ad publishes, worker emits `PRESENCE :state=idle` to signal eligibility. Re-published every 15 minutes.

```
@msgid=<ulid>;+freeq.at/event=status_update;+freeq.at/payload=<pct-enc> TAGMSG #swarm
@msgid=<ulid>;+freeq.at/event=status_update;+freeq.at/payload=<pct-enc> PRIVMSG #swarm :💪 capabilities advertised
```

Payload:

```json
{
  "kind": "swarm.capabilities/v1",
  "worker_did": "did:key:z6Mk...",
  "operator_did": "did:plc:abc...",
  "advertised": {
    "task_types": ["pr_review"],
    "models": [{"provider": "anthropic", "model": "claude-opus-4-7", "via": "api"}],
    "max_concurrent": 1,
    "languages": ["typescript", "rust", "python"],
    "max_diff_kloc": 10
  },
  "constraints": {
    "allowed_repo_patterns": ["github.com/freeq-org/*", "github.com/chad-blueyard/*"],
    "max_usd_per_task": 1.50,
    "idle_only": true
  }
}
```

### 5.2 Worker → channel: presence

Standard freeq `PRESENCE`. Coordinator observes via REST poll (`GET /api/v1/actors/{did}`, 30 s interval). Eligibility predicate: `presence.state == 'idle' AND assignments_in_flight[did] < advertised.max_concurrent`.

Worker presence lifecycle:
- Just-connected: `state=online`
- After cap ad: `state=idle` (eligible)
- Assigned: `state=executing;status=...;task=<task-ulid>`
- After evidence + SPEND: `state=idle`
- On `+freeq.at/governance=pause`: `state=paused`
- On `+freeq.at/governance=budget_exceeded`: `state=blocked_on_budget`
- On clean shutdown: `state=offline` → QUIT

### 5.3 Human → channel: task ingestion

```
@swarm review https://github.com/foo/bar/pull/42
@swarm review https://github.com/foo/bar/pull/42 reviewers=3 priority=high
```

Parser: addressing prefixes `swarm:`, `swarm,`, `@swarm`. First token after = task type (only `review` in v1; unknown → NOTICE refusal). Next positional = primary target. Whitelisted `key=value` flags: `reviewers`, `priority`, `model`. Unknown keys → NOTICE refusal.

### 5.4 Coordinator → channel: `task_request`

Pair with FULL tag set on both lines:

```
@msgid=<task-ulid>;+freeq.at/event=task_request;+freeq.at/payload=<pct-enc> TAGMSG #swarm
@msgid=<task-ulid>;+freeq.at/event=task_request;+freeq.at/task-id=<task-ulid>;+freeq.at/payload=<pct-enc> PRIVMSG #swarm :📋 review github.com/foo/bar#42 (head abc1234) — claims open for 30s
```

Payload:

```json
{
  "kind": "swarm.task/v1",
  "task_type": "pr_review",
  "requester_did": "did:plc:human..." | null,
  "target": {"repo": "foo/bar", "pr": 42, "head_sha": "abc1234567"},
  "spec": {
    "diff_url": "https://github.com/foo/bar/pull/42.diff",
    "review_focus": ["correctness", "test_coverage"]
  },
  "policy": {
    "reviewers_needed": 2,
    "claim_window_ms": 30000,
    "execution_timeout_ms": 300000,
    "max_usd_per_reviewer": 1.50
  }
}
```

Coordinator resolves `requester_did` via WHOIS-cache before posting. **If unresolved (guest, not in cache after retry), refuse with `task_failed :reason=ingestion_error :detail=requester_did_unresolved`** — operator allowlist enforcement requires the DID. So `requester_did` is non-null in successfully-posted task_requests; the `null` in the schema covers only the failure-detail intermediate state.

Coordinator resolves `head_sha` via `gh pr view --json headRefOid`. Failure modes:
- exit 1 + "404" → `task_failed :reason=ingestion_error :detail=repo_not_found_or_private`
- no `gh auth` → `task_failed :reason=ingestion_error :detail=auth_error`
- other → `task_failed :reason=ingestion_error :detail=network_error`

Validation: `requester_did ∈ operator_allowlist`; `target.repo` matches one of `allowed_repo_patterns`.

**Force-push policy v1:** task pinned to `head_sha`. Auto-retrigger v2.

### 5.5 Worker → channel: claim (`task_accept`)

```
@msgid=<ulid>;+freeq.at/event=task_accept;+freeq.at/task-id=<task-ulid>;+freeq.at/payload=<pct-enc> TAGMSG #swarm
@msgid=<ulid>;+freeq.at/event=task_accept;+freeq.at/task-id=<task-ulid>;+freeq.at/payload=<pct-enc> PRIVMSG #swarm :🙋 claiming TASK ...
```

Payload:

```json
{
  "kind": "swarm.claim/v1",
  "task_id": "<task-ulid>",
  "worker_did": "did:key:..."
}
```

Coordinator collects `task_accept` for `claim_window_ms`, picks `reviewers_needed`. **Selection algorithm (v1):** oldest `task_accept` arrival time wins; ties broken by stable hash of `(task_id, worker_did)` for determinism. **Reputation tiebreaker is cut from v1** (kept as a SQLite column for v2; coordinator updates it but doesn't consult it in dispatch).

### 5.6 Coordinator → channel: assignment (`task_update :phase=assigned`)

```
@msgid=<ulid>;+freeq.at/event=task_update;+freeq.at/task-id=<task-ulid>;+freeq.at/payload=<pct-enc> TAGMSG #swarm
@msgid=<ulid>;+freeq.at/event=task_update;+freeq.at/task-id=<task-ulid>;+freeq.at/payload=<pct-enc> PRIVMSG #swarm :→ assigned to alice-laptop-1, bob-laptop-2
```

Payload:

```json
{
  "kind": "swarm.assignment/v1",
  "task_id": "<task-ulid>",
  "phase": "assigned",
  "assigned_to": ["did:key:a...", "did:key:b..."],
  "deadline_unix": 1715361234
}
```

**Coordinator concurrency tracking:** `assignments_in_flight[worker_did]` counter incremented synchronously when this assignment is posted; decremented when matching `evidence_attach` or `task_failed` arrives, OR after `execution_timeout_ms`. A worker is eligible only if `assignments_in_flight[did] < advertised.max_concurrent`. Counter is derived state — rebuilt from SQLite on coordinator restart (§3.1).

Workers compare `assigned_to` to their own DID. Non-assignees drop the task silently.

### 5.7 Worker → channel: progress + evidence

Progress (`task_update`, ≥400 ms apart):

```
@msgid=<ulid>;+freeq.at/event=task_update;+freeq.at/task-id=<task-ulid>;+freeq.at/payload=<pct-enc> TAGMSG #swarm
@msgid=<ulid>;+freeq.at/event=task_update;+freeq.at/task-id=<task-ulid>;+freeq.at/payload=<pct-enc> PRIVMSG #swarm :⚙ reviewing 3 files, 142 LOC
```

`task_update` payload:

```json
{ "kind": "swarm.progress/v1", "task_id": "<task-ulid>", "phase": "fetching_diff | reviewing | submitting", "detail": "..." }
```

**Diff fetching idiom:**

1. `gh api repos/<repo>/pulls/<pr>` → read `.base.sha`, `.head.sha`. Verify `.head.sha == task.target.head_sha`; if not (force-push), emit `task_failed :reason=head_sha_lost`.
2. `gh api repos/<repo>/commits/<head_sha>` → confirm SHA reachable (404 → `head_sha_lost`).
3. `gh api repos/<repo>/compare/<base_sha>...<head_sha>` → returns JSON `{files: [{filename, status, additions, deletions, patch, previous_filename?}, ...], ...}`.
4. **Reconstruct unified diff** from `files[]`: for each file, emit:
   ```
   diff --git a/<filename> b/<filename>
   --- a/<filename>
   +++ b/<filename>
   <patch>
   ```
   Use `previous_filename` for renames (`a/<previous>`). Skip files where `patch === null` (binary or too-large) and note in review summary.
5. **Refuse oversized PRs:** if `files.length === 300` (GitHub's API cap) OR any file with `patch === null && status !== 'removed'`, emit `task_failed :reason=diff_too_large`.

Evidence (`evidence_attach`, with `+freeq.at/evidence-type=code_review`):

```
@msgid=<ulid>;+freeq.at/event=evidence_attach;+freeq.at/task-id=<task-ulid>;+freeq.at/evidence-type=code_review;+freeq.at/payload=<pct-enc> TAGMSG #swarm
@msgid=<ulid>;+freeq.at/event=evidence_attach;+freeq.at/task-id=<task-ulid>;+freeq.at/evidence-type=code_review;+freeq.at/payload=<pct-enc> PRIVMSG #swarm :📎 review submitted (verdict=approve_with_comments)
```

Payload:

```json
{
  "kind": "swarm.review/v1",
  "evidence_type": "code_review",
  "task_id": "<task-ulid>",
  "verdict": "approve_with_comments",
  "severity": "low",
  "summary": "Looks good. Two minor naming nits, one missing test.",
  "comments": [
    {"file": "src/foo.ts", "line": 42, "severity": "low", "msg": "..."}
  ],
  "truncated": false,
  "tokens_used": 8421,
  "usd_cost": 0.13,
  "model": "claude-opus-4-7",
  "via": "api"
}
```

Constraints:
- `verdict` ∈ `{approve, approve_with_comments, request_changes, reject}`.
- `severity` ∈ `{none, low, medium, high, critical}`.
- Total payload size ≤ 3 KB. Truncate `comments[]` from end (keep highest-severity), set `truncated: true`. Full text remains in coordinator's local SQLite for the morning summary.

### 5.8 Worker → channel: SPEND report

After each successful `evidence_attach`:

```
SPEND #swarm :amount=0.13;unit=usd;task=<task-ulid>
```

If this pushes the worker over its per-agent BUDGET, server emits `+freeq.at/governance=budget_exceeded` to that worker; worker self-marks `blocked_on_budget`; coordinator removes from eligible pool.

### 5.9 Coordinator → channel: `task_complete` / `task_failed`

```
@msgid=<ulid>;+freeq.at/event=task_complete;+freeq.at/task-id=<task-ulid>;+freeq.at/payload=<pct-enc> TAGMSG #swarm
@msgid=<ulid>;+freeq.at/event=task_complete;+freeq.at/task-id=<task-ulid>;+freeq.at/payload=<pct-enc> PRIVMSG #swarm :✅ TASK ... — verdict=approve_with_comments (consensus 2/2)
```

Payload:

```json
{
  "kind": "swarm.completion/v1",
  "task_id": "<task-ulid>",
  "consensus_verdict": "approve_with_comments",
  "consensus_severity": "low",
  "agreement_score": 1.0,
  "reviewer_dids": ["did:key:a...", "did:key:b..."],
  "evidence_event_ids": ["<ulid-of-evidence-1>", "<ulid-of-evidence-2>"],
  "total_usd_cost": 0.27,
  "wall_clock_ms": 84000
}
```

Per-reviewer evidence is fetchable via `GET /api/v1/channels/swarm/events/<event-id>` — freeq's existing audit path; no coordinator HTTP server needed.

**Consensus algorithm (v1, hardcoded):**

1. Bucket reviews by `verdict`.
2. If one bucket has strict majority (>50% of submissions): pick it; `agreement_score = bucket_size / total`.
3. On tie:
   a. Pick the bucket with the highest *max* severity (`critical > high > medium > low > none`). Favors caution.
   b. If severities also tie: verdict order `reject > request_changes > approve_with_comments > approve` wins.
4. If `agreement_score < 0.5`: `task_failed :reason=consensus_irreconcilable` with per-reviewer verdicts in `detail`.
5. `consensus_severity = max(severity)` over the picked bucket.

Reputation update (kept in SQLite, not consulted by dispatch in v1): workers in the picked-verdict bucket get +1; dissenters get 0.

`task_failed` mirror:

```json
{
  "kind": "swarm.failure/v1",
  "task_id": "<task-ulid>",
  "reason": "consensus_irreconcilable | no_claims | claim_timeout | execution_timeout | all_workers_failed | budget_exceeded | policy_violation | ingestion_error | head_sha_lost | diff_too_large",
  "detail": "..."
}
```

**Retry on `execution_timeout`:** if `now - task_created_at < 2 × execution_timeout_ms` AND eligible-but-unassigned workers ≥ `reviewers_needed - successful_evidence_count`, re-dispatch with `retries_remaining -= 1` (default starts at 1). No retry on `consensus_irreconcilable`.

### 5.10 Coordinator → human: morning summary

Coordinator stores `requester_did → last_known_nick` (refreshed on each ingestion via WHOIS-cache and JOIN/NICK observation). At the requester's configured time (`summary.per_requester_tz` config; falls back to `summary.default_time` in `summary.default_tz`):

```
PRIVMSG <requester-nick> :☀️ Swarm summary 2026-05-11
PRIVMSG <requester-nick> :  • 7 tasks completed (all approved)
PRIVMSG <requester-nick> :  • 2 needed your attention:
PRIVMSG <requester-nick> :    - TASK-01HZN... : consensus_irreconcilable (verdicts: approve, reject, request_changes)
PRIVMSG <requester-nick> :    - TASK-01HZP... : execution_timeout (2/2 workers timed out, retried 0/1)
PRIVMSG <requester-nick> :  • Spend: $1.84 across 9 worker-runs
PRIVMSG <requester-nick> :  • Top contributor: bob-laptop-2 (4 reviews)
PRIVMSG <requester-nick> :  Audit: GET /api/v1/channels/swarm/events?since=<24h-ago-ts>
```

In freeq web client, DMs to a person materialize in their `#<their-nick>` channel; on irssi/weechat as query window. PRIVMSG is correct wire form for both. **No chat-command tz override in v1.**

---

## 6. Tech stack

- **Language:** TypeScript + Node 22+. Matches `freeqcc` and `@freeq/sdk-js`.
- **IRC client:** `@freeq/sdk-js`. SDK options: `autoMsgSig: false` (we rely on server-side fallback signing). Use `client.raw(format(...))` for all coordination-event PRIVMSG/TAGMSG (the SDK has no public signed-PRIVMSG-with-custom-tags API). `format` and tag-escape come from the SDK's `parser.ts`.
- **Auth-error handling:** subscribe to `client.on('authError', ...)` at startup and exit non-zero. `client.raw()` short-circuits silently on `_saslFailed`, so we must surface SASL failure explicitly.
- **State:** SQLite via `better-sqlite3`. One file per coordinator. Writes are sync within JS event-loop turns; recovery + dispatch never race because boot order serializes them (§3.1).
- **PR review executor:** Anthropic SDK (`@anthropic-ai/sdk`) with prompt caching on the system prompt. Default model `claude-opus-4-7`. Worker config can override; `via=cli` workers use `claude` CLI subprocess.
- **Diff fetching:** `gh api` shelled out (working-directory-independent given `--repo` or path-style URL). Token caveat: documented in worker README.
- **Build / package mgmt:** pnpm workspaces.
- **Lint / format:** biome.
- **Tests:** vitest.

---

## 7. Repo layout

```
collaborative-compute-on-freeq/
├── README.md
├── PLAN.md
├── package.json               # pnpm workspace root
├── pnpm-workspace.yaml
├── biome.json
├── tsconfig.base.json
├── packages/
│   ├── shared/
│   │   ├── src/events.ts      # zod schemas for every payload in §5
│   │   ├── src/policy.ts      # config loaders (yaml → typed)
│   │   ├── src/freeq.ts       # emitCoordinationEvent + subscribeCoordinationEvents
│   │   ├── src/announce.ts    # PROVENANCE/AGENT REGISTER/PRESENCE/HEARTBEAT/JOIN/cap-ad sequence
│   │   ├── src/delegation.ts  # cert load/mint (wraps freeq-bot-id; reads from ~/.freeq/bots/<name>/)
│   │   ├── src/pricing.ts     # cost estimator constants (with valid_until)
│   │   ├── src/did_resolver.ts# nick↔DID caches (WHOIS-driven)
│   │   ├── src/ulid.ts
│   │   ├── src/governance.ts  # +freeq.at/governance=* signal handler base
│   │   └── src/freeq.test.ts  # round-trip pct-encode + tag escape tests
│   ├── coordinator/
│   │   ├── src/main.ts        # entrypoint (boot order per §3.1)
│   │   ├── src/db.ts          # SQLite schema + queries
│   │   ├── src/queue.ts       # task lifecycle state machine + recovery
│   │   ├── src/dispatch.ts    # claim collection + assignment + assignments_in_flight
│   │   ├── src/verify.ts      # consensus algorithm
│   │   ├── src/budget.ts      # BUDGET issuance + per-worker pre-flight + budget_exceeded handling
│   │   ├── src/summary.ts     # morning summary generator + scheduler
│   │   ├── src/nick_collision.ts # raw 433 → exit
│   │   └── src/cli.ts         # `swarm-coordinator launch|status|stop`
│   ├── worker/
│   │   ├── src/main.ts        # entrypoint (forks freeqcc skeleton)
│   │   ├── src/capabilities.ts
│   │   ├── src/claim.ts
│   │   ├── src/coord_watch.ts # coordinator-presence monitor
│   │   ├── src/governance.ts  # +freeq.at/governance=* response
│   │   ├── src/executors/pr_review.ts
│   │   ├── src/executors/pr_review.prompt.md
│   │   ├── src/diff.ts        # gh api compare → unified diff reconstruction
│   │   └── src/cli.ts         # `swarm-worker launch|status|stop`
│   └── cli/                   # one shared `swarm` CLI entrypoint that delegates
└── examples/
    └── pr-review/
        ├── README.md
        └── fixtures/
            ├── tiny-pr.diff
            └── tiny-pr.meta.json  # owner/repo/pr/head_sha pinned
```

---

## 8. Implementation phases

### Phase 0 — scaffolding (target: half a day)

- pnpm workspace; biome; vitest; tsconfig; CI on `pnpm typecheck && pnpm test`.
- Empty `coordinator` and `worker` packages whose `src/main.ts` does nothing but log "hi" and exit cleanly.
- `shared/src/events.ts` with zod schemas for every payload in §5.
- `shared/src/freeq.ts`:
  - `emitCoordinationEvent(client, channel, eventType, payload, opts)` per §5.0.1.
  - `subscribeCoordinationEvents(client, handler)` — parses `client.on('raw')` lines, filters `+freeq.at/event=*` TAGMSGs, validates with zod, calls `handler({eventId, eventType, taskId, evidenceType, payload, sender_nick, raw})`.
- `shared/src/freeq.test.ts` — round-trips `parse(format(emit(payload)))` and asserts decoded payload equals original.
- `shared/src/pricing.ts` with `claude-opus-4-7` constants. Test parses `valid_until`; emits `console.warn` if past (does not fail CI).

**Exit:** `pnpm build && pnpm typecheck && pnpm test` clean from a fresh clone.

### Phase 1 — coordinator and worker connect to a real channel

- `coordinator launch` flow:
  - Generate did:key via `freeq-bot-id create --name swarm-coordinator --creator-did <founder>`. Cert + key persisted at `~/.freeq/bots/swarm-coordinator/`.
  - Connect to `irc.freeq.at` with SASL ATPROTO-CHALLENGE, `autoMsgSig: false`.
  - Subscribe to `client.on('authError')` → exit.
  - Subscribe to `client.on('raw')` for 433 collision check (per §4.6).
  - Run announce sequence (PROVENANCE → AGENT REGISTER → PRESENCE=online → HEARTBEAT → JOIN), then advertise capabilities, then PRESENCE=idle.
  - Issue `BUDGET #swarm-test :max=10;unit=usd;period=per_day;sponsor=<founder-did>` if not already set.
  - Pre-warm DID cache from observed JOINs.
- `worker launch` flow: same with worker-flavored cert + PROVENANCE; nick collision → random suffix retry.
- **Founder grants op manually** (one-time): on freeq web client or any IRC client, founder runs `MODE #swarm-test +o swarm` after seeing the coordinator JOIN.
- SQLite schema initialized: `tasks`, `claims`, `evidence`, `capabilities`, `did_to_nick`, `nick_to_did`, `last_seen_event_ts` tables.

**Exit:**
- `coordinator launch` + 2 `worker launch` succeed.
- `NAMES #swarm-test` (issued from a 4th IRC client) returns 3 nicks; per-nick WHOIS returns DIDs matching the cert files.
- `GET /api/v1/actors/<coordinator-did>` returns `provenance.type == "FreeqBotDelegation/v1"` and `provenance.bot_did == coordinator-did`. **`provenance._verified` is `false` and that is expected.**
- After founder issues `MODE +o swarm`, coordinator restarts and `provenance.online == true` AND coordinator is in `chan.ops` per `GET /api/v1/channels/swarm-test/audit` (mode change visible) AND a manual `AGENT PAUSE` from coordinator on a worker nick succeeds.
- After both workers complete cap ad, `GET /api/v1/actors/<worker-did>` returns `presence.state == "idle"`.
- Coordinator's SQLite has 2 rows in `capabilities` keyed by worker DID.
- `GET /api/v1/channels/swarm-test/budget` returns `policy.max_amount == 10`, `policy.unit == "usd"`, `policy.period == "per_day"`.
- Manual `kill -9` on coordinator → restart: `presence.online == true` within 10 s, `last_seen_event_ts` advances on next coordination event.

### Phase 2 — task ingestion and `task_request`

- Coordinator subscribes to inbound PRIVMSGs addressed to its nick.
- Parses `@swarm review <pr-url> [k=v...]`. Whitelisted keys: `reviewers`, `priority`, `model`. Unknown → NOTICE refusal.
- Resolves requester DID via WHOIS-cache; refuses with `requester_did_unresolved` if missing.
- Resolves `head_sha` via `gh pr view --json headRefOid`. Failure modes per §5.4.
- Validates: requester DID in allowlist; repo matches `allowed_repo_patterns`.
- Posts `task_request` per §5.4 (TAGMSG + companion PRIVMSG, both with full tag set).

**Exit:**
- Posting `@swarm review <real-pr-url>` produces a `task_request` event whose payload validates against the zod schema.
- `GET /api/v1/channels/swarm-test/events?type=task_request` returns the new event.
- The companion PRIVMSG, observed in the freeq web client, renders as a TaskRequestCard (per `CoordinationCards.tsx`).
- Bad-repo, non-allowlisted requester, missing-PR, `gh auth`-missing variants each produce `task_failed` with the right reason+detail.

### Phase 3 — claim + assign

- Worker subscribes to inbound TAGMSGs via `subscribeCoordinationEvents`, evaluates `task_request` against capability + constraints.
- Eligible AND `presence=idle` AND `assignments_in_flight[self_did] < max_concurrent` → post `task_accept` per §5.5.
- Coordinator collects `task_accept` for `claim_window_ms`, picks `reviewers_needed` (oldest claim wins; deterministic hash-tiebreak).
- Coordinator increments `assignments_in_flight[did]` synchronously when posting assignment.
- Coordinator posts `task_update :phase=assigned` per §5.6.
- Assigned workers: set `PRESENCE=executing;status=...;task=<task-ulid>`. Non-assignees: drop silently.

**Exit:**
- 2 workers + `reviewers_needed=2` → both claim, both assigned.
- 3 workers + `reviewers_needed=2` → exactly 2 assigned.
- A worker that's `executing` from a previous task → not eligible.
- **In-flight race test (with test hook):** worker's `task_accept` handler artificially delays 500 ms before sending. Coordinator posts two `task_request`s within 100 ms. Assert each worker accepts at most ONE task (its `assignments_in_flight` would be 1 before its PRESENCE updates).
- `GET /api/v1/channels/swarm-test/events?type=task_accept&ref_id=<task-ulid>` returns the claim events.

### Phase 4a — worker executes a real PR review (single worker)

- Diff fetcher per §5.7 (gh api SHA-pinned + reconstruct headers from `files[].patch`; refuse on 300-file cap or `patch === null` for non-removed file).
- Anthropic SDK call with `pr_review.prompt.md` (system prompt cached) + reconstructed diff.
- Parse to `swarm.review/v1`.
- Post `evidence_attach` (TAGMSG + companion PRIVMSG, full tag set, `+freeq.at/evidence-type=code_review`).
- Post `SPEND`.
- Set `PRESENCE=idle`.
- On exception/timeout: post `task_failed`.

**Exit:**
- Run against `examples/pr-review/fixtures/tiny-pr` (small captured public PR diff: ≤10 files, all text, ≤200 LOC). 1 worker reviews end-to-end. Review JSON validates against v1 schema. Wall clock < 60 s, cost < $0.50. `SPEND` event visible at `/api/v1/channels/swarm-test/spend`.
- `evidence_attach` PRIVMSG, observed in freeq web client, renders as EvidenceCard with the magnifying-glass-icon code_review presentation.

### Phase 4b — cost guard + repo allowlist + governance signals

- Worker pre-flight: estimate cost via `pricing.ts`; if estimate > `max_usd_per_task`, post `task_failed :reason=budget_exceeded`.
- Worker pre-flight: check `target.repo` against `allowed_repo_patterns`; if mismatch, `task_failed :reason=policy_violation`.
- Worker handles `+freeq.at/governance=*` per §4.4 (full table, `pause` ACK via `PRESENCE=paused` within 10 s).

**Exit:**
- Worker with `max_usd_per_task=0.01` refuses any non-trivial review.
- Worker with `allowed_repo_patterns: []` refuses every task.
- Manually `BUDGET #swarm-test :max=0.001;unit=usd;period=per_day` (avoid divide-by-zero) → next worker SPEND triggers `+freeq.at/governance=budget_exceeded` → worker emits `PRESENCE :state=blocked_on_budget`.
- Manually `AGENT PAUSE <worker-nick>` (issued by coordinator using DID→nick reverse cache) → worker emits `PRESENCE :state=paused` within 10 s and stops claiming.
- Manually `AGENT REVOKE <worker-nick>` → worker exits cleanly (no reconnect loop).

### Phase 5 — verification (consensus only) and `task_complete`

- Coordinator commits each inbound `evidence_attach` to SQLite synchronously before any consensus work.
- When `reviewers_needed` evidence_attach are in (or `execution_timeout_ms` hits): apply consensus algorithm per §5.9.
- On `consensus_irreconcilable`: emit `task_failed`. On `execution_timeout` with retries available: re-dispatch.
- Reputation update written to SQLite (not consulted by dispatch in v1).
- Post `task_complete` with `evidence_event_ids`.

**Exit:**
- Run a fixture PR through 2 workers concurrently. `task_complete` posted with `consensus_verdict` matching both reviews, `agreement_score=1.0`.
- Manually inject 3rd disagreeing review → majority logic still picks correctly.
- Force 0.5 split → `consensus_irreconcilable` fires.
- **Restart-mid-task test:** spawn task, wait until both workers post evidence_attach but before coordinator runs verify. Confirm coordinator wrote both evidence rows to SQLite. `kill -9` coordinator. Restart. Verify recovery walks the `verifying` row and emits `task_complete` with correct consensus.
- **In-flight rebuild test:** spawn task with single worker, worker posts evidence, coordinator commits. `kill -9` coordinator. Restart. Verify `assignments_in_flight[worker_did] == 0` (rebuild from event log) and the worker can claim a new task.

### Phase 6 — morning summary

- Coordinator runs in-process scheduler. Per requester DID, configurable target time.
- Builds summary from SQLite: tasks completed in last 24h, those with non-`approve` verdict or any `task_failed`, total spend, top contributors.
- Sends as PRIVMSG to requester's last-known nick.

**Exit:**
- Run `swarm-coordinator summary now <requester-did>` → DM arrives correctly formatted.
- Set `summary.default_time` to a wall-clock time 2 minutes in the future, restart, observe scheduled fire.

### Phase 7 — install / docs / demo recording

- README with copy-pasteable install instructions.
- 5-minute screencast of full demo.
- `examples/pr-review/README.md` walkthrough referencing the fixture PR.

**Exit:** On a fresh macOS or Linux VM, scripted: `pnpm install && pnpm worker launch` succeeds within 10 minutes (timed via wall clock); a `task_request` posted in `#swarm` produces a `task_accept` from the new worker.

---

## 9. Open questions resolved (cumulative)

All questions from rev 1 §9, rev 2 §10, and rev 3 §10 are resolved in the body of this document. No outstanding open questions.

Highlights of late-resolved items (rev 4):

| # | Resolution |
|---|---|
| Companion-PRIVMSG `account=` tag | Dropped. Stock SDK doesn't request `account-tag`; server doesn't inject on TAGMSG anyway. WHOIS-cache only, mirror freeqcc `daemon.ts:163-202`. |
| Web-client card rendering | Cards render off PRIVMSG, not TAGMSG. Therefore companion PRIVMSG carries the FULL `+freeq.at/*` tag set (not just `task-id`). |
| SDK signed-PRIVMSG-with-custom-tags | No public API. Use `client.raw('PRIVMSG ...')` with server-side fallback signing. `autoMsgSig: false`. |
| Coordinator op grant | Plain `MODE #swarm +o <coordinator-nick>` from founder. Server writes DID into `chan.did_ops`. Auto-op on every JOIN thereafter. |
| `AGENT PAUSE` target | Nick only. Coordinator maintains DID→nick reverse cache. |
| Member listing endpoint | `/channels/{c}/sessions` returns AV sessions, not IRC members. Use `NAMES` + per-nick WHOIS. |
| `BUDGET` first-post semantics | Server stores under `agent_did='*'`; acts as per-agent default via fallback in `db.get_budget`. Per-DID overrides also possible. No shared pool. |
| `gh api compare` diff format | Returns `files[].patch` (per-file unified hunks, no headers). Reconstruct headers; cap 300 files; refuse if any non-removed file has `patch === null`. |
| `client.raw` SASL gate | `client.raw()` short-circuits on `_saslFailed`. Subscribe to `client.on('authError')` and exit non-zero. |
| Echo-message | SDK negotiates by default; outbound TAGMSGs come back via `client.on('raw')`. |
| `requester_did` nullability | Schema permits `null` for failure-detail intermediate; coordinator refuses ingestion with `requester_did_unresolved` if WHOIS doesn't resolve. |
| `assignments_in_flight` recovery | Derived state, never persisted. Rebuilt from SQLite event log on restart. |
| Cert path | `~/.freeq/bots/<name>/{delegation.json,key.ed25519}` — `freeq-bot-id` writes there, daemon reads from there. |

---

## 10. Out of scope (parking lot for v2+)

- Bot-to-bot delegation chains
- Task types beyond `pr_review`
- Local-model workers (MLX, Ollama)
- Browser-runtime workers
- Cross-channel federation
- E2EE task content
- Capability tokens with TTL
- Reputation portability + reputation-aware dispatch
- AT Protocol record-backed task history
- Public marketplace tier
- Tokenized incentives
- Deterministic test execution as a verification mode
- `AGENT MANIFEST` registration
- `APPROVAL_REQUEST` flow
- Force-push auto re-review
- Cross-coordinator task migration
- Cryptographically-verified delegation certs
- `+freeq.at/sig` on TAGMSG
- Coordinator-hosted HTTP blob server
- Chat-command tz / summary-time config
- Configurable consensus_policy per task type
- Coordinator-DID rotation
- `account-tag` IRCv3 cap usage (would skip WHOIS round-trips on PRIVMSG)
