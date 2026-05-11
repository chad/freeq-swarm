// Build the swarm.capabilities/v1 payload from worker config + identity.
import type { CapabilityAdvertisement, WorkerConfig } from '@freeq-swarm/shared';

export function buildCapabilityAdvertisement(args: {
  workerDid: string;
  ownerDid: string;
  config: WorkerConfig;
}): CapabilityAdvertisement {
  return {
    kind: 'swarm.capabilities/v1',
    worker_did: args.workerDid,
    operator_did: args.ownerDid,
    advertised: {
      task_types: args.config.capabilities.task_types,
      models: args.config.runtime.models,
      max_concurrent: args.config.capabilities.max_concurrent,
      languages: args.config.capabilities.languages,
      max_diff_kloc: args.config.capabilities.max_diff_kloc,
    },
    constraints: {
      allowed_repo_patterns: args.config.constraints.allowed_repo_patterns,
      max_usd_per_task: args.config.constraints.max_usd_per_task,
      idle_only: args.config.constraints.idle_only,
    },
  };
}
