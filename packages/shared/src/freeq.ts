import { newUlid } from './ulid.js';
import type { EventType } from './events.js';

// ── Payload encoding ─────────────────────────────────────────────────────────
//
// Per PLAN §5.0: freeq-server decodes the +freeq.at/payload tag value via
// urlencoding::decode(). The Rust SDK encodes by replacing `;` and ASCII
// space with `%3B`/`%20`. We do the same so payloads survive both:
//   1. The IRCv3 tag-value escape (`\\`, `\:`, `\s`, `\r`, `\n`) that the
//      SDK's serializeTags applies — pct-encoded JSON contains none of those.
//   2. The server's url-decode pass.

const PCT_SEMI = /;/g;
const PCT_SPACE = / /g;

export function encodePayload(payload: unknown): string {
  return JSON.stringify(payload).replace(PCT_SEMI, '%3B').replace(PCT_SPACE, '%20');
}

export function decodePayload<T = unknown>(raw: string): T {
  // The IRC parser already unescaped `\:` → `;`, `\s` → ` `, etc. before we
  // see the tag value. The server then percent-decodes when storing. So when
  // we receive an inbound event, the payload tag value contains the
  // percent-encoded form (pre-server-decode) — but if it came from the freeq
  // web client or another freeq-tagged source, it might be plain.
  // decodeURIComponent handles both cases (it's idempotent on pure JSON).
  const decoded = decodeURIComponent(raw);
  return JSON.parse(decoded) as T;
}

// ── Tag building ─────────────────────────────────────────────────────────────

export interface CoordinationTags {
  /** Server-assigned event_id; we always pre-mint as ULID. */
  msgid: string;
  /** +freeq.at/event=<x> */
  event: EventType | string;
  /** Percent-encoded JSON payload. */
  payload: string;
  /** +freeq.at/task-id (= +freeq.at/ref to server) for threading. Optional on task_request itself. */
  taskId?: string;
  /** +freeq.at/evidence-type — drives web-client card rendering. */
  evidenceType?: string;
  /** Free-form additional tags. */
  extra?: Record<string, string>;
}

/**
 * Build the IRC tag map for a coordination event. Used for both the TAGMSG
 * (storage) and the companion PRIVMSG (rendering). PLAN §5.0: every
 * +freeq.at/* tag goes on BOTH lines.
 */
export function buildEventTagMap(tags: CoordinationTags): Record<string, string> {
  const out: Record<string, string> = {
    msgid: tags.msgid,
    '+freeq.at/event': tags.event,
    '+freeq.at/payload': tags.payload,
  };
  if (tags.taskId) out['+freeq.at/task-id'] = tags.taskId;
  if (tags.evidenceType) out['+freeq.at/evidence-type'] = tags.evidenceType;
  if (tags.extra) Object.assign(out, tags.extra);
  return out;
}

// ── IRC line serialization ───────────────────────────────────────────────────
//
// freeq-sdk-js exports a `format` helper from its parser (it's used by the
// SDK internally). We re-implement here to (a) avoid pulling sdk types in
// the shared package, (b) keep the encoding contract explicit.
//
// IRCv3 tag-value escapes:  \\ \: \s \r \n  (only these five chars escaped)

const TAG_ESC: Record<string, string> = {
  '\\': '\\\\',
  ';': '\\:',
  ' ': '\\s',
  '\r': '\\r',
  '\n': '\\n',
};

export function escapeTagValue(v: string): string {
  return v.replace(/[\\; \r\n]/g, (c) => TAG_ESC[c] ?? c);
}

const TAG_UNESC_RE = /\\(\\|:|s|r|n)/g;
const TAG_UNESC: Record<string, string> = {
  '\\': '\\',
  ':': ';',
  s: ' ',
  r: '\r',
  n: '\n',
};

export function unescapeTagValue(v: string): string {
  return v.replace(TAG_UNESC_RE, (_, c) => TAG_UNESC[c] ?? c);
}

export function serializeTags(tags: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(tags)) {
    parts.push(v === '' ? k : `${k}=${escapeTagValue(v)}`);
  }
  return parts.join(';');
}

export function parseTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      out[part] = '';
    } else {
      out[part.slice(0, eq)] = unescapeTagValue(part.slice(eq + 1));
    }
  }
  return out;
}

/**
 * Build a complete IRC line (with `@<tags> `) for a given verb + params + trailing.
 * Used by emitCoordinationEvent — callers send this verbatim via client.raw.
 */
/** Strip raw CR/LF and NUL chars from any text destined for an IRC line.
 *  Without this, a malicious payload (e.g. a parsed gh stderr that contains
 *  `\r\nKICK #ch victim`) would let the attacker inject arbitrary IRC commands.
 */
export function safeIrcText(s: string): string {
  return s.replace(/[\r\n\0]/g, ' ');
}

export function formatLine(
  tags: Record<string, string> | null,
  verb: 'TAGMSG' | 'PRIVMSG' | 'NOTICE',
  params: string[],
  trailing?: string,
): string {
  const tagPart = tags && Object.keys(tags).length > 0 ? `@${serializeTags(tags)} ` : '';
  // Sanitize all params (NUL/CR/LF would split the line).
  const safeParams = params.map(safeIrcText);
  const paramPart = safeParams.length > 0 ? ` ${safeParams.join(' ')}` : '';
  const trailPart = trailing !== undefined ? ` :${safeIrcText(trailing)}` : '';
  return `${tagPart}${verb}${paramPart}${trailPart}`;
}

