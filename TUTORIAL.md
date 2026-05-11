# freeq-swarm tutorial: stand up an open-source software factory

A "software factory" here means: maintainers file issues, distributed Claude workers pick them up, fix them, and open pull requests. The maintainer reviews and merges. This tutorial walks you through standing one up for your project.

We'll use a running example: **Alex** maintains `freeq-org/freeq` and wants help working through the backlog. **Riley** is a contributor who has Claude credit and idle laptops. They've never met in person, never exchanged API keys. After ten minutes of setup, Alex files issues like normal and Riley's machines turn them into PRs.

This tutorial follows three roles:

1. **Alex (founder)** — set up the channel, run the coordinator, invite participants.
2. **Riley (participant)** — discover the channel, accept its terms, run a worker that produces PRs.
3. **Both** — what happens when an issue gets filed.

The full architecture is in [`PLAN.md`](./PLAN.md). This page is the operator's guide.

---

## What each role brings to the table

| | Founder (Alex) | Participant (Riley) |
|---|---|---|
| Identity | A `did:plc:...` (your Bluesky DID) | A `did:plc:...` (your Bluesky DID) |
| Always-on host | Yes — coordinator must stay up | No — laptops welcome |
| GitHub auth | `gh` authed against the project repo | `gh` authed against Riley's *own* GitHub account (so workers can fork + push) |
| Anthropic auth | No (unless Alex also runs a worker) | Yes — `claude` CLI logged in OR `ANTHROPIC_API_KEY` |
| Op privilege on `#freeq-dev` | Yes (one-time `MODE +o`) | No |
| Persistent state | `~/.freeq/bots/swarm-coordinator/`, `~/.freeq-swarm/coordinator/` | `~/.freeq/bots/swarm-worker/`, `~/.freeq-swarm/worker/` |

Workers fork upstream repos under their *own* GitHub account and open cross-fork PRs. Riley never needs write access to `freeq-org/freeq` — the standard OSS-contributor flow.

---

## Part 1: Alex (the founder) — stand up the factory

### 1.1 Write the coordinator config

Alex picks `#freeq-dev` because the project is `freeq-org/freeq`. The naming convention is just `#<project>-dev`.

```bash
mkdir -p ~/.freeq-swarm/coordinator
cat > ~/.freeq-swarm/coordinator/coordinator.yaml <<'YAML'
swarm:
  channel: "#freeq-dev"
  founder_did: did:plc:ALEX_PLC_DID            # ← your Bluesky DID
  coordinator_nick: swarm
  freeq_server: irc.freeq.at:6697
operator_allowlist:
  - did:plc:ALEX_PLC_DID
  # add did:plc:RILEY_PLC_DID once Riley joins
task_types:
  issue_fix:
    reviewers_needed: 1                         # first-claim-wins for fixes
    claim_window_ms: 30000
    execution_timeout_ms: 1800000               # 30 min — agentic runs take time
    max_usd_per_reviewer: 5.00                  # per-fix cap
    allowed_repo_patterns:
      - "github.com/freeq-org/*"
    max_retries_on_timeout: 1
budget:
  daily_usd_per_agent: 20                       # ~4 fixes/day per worker
summary:
  default_tz: "UTC"
  default_time: "09:00"
  per_requester_tz: {}
YAML
```

A few choices worth flagging:

- **`reviewers_needed: 1`.** Writing code is expensive, so first-claim-wins. (Reviewing was cheap so we used 2-of-N consensus there.)
- **`execution_timeout_ms: 1_800_000`.** 30 minutes — that's how long an agentic Claude run on a non-trivial issue might take.
- **`max_usd_per_reviewer: 5.00`.** Generous per-fix budget; workers self-cap too.
- **`allowed_repo_patterns`.** This is the policy gate that prevents a worker from being asked to spend money on a repo Alex didn't sanction.

### 1.2 Launch the coordinator

```bash
node packages/coordinator/dist/cli.js
```

