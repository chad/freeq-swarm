# Example: PR-review swarm walkthrough

This walks through one full review cycle from human ask to morning
summary.

## Prerequisites

You'll need:

1. A freeq account on `irc.freeq.at` (your `did:plc:...` from Bluesky).
2. `gh` authenticated against the GitHub repos you want reviewed.
3. `ANTHROPIC_API_KEY` exported in the worker's environment.
4. This repo built (`pnpm install && pnpm build`).

## Step 1: write the configs

```bash
mkdir -p ~/.freeq-swarm/coordinator ~/.freeq-swarm/worker

# coordinator config
cat > ~/.freeq-swarm/coordinator/coordinator.yaml <<'YAML'
swarm:
  channel: "#swarm-test"
  founder_did: did:plc:YOUR_PLC_DID
  coordinator_nick: swarm
  freeq_server: irc.freeq.at:6697
operator_allowlist:
  - did:plc:YOUR_PLC_DID
task_types:
  pr_review:
    reviewers_needed: 2
    claim_window_ms: 30000
    execution_timeout_ms: 300000
    max_usd_per_reviewer: 0.50
    allowed_repo_patterns:
      - "github.com/YOUR_ORG/*"
    max_retries_on_timeout: 1
budget:
  daily_usd_per_agent: 2
summary:
  default_tz: "UTC"
  default_time: "09:00"
  per_requester_tz: {}
YAML

# worker config — repeat per machine, with a unique nick_hint each time
cat > ~/.freeq-swarm/worker/worker.yaml <<'YAML'
worker:
  nick_hint: $(hostname)
  swarm_channels: ["#swarm-test"]
  freeq_server: irc.freeq.at:6697
  owner_did: did:plc:YOUR_PLC_DID
capabilities:
  task_types: [pr_review]
  max_concurrent: 1
  languages: [typescript, python, rust]
  max_diff_kloc: 5
runtime:
  models:
    - provider: anthropic
      model: claude-opus-4-7
      via: api
constraints:
  allowed_repo_patterns:
    - "github.com/YOUR_ORG/*"
  max_usd_per_task: 0.50
  idle_only: true
governance:
  on_pause: complete_in_flight
YAML
```

Replace `YOUR_PLC_DID` and `YOUR_ORG` with your values.

## Step 2: launch the coordinator

```bash
node packages/coordinator/dist/cli.js
```

You should see something like:

```
coordinator config: channel=#swarm-test nick=swarm founder=did:plc:...
coordinator did: did:key:z6Mk... (fresh)
delegation: bot=did:key:z6Mk... creator=did:plc:... signature=null (declarative)
recovery: 0 in-flight task(s) found
connected as swarm (did=did:key:z6Mk...)
BUDGET issued: max=2 usd/day per-agent on #swarm-test
coordinator: phase 1 announce complete, idle
budget snapshot: cap=2 usd/per_day, 0 agent(s) with spend
```

From any IRC client logged in as the founder, op the coordinator once:

```
/mode #swarm-test +o swarm
```

## Step 3: launch one or more workers

On each machine that should contribute (laptop, server, etc.):

```bash
ANTHROPIC_API_KEY=sk-ant-... node packages/worker/dist/cli.js
```

You should see:

```
worker config: nick=mybox channels=#swarm-test owner=did:plc:...
worker did: did:key:z6Mk... (fresh)
delegation: bot=... creator=... signature=null (declarative)
connected as mybox (did=did:key:z6Mk...)
advertised capabilities, transitioned to idle
worker: phase 1 announce complete, idle
```

## Step 4: post a task

From an IRC client logged in as the founder (or any allowlisted DID),
join `#swarm-test` and type:

```
@swarm review https://github.com/YOUR_ORG/YOUR_REPO/pull/42
```

You should observe (in any freeq client connected to the channel) a
sequence of cards:

- `📋 task_request` from the coordinator
- `🙋 task_accept` from each idle worker
- `→ assigned to ...` from the coordinator
- `⚙ fetching diff` then `⚙ reviewing` task_update progress events from
  each assigned worker
- `📎 evidence_attach` (`code_review` evidence) from each worker
- `✅ task_complete` from the coordinator with the consensus verdict

Inspect the audit log:

```bash
curl https://irc.freeq.at/api/v1/channels/swarm-test/events?since=$(date -u +%s -d '5 min ago')
```

## Step 5: morning summary

The coordinator runs an in-process scheduler. By default it fires at
09:00 UTC for each operator-allowlist DID and DMs them a 24h summary.

To trigger one immediately for testing, run with a small modification
of `summary.default_time` set 2 minutes in the future, restart, and
wait.

## Troubleshooting

- **"could not resolve your DID via WHOIS — refusing task"** — the
  coordinator's did_resolver couldn't get a 330 WHOIS reply for your
  nick within 3 s. Make sure you authenticated via SASL, then try again.
- **`task_failed :reason=ingestion_error :detail=auth_error`** — `gh`
  isn't authenticated on the coordinator host (or the host that runs
  ingestion). `gh auth login` first.
- **`task_failed :reason=head_sha_lost`** — someone force-pushed the PR
  between ingestion and execution. v1 requires you to repost.
- **`task_failed :reason=diff_too_large`** — the PR has ≥300 files or
  contains a binary file too big for GitHub's compare API to inline.
- **Worker stays in `online` and never claims** — the worker advertises
  capabilities only after channel JOIN; check `presence.state` via
  `GET /api/v1/actors/<worker-did>`. Should be `idle`.
