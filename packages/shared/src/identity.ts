// did:key identity persisted across runs. Mirrors freeqcc/src/identity.ts.
// 32-byte ed25519 seed file, mode 0600.
import { generateDidKey, importDidKey, type DidKey } from '@freeq/sdk';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AgentIdentity {
  /** `did:key:z…` */
  did: string;
  didKey: DidKey;
  /** True iff this run generated the key (first launch). */
  isFresh: boolean;
}

export async function loadOrCreateIdentity(seedPath: string): Promise<AgentIdentity> {
  await mkdir(dirname(seedPath), { recursive: true, mode: 0o700 });
  const seed = await readSeedIfPresent(seedPath);
  if (seed) {
    const didKey = await importDidKey(seed);
    return { did: didKey.did, didKey, isFresh: false };
  }
  const didKey = await generateDidKey();
  const newSeed = await didKey.exportSeed();
  await writeFile(seedPath, newSeed, { mode: 0o600 });
  await chmod(seedPath, 0o600);
  return { did: didKey.did, didKey, isFresh: true };
}

async function readSeedIfPresent(seedPath: string): Promise<Uint8Array | null> {
  let buf: Buffer;
  try {
    buf = await readFile(seedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (buf.length !== 32) {
    throw new Error(
      `${seedPath} is ${buf.length} bytes, expected 32 (ed25519 seed). ` +
        `Delete it to regenerate, or restore the original.`,
    );
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
