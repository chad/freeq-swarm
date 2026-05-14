// Announce sequence: PROVENANCE → AGENT REGISTER → PRESENCE → HEARTBEAT → JOIN.
// Mirrors freeqcc/src/connect.ts:announce. Caller emits cap-ad after JOIN, then
// transitions PRESENCE=idle.
import type { FreeqClient } from '@freeq/sdk';
import type { DelegationCert } from './delegation.js';

export interface AnnounceOptions {
  client: FreeqClient;
  delegation: DelegationCert;
  /** Channels to JOIN as part of the announce. */
  channels: string[];
  /** Heartbeat interval (ms). Default 30_000. */
  heartbeatMs?: number;
  /** Heartbeat TTL (s). Default 60. */
  heartbeatTtlS?: number;
  /** Initial PRESENCE state. Default 'online'. Worker transitions to 'idle' after cap ad. */
  initialPresence?: string;
}

export interface AnnounceHandle {
  /** Stop the heartbeat loop and emit PRESENCE=offline + QUIT. */
  stop(reason?: string): Promise<void>;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Run the announce sequence and start the heartbeat loop. Idempotent on
 * `'ready'` (re-announces on every reconnect — server state may be gone).
 */
export function startAnnounce(opts: AnnounceOptions): AnnounceHandle {
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const heartbeatTtlS = opts.heartbeatTtlS ?? 60;
  const initialPresence = opts.initialPresence ?? 'online';
  let timer: NodeJS.Timeout | null = null;

  const run = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // PROVENANCE: send cert as base64url JSON.
    const certJson = JSON.stringify(opts.delegation);
    opts.client.raw(`PROVENANCE :${b64urlEncode(certJson)}`);
    // AGENT REGISTER: declare we're an agent.
    opts.client.raw('AGENT REGISTER :class=agent');
    // PRESENCE.
    opts.client.raw(`PRESENCE :state=${initialPresence}`);
    // HEARTBEAT loop.
    const beat = (): void => {
      try {
        opts.client.raw(`HEARTBEAT :state=active;ttl=${heartbeatTtlS}`);
      } catch {
        // socket gone; next ready will re-arm
      }
    };
    beat();
    timer = setInterval(beat, heartbeatMs);
    // JOIN configured channels.
    for (const ch of opts.channels) {
      opts.client.raw(`JOIN ${ch}`);
    }
  };

  // The initial 'ready' event has already fired by the time startAnnounce
  // is called (connectClient awaits it before returning), so subscribing
  // alone would miss the first connection's announce — run() would only
  // execute on a future reconnect. Call run() once inline so the initial
  // announce always happens, and ALSO subscribe for subsequent reconnects.
  run();
  opts.client.on('ready', run);

  return {
    async stop(reason) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try {
        opts.client.raw('PRESENCE :state=offline');
        opts.client.raw(reason ? `QUIT :${reason}` : 'QUIT :swarm stop');
      } catch {
        /* socket gone */
      }
      // Allow QUIT to flush.
      await new Promise((r) => setTimeout(r, 250));
      try {
        opts.client.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}
