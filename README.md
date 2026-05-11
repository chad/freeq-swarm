# freeq-swarm

A PR-review swarm built on [freeq](https://github.com/freeq-org). Multiple
worker daemons race-claim review tasks posted in a shared IRC channel,
each runs a structured review through Claude, and the coordinator picks
a consensus verdict. Morning summaries land as DMs.

See [PLAN.md](./PLAN.md) for the full design rationale and the three
rounds of editorial review against the freeq source.

---

## What it is, in three pictures

```
1. Human posts in #swarm:                     #swarm
                                                │
   @swarm review github.com/foo/bar#42         │ ▼
                                              ┌───────────────────┐
                                              │ swarm-coordinator │
                                              │  - resolves head_sha
                                              │  - posts task_request
                                              │  - tracks assignments
                                              │  - runs consensus
                                              └───────────────────┘
                                                │      │      │
                                                ▼      ▼      ▼
                                            ┌──────┐ ┌──────┐ ┌──────┐
                                            │Worker│ │Worker│ │Worker│
                                            │  A   │ │  B   │ │  C   │
                                            └──────┘ └──────┘ └──────┘

2. Two idle workers race-claim, run review through Claude, post evidence.

3. Coordinator runs consensus → posts task_complete with verdict.
   Morning DM summarizes the previous 24h.
```

## Status

Phases 0–7 implemented; ~180 unit tests pass. Live demo against
`irc.freeq.at` requires founder-side `MODE +o` grant on the swarm
channel after the coordinator's first JOIN — see "Going live" below.

## Layout

- `packages/shared` — coordination-event helpers, schemas, config loaders,
  did-key identity / delegation cert handling, did↔nick resolver,
  governance signal parser, announce sequence.
- `packages/coordinator` — the swarm-coordinator daemon; SQLite schema;
  task ingestion; claim collection + assignment dispatcher; consensus
  verifier; morning-summary scheduler.
- `packages/worker` — the swarm-worker daemon; capability advertisement;
  task claimer; SHA-pinned diff fetcher; PR-review executor (Anthropic
  SDK); SPEND emitter; governance signal handler.
- `packages/cli` — single `swarm` CLI entrypoint dispatching to either
  daemon.
- `examples/pr-review/` — walkthrough + fixture diff for offline tests.

## Build

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

This is a TypeScript pnpm workspace; Node 22+ is required. The
`@freeq/sdk` dependency is pulled from `../freeq/freeq-sdk-js` (sibling
clone of the freeq repo).

## Configure

Two YAML files, one per daemon. Both live under `~/.freeq-swarm/` by
default; override with `$FREEQ_SWARM_HOME`.

`coordinator/coordinator.yaml`:

```yaml
swarm:
  channel: "#swarm"
  founder_did: did:plc:abc...
  coordinator_nick: swarm
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
      - "github.com/your-org/*"
    max_retries_on_timeout: 1
budget:
  daily_usd_per_agent: 5
summary:
  default_tz: "UTC"
  default_time: "09:00"
  per_requester_tz: {}
```

`worker/worker.yaml`:

```yaml
worker:
  nick_hint: alice-laptop-1
  swarm_channels:
    - "#swarm"
  freeq_server: irc.freeq.at:6697
  owner_did: did:plc:def...
capabilities:
  task_types: [pr_review]
  max_concurrent: 1
  languages: [typescript, rust, python]
  max_diff_kloc: 10
runtime:
  models:
    - provider: anthropic
      model: claude-opus-4-7
      via: api
constraints:
  allowed_repo_patterns:
    - "github.com/your-org/*"
  max_usd_per_task: 1.50
  idle_only: true
governance:
  on_pause: complete_in_flight
```

You will also need:

- `gh` CLI authenticated against the GitHub repos in your allowlist
  (the worker shells out for diff fetching).
- `ANTHROPIC_API_KEY` in the worker's environment (only required for
  `runtime.models[].via: api`; CLI-mode workers shell out to `claude`).

## Run

The first launch of each daemon mints its own ed25519 did:key and a
declarative `FreeqBotDelegation/v1` cert (unsigned in v1; trust gate
is the operator-allowlist, not the cert signature). Cert + key land in
`~/.freeq/bots/swarm-{coordinator,worker}/` per the `freeq-bot-id`
canonical layout.

```bash
# Coordinator
node packages/coordinator/dist/cli.js

# Worker
node packages/worker/dist/cli.js
```

Or via the CLI:

```bash
node packages/cli/dist/index.js coordinator
node packages/cli/dist/index.js worker
```

## Going live (one-time founder steps)

After the coordinator's first JOIN, the founder must `MODE +o` it once
so it can use freeq governance commands (`AGENT PAUSE/RESUME/REVOKE`).
From any IRC client logged into the founder's PLC DID:

```
/mode #swarm +o swarm
```

The server records the coordinator's did:key into `chan.did_ops`; from
then on the coordinator is auto-opped on every JOIN.

The coordinator issues the per-agent BUDGET on every startup; check it
with `GET https://irc.freeq.at/api/v1/channels/swarm/budget`.

## Posting a task

In `#swarm`, addressed to the coordinator nick:

```
@swarm review https://github.com/your-org/your-repo/pull/42
@swarm review https://github.com/your-org/your-repo/pull/42 reviewers=3 priority=high
```

Whitelisted flags: `reviewers`, `priority`, `model`. Unknown flags get
a NOTICE refusal back to the requester.

## Demo

A short walkthrough (commands + expected channel output) lives in
[`examples/pr-review/README.md`](examples/pr-review/README.md).

## License

MIT.
