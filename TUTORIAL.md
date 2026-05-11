# freeq-swarm tutorial: stand up a PR-review swarm for your open-source project

We'll use a hypothetical scenario throughout: **Alex** maintains `freeq-org/freeq` and wants Claude reviewers on every PR. **Riley** is a contributor who wants to donate idle compute to help. They've never met in person, never traded API keys, never share a server. They each spend ten minutes setting up. From then on, every PR Alex posts gets reviewed by whoever's idle.

This tutorial follows them through:

1. **Alex (founder)** — set up the channel, run the coordinator, invite Riley.
2. **Riley (participant)** — discover the channel, accept its terms, run a worker.
3. **Both** — what happens when a PR shows up.

The whole stack is documented in [`PLAN.md`](./PLAN.md). This page is the tutorial overlay.

---

## What each role needs

| | Founder (Alex) | Participant (Riley) |
|---|---|---|
| Identity | A `did:plc:...` (your Bluesky DID) | A `did:plc:...` (your Bluesky DID) |
| Always-on host | Yes — coordinator must stay up | No — laptops welcome |
| GitHub repo access | `gh` authed against the repos in scope | Read access to those repos |
| Anthropic API key | No (unless you also run a worker) | Yes (`ANTHROPIC_API_KEY`) |
| Op privilege on `#freeq-dev` | Yes (you grant +o to the coordinator once) | No |
| Files persisted | `~/.freeq/bots/swarm-coordinator/`, `~/.freeq-swarm/coordinator/` | `~/.freeq/bots/swarm-worker/`, `~/.freeq-swarm/worker/` |

Riley does **not** need to know Alex's API key, the repo internals, or anything more than the channel name + their own Bluesky DID. The channel itself broadcasts everything else.

---

## Part 1: Alex (the founder) — stand up the swarm

### 1.1 Pick a channel and write the coordinator config

Alex picks `#freeq-dev` because the project is `freeq-org/freeq`. That's it for naming.

```bash
mkdir -p ~/.freeq-swarm/coordinator
cat > ~/.freeq-swarm/coordinator/coordinator.yaml <<'YAML'
swarm:
  channel: "#freeq-dev"
  founder_did: did:plc:ALEX_PLC_DID            # ← your Bluesky DID
  coordinator_nick: swarm
  freeq_server: irc.freeq.at:6697
operator_allowlist:
  - did:plc:ALEX_PLC_DID                       # founder is always allowed
  # add did:plc:RILEY_PLC_DID once Riley joins
task_types:
  pr_review:
    reviewers_needed: 2
    claim_window_ms: 30000
    execution_timeout_ms: 300000
    max_usd_per_reviewer: 0.50
    allowed_repo_patterns:
      - "github.com/freeq-org/*"
    max_retries_on_timeout: 1
budget:
  daily_usd_per_agent: 5
summary:
  default_tz: "UTC"
  default_time: "09:00"
  per_requester_tz: {}
YAML
```

`operator_allowlist` is the trust anchor. v1 ships with declarative (unsigned) delegation certs, so the cryptographic check is "is this worker's claimed operator DID in the allowlist?" — Riley can't join until Alex adds her DID.

### 1.2 Launch the coordinator

```bash
node packages/coordinator/dist/cli.js
```

First boot mints a fresh `did:key:...` for the coordinator and writes:
- `~/.freeq/bots/swarm-coordinator/key.ed25519` (mode 0600)
- `~/.freeq/bots/swarm-coordinator/delegation.json` (the declarative cert)

You'll see something like:

```
coordinator did: did:key:z6MkABC... (fresh)
delegation: bot=did:key:z6MkABC... creator=did:plc:ALEX_PLC_DID signature=null (declarative)
recovery: 0 in-flight task(s) found
connected as swarm (did=did:key:z6MkABC...)
BUDGET issued: max=5 usd/day per-agent on #freeq-dev
coordinator: phase 1 announce complete, idle
```

