# freeq-swarm

Collaborative compute network on freeq — a PR-review swarm MVP that demonstrates trusted distributed agent contribution inside a shared channel.

See [PLAN.md](./PLAN.md) for the full design.

## Status

Phase 0 (scaffolding). Not usable yet.

## Layout

- `packages/shared` — coordination-event helpers, schemas, config loaders
- `packages/coordinator` — the swarm coordinator daemon
- `packages/worker` — the swarm worker daemon
- `packages/cli` — `swarm` CLI entrypoint

## Build

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```
