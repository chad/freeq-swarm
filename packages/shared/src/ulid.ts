import { ulid, decodeTime } from 'ulid';

export function newUlid(): string {
  return ulid();
}

/** Generate a ULID encoding a specific epoch-ms timestamp. Useful for
 *  tests that need to manufacture stale event ids. */
export function ulidAt(epochMs: number): string {
  return ulid(epochMs);
}

/** Re-export so workspace packages can read ULID timestamps without
 *  taking their own dep on the `ulid` package. */
export { decodeTime };
