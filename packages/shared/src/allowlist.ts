// Operator allowlist, read live from the `operator_allowlist` field of
// coordinator.yaml via @freeq/bot-kit's createDidMap.
//
// Single config file: the allowlist stays in coordinator.yaml (validated by
// the zod schema in policy.ts like every other field). createDidMap's file
// source points at coordinator.yaml itself; its parse fn yaml-loads the file
// and extracts `operator_allowlist`. The mtime poll means editing the
// allowlist block in coordinator.yaml takes effect within ~2s, no restart —
// other yaml fields still require a restart, which is correct.
//
// Read-only: there is no runtime grant/revoke API (none existed pre-
// migration either). The founder edits coordinator.yaml directly.

import { createDidMap, type DidMapReadOnly } from '@freeq/bot-kit';
import { load as yamlLoad } from 'js-yaml';

export interface OperatorEntry {
  did: string;
}

export type OperatorAllowlist = DidMapReadOnly<OperatorEntry>;

function parseAllowlistFromYaml(raw: string): OperatorEntry[] {
  const doc = yamlLoad(raw) as { operator_allowlist?: unknown } | null;
  const list = doc?.operator_allowlist;
  if (!Array.isArray(list)) {
    throw new Error('coordinator.yaml: operator_allowlist must be an array');
  }
  return list
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((did) => ({ did }));
}

/**
 * Load the operator allowlist from coordinator.yaml. Returns a read-only
 * DidMap whose file source polls the yaml's mtime, so edits to the
 * `operator_allowlist` block apply live.
 */
export async function loadOperatorAllowlist(args: {
  configPath: string;
}): Promise<OperatorAllowlist> {
  return createDidMap<OperatorEntry>({
    load: { path: args.configPath, parse: parseAllowlistFromYaml },
  });
}

/**
 * Build an OperatorAllowlist from a static DID list (createDidMap's
 * array source — no file, no poll). Used where the allowlist is in
 * memory rather than on disk: tests, and any future static-config path.
 */
export function operatorAllowlistFromDids(dids: readonly string[]): Promise<OperatorAllowlist> {
  return createDidMap<OperatorEntry>({ load: dids.map((did) => ({ did })) });
}
