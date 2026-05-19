import { describe, expect, it } from 'vitest';
import {
  buildCoordinationEvent,
  decodePayload,
  encodePayload,
  escapeTagValue,
  formatLine,
  parseInboundCoordinationEvent,
  parseTags,
  serializeTags,
  subscribeCoordinationEvents,
  unescapeTagValue,
} from './freeq.js';

describe('payload encoding', () => {
  it('round-trips JSON with semicolons and spaces', () => {
    const obj = { kind: 'swarm.task/v1', detail: 'a;b c;d', n: 42 };
    const enc = encodePayload(obj);
    expect(enc).not.toContain(';');
    expect(enc).not.toContain(' ');
    expect(decodePayload(enc)).toEqual(obj);
  });

  it('decodes already-decoded JSON identically (idempotent for plain JSON)', () => {
    const obj = { hello: 'world', n: 1 };
    expect(decodePayload(JSON.stringify(obj))).toEqual(obj);
  });
});

describe('IRCv3 tag escaping', () => {
  it('escapes the five reserved chars only', () => {
    expect(escapeTagValue('a;b c\\d\re\nf')).toBe('a\\:b\\sc\\\\d\\re\\nf');
  });

  it('round-trips through escape/unescape', () => {
    const samples = ['a;b c', 'no-special', 'a\\b', 'multi;\\nlines', '%20%3Bencoded'];
    for (const s of samples) {
      expect(unescapeTagValue(escapeTagValue(s))).toBe(s);
    }
  });

  it('serializes and parses tag map', () => {
    const map = { msgid: '01HZN', '+freeq.at/event': 'task_request', '+freeq.at/payload': 'pct;enc' };
    // Note: encoded payload going through tag escape would also round-trip,
    // but we want to verify the serializer escapes the `;` in payload value.
    const ser = serializeTags(map);
    expect(parseTags(ser)).toEqual(map);
  });
});

describe('formatLine', () => {
  it('builds TAGMSG with trailing absent', () => {
    const line = formatLine({ msgid: 'x', '+freeq.at/event': 'task_request' }, 'TAGMSG', ['#swarm']);
    expect(line).toBe('@msgid=x;+freeq.at/event=task_request TAGMSG #swarm');
  });

  it('builds PRIVMSG with trailing', () => {
    const line = formatLine(null, 'PRIVMSG', ['#swarm'], 'hello world');
    expect(line).toBe('PRIVMSG #swarm :hello world');
  });
});

describe('buildCoordinationEvent', () => {
  it('emits a TAGMSG/PRIVMSG pair with the same full tag set', () => {
    const evt = buildCoordinationEvent(
      '#swarm',
      'task_request',
      { kind: 'swarm.task/v1', n: 1 },
      { humanText: '📋 review' },
    );
    expect(evt.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID Crockford
    // Extract tags from each line and assert key set matches.
    const tagOf = (l: string) => l.slice(1, l.indexOf(' '));
    const tagmsgTags = parseTags(tagOf(evt.tagmsg));
    const privmsgTags = parseTags(tagOf(evt.privmsg));
    expect(tagmsgTags).toEqual(privmsgTags);
    expect(tagmsgTags['+freeq.at/event']).toBe('task_request');
    expect(tagmsgTags.msgid).toBe(evt.eventId);
    // PRIVMSG carries the human text.
    expect(evt.privmsg.endsWith(':📋 review')).toBe(true);
  });

  it('full pipeline: build → parse extracts the original payload', () => {
    const original = { kind: 'swarm.claim/v1', task_id: '01HZ', worker_did: 'did:key:z' };
    const evt = buildCoordinationEvent('#swarm', 'task_accept', original, {
      humanText: '🙋',
      taskId: '01HZ',
    });
    const parsed = parseInboundCoordinationEvent(evt.tagmsg);
    expect(parsed).not.toBeNull();
    expect(parsed!.eventType).toBe('task_accept');
    expect(parsed!.taskId).toBe('01HZ');
    expect(parsed!.payload).toEqual(original);
  });
});

describe('parseInboundCoordinationEvent', () => {
  it('returns null for non-coordination IRC lines', () => {
    expect(parseInboundCoordinationEvent('PRIVMSG #swarm :hello')).toBeNull();
    expect(parseInboundCoordinationEvent(':nick!u@h JOIN #swarm')).toBeNull();
    expect(parseInboundCoordinationEvent('@msgid=x PRIVMSG #swarm :hello')).toBeNull();
  });

  it('extracts source, channel, event type and payload', () => {
    const line =
      '@msgid=01H;+freeq.at/event=task_complete;+freeq.at/task-id=01TASK;+freeq.at/payload=%7B%22kind%22:%22swarm.completion/v1%22%7D :coord!u@h TAGMSG #swarm';
    const parsed = parseInboundCoordinationEvent(line);
    expect(parsed).not.toBeNull();
    expect(parsed!.source).toBe('coord!u@h');
    expect(parsed!.channel).toBe('#swarm');
    expect(parsed!.eventType).toBe('task_complete');
    expect(parsed!.eventId).toBe('01H');
    expect(parsed!.taskId).toBe('01TASK');
    expect(parsed!.payload).toEqual({ kind: 'swarm.completion/v1' });
  });

  it('falls back from +freeq.at/task-id to +freeq.at/ref', () => {
    const line =
      '@msgid=01;+freeq.at/event=task_update;+freeq.at/ref=01R;+freeq.at/payload=%7B%7D TAGMSG #swarm';
    const parsed = parseInboundCoordinationEvent(line);
    expect(parsed!.taskId).toBe('01R');
  });
});

describe('subscribeCoordinationEvents', () => {
  function makeClient(): { emit: (line: string) => void; client: any } {
    const handlers: Array<(line: string, parsed: any) => void> = [];
    return {
      emit: (line) => handlers.forEach((h) => h(line, null)),
      client: {
        on: (_e: 'raw', h: any) => handlers.push(h),
        off: (_e: 'raw', h: any) => {
          const i = handlers.indexOf(h);
          if (i >= 0) handlers.splice(i, 1);
        },
      },
    };
  }

  it('fires once per logical event — TAGMSG only, drops the PRIVMSG companion', () => {
    // buildCoordinationEvent emits BOTH a TAGMSG and a PRIVMSG with the same
    // msgid + tags. Both parse, so without a verb filter the handler fires
    // twice per logical event. Worker workflows would double-run.
    const c = makeClient();
    const calls: string[] = [];
    const unsub = subscribeCoordinationEvents(c.client, (evt) => {
      calls.push(`${evt.verb}:${evt.eventType}`);
    });
    const evt = buildCoordinationEvent('#swarm', 'task_request', { kind: 'swarm.task/v1' }, {
      eventId: '01HZ',
      humanText: '📣 task',
    });
    c.emit(evt.tagmsg);
    c.emit(evt.privmsg);
    expect(calls).toEqual(['TAGMSG:task_request']);
    unsub();
  });
});