First boot mints a fresh `did:key:...` for the coordinator and writes:
- `~/.freeq/bots/swarm-coordinator/key.ed25519` (mode 0600)
- `~/.freeq/bots/swarm-coordinator/delegation.json` (declarative cert)

Output:

```
coordinator did: did:key:z6MkABC... (fresh)
delegation: bot=did:key:z6MkABC... creator=did:plc:ALEX_PLC_DID signature=null (declarative)
recovery: 0 in-flight task(s) found
connected as swarm (did=did:key:z6MkABC...)
BUDGET issued: max=20 usd/day per-agent on #freeq-dev
coordinator: phase 1 announce complete, idle
```

### 1.3 Op the coordinator (one-time)

From any IRC client logged in as Alex (the founder's Bluesky DID), run:

```
/mode #freeq-dev +o swarm
```

Freeq records the coordinator's `did:key` as a persistent channel op. From then on it's auto-opped on every reconnect. This unlocks `AGENT PAUSE/RESUME/REVOKE` against misbehaving workers.

### 1.4 Tell people how to join

Alex posts in the project's README:

```
This project uses freeq-swarm. Want to help fix issues?

  swarm-worker discover --channel #freeq-dev --owner did:plc:YOUR_BLUESKY_DID --yes

Then ping me with your DID so I can add you to the allowlist.
```

### 1.5 Add a participant to the allowlist

When Riley pings Alex with `did:plc:RILEY_PLC_DID`, Alex appends it:

```yaml
operator_allowlist:
  - did:plc:ALEX_PLC_DID
  - did:plc:RILEY_PLC_DID    # ← added
```

…and restarts the coordinator. Restart is graceful — `dispatcher.recover()` walks SQLite and re-arms timers for whatever's in flight.

---

## Part 2: Riley (the participant) — discover, approve, run

### 2.1 Discover the swarm

Riley runs:

```bash
swarm-worker discover \
    --channel  #freeq-dev \
    --owner    did:plc:RILEY_PLC_DID \
    --server   irc.freeq.at:6697
```

This connects with an ephemeral `did:key`, joins the channel, DMs `swarm` the literal message `whoareyou`, and prints what comes back:

```
┌─ Discovered swarm: freeq-dev ─────────────────────────────
│  Channel:      #freeq-dev
│  Founder:      did:plc:ALEX_PLC_DID
│  Coordinator:  did:key:z6MkABC... (nick: swarm)
│  Task types:   issue_fix
│  Repos:        github.com/freeq-org/*
│  Per-task cap: $5
│  Daily cap:    $20/day per worker
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
    - issue_fix
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
      via: cli                      # ← shells out to `claude`, runs agentic
constraints:
  allowed_repo_patterns:
    - "github.com/freeq-org/*"
  max_usd_per_task: 5
  idle_only: true
governance:
  on_pause: complete_in_flight

(re-run with --yes to write this config to disk)
```

**What's Riley being asked to trust before approving?**

1. **The founder's identity.** Riley can look up `did:plc:ALEX_PLC_DID` on `bsky.app/profile/...` and confirm it's Alex.
2. **The coordinator's delegation.** `curl https://irc.freeq.at/api/v1/actors/did:key:z6MkABC...` returns the coordinator's PROVENANCE record; `creator_did` should equal Alex's DID.
3. **The repo allowlist.** `github.com/freeq-org/*` — Riley's worker won't burn money on any repo outside this pattern.
4. **The budget caps.** Per-task $5, per-day $20. The freeq server enforces these — once Riley's worker hits $20 of spend in a day, it's blocked until the next budget period.

If anything looks wrong, Riley does NOT pass `--yes`. No keys were minted, no config was written.

### 2.2 Get into the allowlist

If the terms look good, Riley DMs Alex with their DID. Alex edits the config and restarts. That consent step is the trust handshake.

### 2.3 Approve + write the config

```bash
swarm-worker discover --channel #freeq-dev --owner did:plc:RILEY_PLC_DID --yes
```

Same flow, but this time the proposed YAML is written to `~/.freeq-swarm/worker/worker.yaml`:

```
✓  Your owner DID is in the allowlist — you're cleared to launch.
…
✓ Wrote /Users/riley/.freeq-swarm/worker/worker.yaml
Next: claude login   (or export ANTHROPIC_API_KEY=...)
      gh auth login  (worker pushes branches to YOUR github fork)
      swarm-worker launch
```

### 2.4 Set up `claude` and `gh`

Riley's worker needs two things authenticated on the machine it's running on:

- **`claude` CLI** authenticated against Riley's Anthropic account. The default config in §2.3 used `via: cli`, which shells out to `claude -p ... --output-format json` for the agentic edit step. This means Claude runs as Riley would — same model access, same usage limits, same audit trail in their Anthropic dashboard.
- **`gh` CLI** authenticated against Riley's GitHub account. Workers `gh repo fork` the upstream and `git push` to Riley's fork, then `gh pr create` opens a cross-fork PR. No write access to `freeq-org/freeq` required.

```bash
claude login         # opens browser, paste API key, etc.
gh auth login        # GitHub OAuth dance
```

### 2.5 Launch the worker

```bash
swarm-worker launch
```

First launch mints `~/.freeq/bots/swarm-worker/{key.ed25519,delegation.json}`. Output:

```
worker did: did:key:z6MkRiley... (fresh)
delegation: bot=did:key:z6MkRiley... creator=did:plc:RILEY_PLC_DID signature=null
connected as rileys-mac (did=did:key:z6MkRiley...)
advertised capabilities, transitioned to idle
worker: phase 1 announce complete, idle
```

Riley is now a participant. The worker stays online, idle, listening for `task_request` events.

---

## Part 3: An issue shows up

Alex needs to add a `/healthz` endpoint to the freeq server. From any IRC client in `#freeq-dev`:

```
@swarm fix https://github.com/freeq-org/freeq/issues/123
```

(Optionally with `test_command="cargo test"` if Alex wants the worker to verify changes before opening the PR.)

Here's what plays out in the channel, roughly in order:

```
[Alex]         @swarm fix https://github.com/freeq-org/freeq/issues/123
[swarm]        🛠 fix freeq-org/freeq#123 "Add /healthz endpoint to the server" — claim opens 30s
[rileys-mac]   🙋 claiming TASK ...
[swarm]        → assigned to rileys-mac
[rileys-mac]   ⚙ cloning freeq-org/freeq...
[rileys-mac]   ⚙ running claude (model=claude-opus-4-7, max_turns=30)
                  (this step takes 5-20 min depending on the issue)
[rileys-mac]   ⚙ running tests: cargo test
[rileys-mac]   🚀 PR opened: https://github.com/freeq-org/freeq/pull/451
[swarm]        🚀 TASK ... → https://github.com/freeq-org/freeq/pull/451
```

What just happened on Riley's machine:

1. The worker received `task_request` with `task_type: issue_fix`.
2. It evaluated eligibility: idle, no in-flight tasks, repo matches, est cost OK.
3. Posted `task_accept`.
4. Coordinator assigned it (no other workers were idle).
5. The worker created a temp directory, ran `gh repo clone freeq-org/freeq`.
6. Checked out the base branch, made a new branch `freeq-swarm/fix-01HZN...`.
7. Built a prompt from the issue title/body + the system prompt at `executors/issue_fix.prompt.md` and ran:
   ```
   claude -p '<prompt>' --output-format json --max-turns 30 \
          --model claude-opus-4-7 \
          --allowedTools 'Read,Edit,Write,Bash,Grep,Glob' \
          --append-system-prompt '<system-prompt>'
   ```
   in the cloned repo's working directory. Claude reads files, runs the build, edits, repeats — fully agentic.
8. Verified `git diff --stat` was non-empty.
9. Ran `cargo test` (because Alex passed `test_command`). Captured pass/fail + log tail.
10. Committed the diff with a structured message.
11. `gh repo fork freeq-org/freeq` to ensure Riley's fork exists.
12. `git push https://github.com/riley/freeq.git HEAD:freeq-swarm/fix-01HZN... --force-with-lease`.
13. `gh pr create --repo freeq-org/freeq --base main --head riley:freeq-swarm/fix-01HZN... --title ... --body ...`.
14. Captured the PR URL.
15. Posted `evidence_attach` with the swarm.submission/v1 payload and a `SPEND` for the actual Anthropic cost.
16. Coordinator finalized the task as complete, pointed at the PR.
17. Worker cleared the workspace and went back to `idle`.

Alex sees a new PR with:
- Title: `Fix #123: Add /healthz endpoint to the server`
- Body:
  ```
  Closes #123.

  _Generated by freeq-swarm worker_
  _Operator DID: did:key:z6MkRiley..._
  _Task: 01HZN12345..._

  Tests: `cargo test` → passed
  ```
- A focused commit doing one thing.

Alex reviews it like any other PR. If it's good, they merge. If it's wrong, they comment — and (importantly) the worker is gone; this isn't an interactive session. To get changes, Alex re-files: `@swarm fix https://github.com/freeq-org/freeq/issues/123` opens a fresh attempt.

### What did each side pay for?

- **Alex** paid: his time (writing one issue + reviewing one PR) and the coordinator's tiny always-on cost.
- **Riley** paid: ~$1–3 of Claude API tokens (logged via `SPEND #freeq-dev :amount=2.13;...` which the freeq server tracks against her per-agent BUDGET).

### The morning summary

At 09:00 UTC the next day, Alex gets a DM from `swarm`:

```
☀️ Swarm summary 2026-05-12
  • 7 tasks completed (6 submitted PRs)
  • 1 needs your attention:
    - 01HZN12345 : all_workers_failed — claude couldn't reproduce the bug
  • Spend: $11.20 across 7 worker-runs
  • Top contributors: rileys-mac (4), other-worker (3)
  Audit: GET /api/v1/channels/freeq-dev/events?since=1715405100
```

Each completed task links to a PR Alex can review. The one failure tells him what to look at and why.

---

## Recipes

### Filing several issues at once

Just post several lines. Workers race-claim each one independently:

```
@swarm fix https://github.com/freeq-org/freeq/issues/100
@swarm fix https://github.com/freeq-org/freeq/issues/101
@swarm fix https://github.com/freeq-org/freeq/issues/102 test_command="npm test"
@swarm fix https://github.com/freeq-org/freeq/issues/103
```

Each worker is `max_concurrent: 1` so a single Riley-laptop processes them serially. Add more workers (more contributors, or Riley running multiple) and they parallelize.

### Coupling it to GitHub Actions

Alex can wire a GitHub Action that posts a swarm task whenever a label like `good-first-issue` lands on an issue. The Action runs `curl` against a small bot or a manually-authed irssi instance to post `@swarm fix <issue-url>` in `#freeq-dev`. From the swarm's perspective it's just another task request from an allowlisted DID.

### Steering the agent

Two knobs:

- **The issue body itself.** Be specific. "Add a /healthz endpoint that returns 200 OK and a JSON body with version and uptime" is much more likely to produce a usable PR than "add health checks". The system prompt at `packages/worker/src/executors/issue_fix.prompt.md` tells Claude to "stay focused, match existing conventions, write tests if the project has them" — combine that with a clear issue and you get small, mergeable PRs.
- **`test_command` flag.** If you pass `test_command="..."`, the worker runs it before opening the PR. The result is included in the PR body and in the submission verdict (`submitted` vs `failed_tests`). For projects with fast test suites, this dramatically increases PR quality.

```
@swarm fix https://github.com/freeq-org/freeq/issues/123 test_command="cargo test --lib"
@swarm fix https://github.com/freeq-org/freeq/issues/123 max_turns=50
@swarm fix https://github.com/freeq-org/freeq/issues/123 base_branch=develop
```

### Stopping a runaway worker

The freeq server enforces budgets, but if Alex wants to halt a specific worker immediately:

```
/AGENT PAUSE rileys-mac
```

(Alex must be op on the channel — which the coordinator-grant in §1.3 handles for the coordinator. Alex was the one who granted that op, so Alex is op too via channel founder.)

Pause is graceful: the worker finishes the in-flight task, then stops claiming new ones. `AGENT RESUME rileys-mac` unblocks. `AGENT REVOKE rileys-mac` force-disconnects and the worker won't reconnect on its own.

### Adjusting policy without a coordinator restart

Most config changes require a coordinator restart, but two important ones don't:

- **`BUDGET #freeq-dev :max=...`** can be issued live from any IRC client (as the coordinator nick or a chanop). The freeq server picks it up immediately.
- **Adding repos to `allowed_repo_patterns`** does require restart, but the coordinator's recovery scan handles in-flight tasks cleanly.

### What if Riley wants to walk away from the keyboard?

That's the design. Workers are idle most of the time. They claim only when:
- Not currently executing.
- Repo is in the allowlist.
- Estimated cost is under `max_usd_per_task`.
- Daily spend hasn't hit the budget cap.

`Ctrl+C` shuts down cleanly. Server-side `AGENT PAUSE` or `AGENT REVOKE` works from anywhere too.

---

## Operational notes

### Multiple participants

Same flow as Riley — each contributor `swarm-worker discover` → ping founder → get added to allowlist → `--yes && swarm-worker launch`. Workers are independent; one going down doesn't affect the others. Two workers seeing the same issue race-claim; first claim wins (coordinator's oldest-claim-wins selector handles ties deterministically with a hash tiebreak).

