// FreeqBotDelegation/v1 cert. v1 ships unsigned (signature: null).
// Format matches freeq-bot-id/src/main.rs:69-87 and freeqcc/src/delegation.ts.
// Server stores cert with provenance._verified = false; trust gate is the
// operator-DID allowlist, not the cert signature (PLAN §4.1, §4.2).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentIdentity } from './identity.js';

export interface DelegationCert {
  type: 'FreeqBotDelegation/v1';
  bot_did: string;
  /** Multibase ed25519 pubkey — the part after `did:key:`. */
  bot_public_key: string;
  creator_did: string;
  created_at: string;
  revocation_authority: string;
  /** v1 always null (declarative). */
  signature: string | null;
}

export async function loadDelegation(certPath: string): Promise<DelegationCert | null> {
  let raw: string;
  try {
    raw = await readFile(certPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: DelegationCert;
  try {
    parsed = JSON.parse(raw) as DelegationCert;
  } catch {
    throw new Error(`${certPath} is not valid JSON. Delete to regenerate.`);
  }
  if (parsed.type !== 'FreeqBotDelegation/v1') {
    throw new Error(
      `${certPath} has type ${parsed.type}; expected FreeqBotDelegation/v1.`,
    );
  }
  return parsed;
}

export function buildDelegation(args: {
  agent: AgentIdentity;
  ownerDid: string;
}): DelegationCert {
  const bot_public_key = args.agent.did.replace(/^did:key:/, '');
  if (bot_public_key === args.agent.did) {
    throw new Error(
      `Agent DID does not start with did:key: — got ${args.agent.did}.`,
    );
  }
  return {
    type: 'FreeqBotDelegation/v1',
    bot_did: args.agent.did,
    bot_public_key,
    creator_did: args.ownerDid,
    created_at: new Date().toISOString(),
    revocation_authority: args.ownerDid,
    signature: null,
  };
}

export async function loadOrMintDelegation(args: {
  agent: AgentIdentity;
  ownerDid: string;
  certPath: string;
}): Promise<DelegationCert> {
  const existing = await loadDelegation(args.certPath);
  if (existing) {
    if (existing.bot_did !== args.agent.did) {
      throw new Error(
        `Stored delegation bot_did (${existing.bot_did}) does not match current agent ` +
          `(${args.agent.did}). Delete ${args.certPath} to regenerate.`,
      );
    }
    if (existing.creator_did !== args.ownerDid) {
      throw new Error(
        `Stored delegation creator_did (${existing.creator_did}) does not match current ` +
          `owner (${args.ownerDid}). Delete ${args.certPath} to regenerate.`,
      );
    }
    return existing;
  }
  const cert = buildDelegation({ agent: args.agent, ownerDid: args.ownerDid });
  await mkdir(dirname(args.certPath), { recursive: true, mode: 0o700 });
  await writeFile(args.certPath, `${JSON.stringify(cert, null, 2)}\n`, { mode: 0o600 });
  return cert;
}