// ── Emit helper ──────────────────────────────────────────────────────────────

export interface EmitOptions {
  /** Pre-supplied event_id (if omitted, a fresh ULID is minted). */
  eventId?: string;
  /** Threading reference; absent on the originating task_request. */
  taskId?: string;
  /** Drives web-client card type. */
  evidenceType?: string;
  /** Short human-readable text for the companion PRIVMSG. */
  humanText: string;
  /** Additional tags to attach to BOTH lines. */
  extraTags?: Record<string, string>;
}

export interface EmitResult {
  eventId: string;
  /** The TAGMSG IRC line (server stores the event from this). */
  tagmsg: string;
  /** The PRIVMSG IRC line (web client renders cards from this). */
  privmsg: string;
}

/**
 * Build the TAGMSG + companion PRIVMSG pair for a coordination event.
 * Caller is responsible for actually sending them (typically via client.raw).
 *
 * PLAN §5.0.1: every +freeq.at/* tag goes on BOTH lines so storage AND
 * rendering both work. PLAN §6: PRIVMSGs are sent via client.raw and rely on
 * server-side fallback signing (autoMsgSig: false on the SDK).
 */
export function buildCoordinationEvent(
  channel: string,
  eventType: EventType | string,
  payload: unknown,
  opts: EmitOptions,
): EmitResult {
  const eventId = opts.eventId ?? newUlid();
  const tags = buildEventTagMap({
    msgid: eventId,
    event: eventType,
    payload: encodePayload(payload),
    taskId: opts.taskId,
    evidenceType: opts.evidenceType,
    extra: opts.extraTags,
  });
  return {
    eventId,
    tagmsg: formatLine(tags, 'TAGMSG', [channel]),
    privmsg: formatLine(tags, 'PRIVMSG', [channel], opts.humanText),
  };
}

// ── Inbound parser + subscriber ─────────────────────────────────────────────
//
// Parse an inbound IRC line and, if it's a coordination-event TAGMSG, return
// the structured event. Returns null otherwise.

export interface InboundCoordinationEvent {
  source?: string;
  verb: 'TAGMSG' | 'PRIVMSG';
  channel: string;
  eventType: string;
  eventId: string;
  taskId?: string;
  evidenceType?: string;
  payload: unknown;
  /** All raw tags (decoded), in case caller needs more. */
  tags: Record<string, string>;
}

const LINE_RE = /^(?:@(\S+)\s+)?(?::(\S+)\s+)?(\S+)(?:\s+([^:]\S*(?:\s+[^:]\S*)*))?(?:\s+:(.*))?$/;

export function parseInboundCoordinationEvent(line: string): InboundCoordinationEvent | null {
  const m = LINE_RE.exec(line.trimEnd());
  if (!m) return null;
  const [, tagsRaw, source, verb, paramsRaw] = m;
  if (!tagsRaw) return null;
  if (verb !== 'TAGMSG' && verb !== 'PRIVMSG') return null;
  const tags = parseTags(tagsRaw);
  const eventType = tags['+freeq.at/event'];
  if (!eventType) return null;
  const eventId = tags.msgid;
  if (!eventId) return null;
  const payloadRaw = tags['+freeq.at/payload'];
  let payload: unknown = null;
  if (payloadRaw) {
    try {
      payload = decodePayload(payloadRaw);
    } catch {
      return null; // malformed payload
    }
  }
  const params = paramsRaw ? paramsRaw.split(/\s+/) : [];
  const channel = params[0] ?? '';
  return {
    source,
    verb,
    channel,
    eventType,
    eventId,
    taskId: tags['+freeq.at/task-id'] ?? tags['+freeq.at/ref'],
    evidenceType: tags['+freeq.at/evidence-type'],
    payload,
    tags,
  };
}

/** Default cap on inbound coordination-event line length. The server enforces
 *  8KB but we hard-limit lower to defend against memory amplification when
 *  someone tries to stuff a 1MB payload that survives the IRC layer. */
export const INBOUND_LINE_MAX_BYTES = 16 * 1024;

/**
 * Subscribe to coordination events on the given client. We listen on the
 * `'raw'` event (the SDK negotiates `echo-message` so our own outbound
 * TAGMSGs come back too — handler should filter on `event.source` if it
 * needs to ignore self).
 *
 * Returns an unsubscribe fn.
 */
export function subscribeCoordinationEvents(
  client: { on: (event: 'raw', h: (line: string, parsed: any) => void) => void; off: (event: 'raw', h: any) => void },
  handler: (event: InboundCoordinationEvent) => void,
  opts: { maxLineBytes?: number } = {},
): () => void {
  const cap = opts.maxLineBytes ?? INBOUND_LINE_MAX_BYTES;
  const onRaw = (line: string, _parsed: any): void => {
    if (line.length > cap) return; // drop oversized lines silently
    const evt = parseInboundCoordinationEvent(line);
    if (!evt) return;
    try {
      handler(evt);
    } catch (e) {
      // Don't let handler errors poison the SDK's raw stream.
      console.error('[coordination-event handler error]', e);
    }
  };
  client.on('raw', onRaw);
  return () => client.off('raw', onRaw);
}

/**
 * Extract the bare nick (everything before the first `!`) from an IRC source
 * prefix like `nick!user@host`. Returns the input as-is if no `!`.
 */
export function nickFromSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const i = source.indexOf('!');
  return i === -1 ? source : source.slice(0, i);
}