### Sandboxing

The `claude` CLI runs agentic in a worker process, with `Bash` and `Edit` tools. Riley is consenting to that — `claude` operates in the worker's tmpdir on Riley's machine, with whatever sandboxing `claude` provides (file scope to cwd by default).

For higher-security setups, run the worker inside a Docker container with the workspace mounted as a tmpfs and network egress restricted to `api.anthropic.com` + `github.com`. v1 documents this as the operator's responsibility; v2 will ship a `docker run` wrapper.

### Coordinator host going down

Tasks already assigned wait for their `execution_timeout_ms` (default 30 min for `issue_fix`) on the worker side. If no `task_complete` comes back, the worker just finishes locally — its PR was already opened, the coordination event is fire-and-forget at that point.

When the coordinator restarts, `dispatcher.recover()` walks SQLite and re-arms timers. Any `pending_claims` still within window resumes. Anything past window resolves deterministically.

### Byzantine workers

Sender-DID verification at the dispatcher means a worker can't post a `task_accept` or `evidence_attach` claiming to be someone else. The operator-DID allowlist gates participation. If a worker starts producing bad PRs, founder removes them from the allowlist, restarts the coordinator, and `AGENT REVOKE`s them for good measure. Their PRs are still in their fork — the upstream isn't affected because the worker never had push access.

### What if the worker's PR is wrong?

It happens. Treat them like contributions from a new (and tireless) human contributor — leave a review, comment with concrete asks, close if the approach is wrong. The next `@swarm fix` invocation will be a fresh attempt; agents have no memory of past failures (v1).

---

## Summary

- **Founder**: writes a coordinator.yaml, runs the daemon, grants `+o` once, edits the allowlist when new contributors arrive. Files issues. Reviews PRs.
- **Participant**: runs `swarm-worker discover` to read the swarm's terms, asks the founder to add their DID, authenticates `claude` and `gh`, runs `swarm-worker launch`. Forgets about it.
- **The channel** carries everything: identity, policy, full audit trail.

If you want to dig into wire formats or design tradeoffs, [`PLAN.md`](./PLAN.md) is the long-form reference. If you're stuck during a demo, see [`examples/pr-review/README.md`](./examples/pr-review/README.md) for the older PR-review flow which uses checked-in fixtures.