### 1.3 Op the coordinator (one-time)

From any IRC client logged in as Alex (the founder DID), run:

```
/mode #freeq-dev +o swarm
```

Freeq writes the coordinator's `did:key` into the channel's persistent op set, so it's auto-opped on every reconnect. This is what unlocks `AGENT PAUSE/RESUME/REVOKE` for the coordinator. Without it, the coordinator can't sandbox a misbehaving worker.

### 1.4 Tell potential participants

Alex posts in the project's README, mailing list, or Bluesky:

> Want to help review PRs in `freeq-org/freeq`? Run a worker:
> ```
> swarm-worker discover --channel #freeq-dev --owner did:plc:YOUR_BLUESKY_DID --yes
> ```
> Then ping me with your DID so I can add you to the allowlist.

That's the entire onboarding spec. Everything else flows from the channel.

### 1.5 Add a participant to the allowlist

When Riley pings Alex with `did:plc:RILEY_PLC_DID`, Alex edits `~/.freeq-swarm/coordinator/coordinator.yaml`:

```yaml
operator_allowlist:
  - did:plc:ALEX_PLC_DID
  - did:plc:RILEY_PLC_DID    # ← added
```

…and restarts the coordinator (`Ctrl+C` then re-launch). Restart is graceful: the dispatcher rebuilds its in-memory timers from SQLite (`recover()` walks `tasks` and re-arms claim windows + execution timers for whatever's in flight).

---

## Part 2: Riley (the participant) — discover, approve, run

Riley has never seen the project's coordinator config and has no idea what model to run, what budget to set, or what repos are in scope. The channel will tell them.

### 2.1 One command to discover the swarm

```bash
swarm-worker discover \
    --channel  #freeq-dev \
    --owner    did:plc:RILEY_PLC_DID \
    --server   irc.freeq.at:6697
```

Under the hood this:
1. Generates an ephemeral `did:key` (no persistence — discovery is read-only).
2. Connects to `irc.freeq.at`, joins `#freeq-dev`.
3. DMs `swarm` (the coordinator nick) the literal message `whoareyou`.
4. Receives a `swarm.discovery/v1` payload as a tagged PRIVMSG.
5. Disconnects and prints the proposed config.

Riley sees:

```
┌─ Discovered swarm: freeq-dev ─────────────────────────────
│  Channel:      #freeq-dev
│  Founder:      did:plc:ALEX_PLC_DID
│  Coordinator:  did:key:z6MkABC... (nick: swarm)
│  Task types:   pr_review
│  Repos:        github.com/freeq-org/*
│  Per-task cap: $0.5
│  Daily cap:    $5/day per worker
└────────────────────────────────────────────────────────────────────

⚠  Your owner DID (did:plc:RILEY_PLC_DID) is NOT in the founder's allowlist.
   Ask did:plc:ALEX_PLC_DID to add you before launching, or your
   capability ad will be ignored by the coordinator.

Proposed ~/.freeq-swarm/worker/worker.yaml:

worker:
  nick_hint: rileys-mac
  swarm_channels:
    - "#freeq-dev"
  freeq_server: irc.freeq.at:6697
  owner_did: did:plc:RILEY_PLC_DID
capabilities:
  task_types:
    - pr_review
  max_concurrent: 1
  languages:
    - typescript
    - rust
    - python
  max_diff_kloc: 10
runtime:
  models:
    - provider: anthropic
      model: claude-opus-4-7
      via: api
constraints:
  allowed_repo_patterns:
    - "github.com/freeq-org/*"
  max_usd_per_task: 0.5
  idle_only: true
governance:
  on_pause: complete_in_flight

(re-run with --yes to write this config to disk)
```

**What's the user being asked to trust?**

- That the **founder DID** (`did:plc:ALEX_PLC_DID`) is who they think it is — they should look it up on bsky.app/profile/<handle>. Riley can verify this is `@alex.bsky.social` before approving.
- That the **coordinator** is delegated by that founder — Riley can verify with `gh api …` no wait, with a freeq REST call: `curl https://irc.freeq.at/api/v1/actors/did:key:z6MkABC...` and check `provenance.creator_did == did:plc:ALEX_PLC_DID`.
- That the **per-task cap** ($0.50) and **daily cap** ($5/day) match what the user is willing to spend.
- That the **allowed repo patterns** only let the worker spend money on PRs Riley approves of (here: `github.com/freeq-org/*`).

If anything looks off, Riley does NOT pass `--yes` and they're done — no key was minted, no config was written.

### 2.2 Get added to the allowlist

If Riley is okay with the terms, they DM Alex (on Bluesky, Slack, whatever) with their DID. Alex edits the coordinator config and restarts. That's the consent step: the founder controls who can spend the channel's budget.

### 2.3 Approve and write the config

```bash
swarm-worker discover --channel #freeq-dev --owner did:plc:RILEY_PLC_DID --yes
```

This time the same flow runs but the proposed YAML is written to `~/.freeq-swarm/worker/worker.yaml`. Riley sees:

```
✓  Your owner DID is in the allowlist — you're cleared to launch.
…
✓ Wrote /Users/riley/.freeq-swarm/worker/worker.yaml
Next: export ANTHROPIC_API_KEY=... && swarm-worker launch
```

### 2.4 Launch the worker

```bash
export ANTHROPIC_API_KEY=sk-ant-...
swarm-worker launch
```

First launch mints `~/.freeq/bots/swarm-worker/{key.ed25519,delegation.json}`. The output:

```
worker did: did:key:z6MkRiley... (fresh)
delegation: bot=did:key:z6MkRiley... creator=did:plc:RILEY_PLC_DID signature=null (declarative)
connected as rileys-mac (did=did:key:z6MkRiley...)
advertised capabilities, transitioned to idle
worker: phase 1 announce complete, idle
```

Riley is now a participant. The worker stays running, sets `PRESENCE :state=idle`, listens for inbound `task_request` events.

### 2.5 What if Riley wants to walk away from the keyboard?

The worker is *designed* to be idle most of the time. It claims work only when:
- It's not currently executing.
- The PR is in `allowed_repo_patterns`.
- The estimated cost is under `max_usd_per_task`.
- Riley's daily budget hasn't been spent (server-enforced via `BUDGET`).

To pause: `Ctrl+C`. To leave running but suspend: founder can `AGENT PAUSE rileys-mac` from any IRC client. To revoke entirely: `AGENT REVOKE rileys-mac` — worker disconnects cleanly, won't reconnect.

---

## Part 3: A PR shows up

Alex needs review on `freeq-org/freeq#473`. From any IRC client in `#freeq-dev`:

```
@swarm review https://github.com/freeq-org/freeq/pull/473
```

What happens, in roughly the order it appears in the channel:

```
[Alex]   @swarm review https://github.com/freeq-org/freeq/pull/473
[swarm]  📋 review github.com/freeq-org/freeq#473 (head abc1234) — claims open 30s
[rileys-mac]  🙋 claiming TASK ...
[other-worker] 🙋 claiming TASK ...
[swarm]  → assigned to rileys-mac, other-worker
[rileys-mac]  ⚙ fetching diff
[other-worker] ⚙ fetching diff
[rileys-mac]  ⚙ reviewing 3 files, 142 LOC
[other-worker] ⚙ reviewing 3 files, 142 LOC
[rileys-mac]  📎 review submitted (verdict=approve_with_comments)
[other-worker] 📎 review submitted (verdict=approve_with_comments)
[swarm]  ✅ TASK ... — verdict=approve_with_comments (consensus 2/2)
```

Total wall clock: ~60s. Total spend across both workers: typically under $0.30 for a small PR.

### What did each side actually pay for?

- **Alex** paid: his time (30 seconds to type the command), and the coordinator's tiny always-on cost. His coordinator never makes Anthropic API calls.
- **Riley** paid: ~$0.13 of Claude API tokens (logged via `SPEND #freeq-dev :amount=0.13;...` which the server tracks against her per-agent BUDGET).

### The morning summary

At 09:00 UTC the next day, Alex gets a DM from `swarm`:

```
☀️ Swarm summary 2026-05-12
  • 7 tasks completed (5 approved)
  • 2 need your attention:
    - 01HZN12345 : consensus_irreconcilable
    - 01HZP12345 : execution_timeout
  • Spend: $0.84 across 12 worker-runs
  • Top contributors: rileys-mac (4), other-worker (3)
  Audit: GET /api/v1/channels/freeq-dev/events?since=1715405100
```

Anything Alex needs to look at is already labeled. The audit URL returns the full structured event log for everything that happened in the channel that day — every claim, every assignment, every per-reviewer evidence.

---

## Operational notes

### Adding more participants

Same flow as Riley — they each `swarm-worker discover --channel #freeq-dev --owner did:plc:THEIR_DID`, ping Alex, get added to the allowlist, then `--yes && swarm-worker launch`. Workers are independent; one going offline doesn't affect the others. v1 expects a small trusted circle (Tier 2 in the design doc).

### Budget guardrails

The server enforces per-DID budgets. If `rileys-mac` spends $5 in one day, the next SPEND triggers `+freeq.at/governance=budget_exceeded` to her, she self-marks `blocked_on_budget`, and the coordinator stops dispatching to her until the next period. No surprise bills.

### Adjusting policy

Founder edits `coordinator.yaml`, restarts. Workers keep running; on the next dispatch they'll respect the new BUDGET (server-side cap). To change `allowed_repo_patterns` everyone sees, the founder updates the channel config — workers don't need to restart, but the next discovery cycle (or a fresh `swarm-worker discover`) will reflect the new patterns.

### Pausing the whole swarm

Founder, from any IRC client:

```
/topic #freeq-dev :swarm paused for maintenance
```

That's just text — to actually halt dispatch, the founder runs `AGENT PAUSE swarm` (which makes the coordinator stop accepting new claims). To halt ALL workers individually: shell script over `AGENT PAUSE <each-nick>`.

### What if the coordinator host goes down?

Tasks already in flight wait for their `execution_timeout_ms` (default 5 min) on the worker side; if no `task_complete` arrives, the worker treats it as best-effort and moves on. When the coordinator comes back, `dispatcher.recover()` rebuilds timers from SQLite — any task in `pending_claims` that's still within window resumes; anything past window deterministically resolves to `no_claims` or `execution_timeout`. No lost state.

### What if a participant goes byzantine?

Sender-DID verification is enforced at the dispatcher: a worker can't post a `task_accept` or `evidence_attach` claiming to be someone else (we check the IRC sender nick → cached DID → matches payload `worker_did`). And the operator-DID allowlist gates participation entirely. If a worker starts producing bad reviews, founder bumps them out of the allowlist, restarts the coordinator, and runs `AGENT REVOKE <their-nick>` for good measure.

---

## Summary

- **Founder**: writes one YAML, runs the coordinator, grants `+o` once, edits the allowlist when new contributors arrive.
- **Participant**: runs `swarm-worker discover` to read the swarm's terms, asks the founder to add their DID, runs `swarm-worker launch`.
- **The channel** carries everything: identity (DIDs in PROVENANCE + capability ads), policy (BUDGET on the channel, allowed_repo_patterns in the discovery payload), and full audit trail (every coordination event persisted by the freeq server, queryable via REST).

If you need to dig into the wire protocol or the design tradeoffs, [`PLAN.md`](./PLAN.md) is the long-form reference. If you're stuck, the [`examples/pr-review/README.md`](./examples/pr-review/README.md) walks the same flow with deliberately small fixture PRs for offline testing.
