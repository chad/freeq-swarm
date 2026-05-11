// Pure parser for swarm.discovery/v1 PRIVMSG responses.
// Imported by both the worker (to consume responses) and the coordinator
// (to round-trip-test its emitter).
import type { SwarmDiscovery } from './events.js';

export function parseDiscoveryResponse(line: string): SwarmDiscovery | null {
  // Match `@<tags> :sender PRIVMSG nick :body`
  const m = /^@(\S+)\s+(?::\S+\s+)?PRIVMSG\s+\S+\s+:(.*)$/.exec(line);
  if (!m) return null;
  const tags = m[1]!;
  const tagMap: Record<string, string> = {};
  for (const part of tags.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) tagMap[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const enc = tagMap['swarm.discovery/v1'];
  if (!enc) return null;
  try {
    const json = Buffer.from(enc.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as SwarmDiscovery;
  } catch {
    return null;
  }
}
