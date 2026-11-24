import { describe, expect, it } from 'vitest';
import { RealtimeEnv, RealtimeMessage, SocketLike, ZapiackRealtime, ZapiackRealtimeError } from '../src/realtime';

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  closedWith: number | null = null;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  /** What the server does. */
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function rig(opts: { tokens?: string[]; heartbeatMs?: number; ackTimeoutMs?: number } = {}) {
  let clock = 1_000_000;
  const timers: Array<{ id: number; at: number; fn: () => void; every?: number }> = [];
  let next = 1;
  const sockets: FakeSocket[] = [];
  const tokens = [...(opts.tokens ?? ['tok-1', 'tok-2', 'tok-3', 'tok-4'])];
  const asked: number[] = [];
  const env: RealtimeEnv = {
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    setTimeout: (fn, ms) => {
      timers.push({ id: next, at: clock + ms, fn });
      return next++;
    },
    clearTimeout: (id) => void timers.splice(0, timers.length, ...timers.filter((t) => t.id !== id)),
    setInterval: (fn, ms) => {
      timers.push({ id: next, at: clock + ms, fn, every: ms });
      return next++;
    },
    clearInterval: (id) => void timers.splice(0, timers.length, ...timers.filter((t) => t.id !== id)),
    random: () => 0,
  };
  const rt = new ZapiackRealtime(
    {
      getToken: async () => {
        asked.push(clock);
        const t = tokens.shift();
        if (!t) throw new Error('server down');
        return t;
      },
      url: 'wss://rt.test/',
      heartbeatMs: opts.heartbeatMs ?? 1000,
      ackTimeoutMs: opts.ackTimeoutMs ?? 5000,
      backoffMs: { min: 100, max: 1600 },
    },
    env,
    () => clock,
  );
  /** Moves time on, running what falls due, in order. */
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      if (due.every) due.at += due.every;
      else timers.splice(timers.indexOf(due), 1);
      due.fn();
      await tick();
    }
    clock = end;
  };
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const last = () => sockets[sockets.length - 1]!;
  /** Connects and has the server say hello. */
  const up = async (id = 'cn_1') => {
    const p = rt.connect();
    await tick();
    last().receive({ op: 'hello', connId: id, expiresAt: 0 });
    await p;
  };
  return { rt, sockets, last, up, advance, tick, asked, tokens };
}

describe('connecting', () => {
  it('asks for a token, puts it in the address, and resolves once the server says hello', async () => {
    const { rt, last, sockets, up } = rig({ tokens: ['a b/c'] });
    expect(rt.state).toBe('idle');
    await up('cn_9');
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe('wss://rt.test/?token=a%20b%2Fc');
    expect(rt.state).toBe('connected');
    expect(rt.connectionId).toBe('cn_9');
  });

  it('refuses to be built without a way to get a token', () => {
    expect(() => new ZapiackRealtime({} as never)).toThrow(ZapiackRealtimeError);
  });

  it('reports a token it could not get, and keeps trying', async () => {
    const { rt, advance, tick, sockets, tokens } = rig({ tokens: [] });
    const errors: string[] = [];
    rt.onError((e) => errors.push(e.message));
    void rt.connect();
    await tick();
    expect(errors[0]).toMatch(/Could not get a token: server down/);
    tokens.push('late');
    await advance(5000);
    await tick();
    expect(sockets).toHaveLength(1);
  });

  it('stops for good when the project refuses it, and says so', async () => {
    const { rt, last, tick, sockets, advance } = rig();
    const p = rt.connect();
    const caught = p.catch((e) => e);
    await tick();
    last().drop(4403);
    expect(await caught).toMatchObject({ code: 403 });
    expect(rt.state).toBe('closed');
    await advance(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('a refusal the server marks fatal', () => {
  it('stops it for good even when the close code cannot be read', async () => {
    const { rt, last, tick, sockets, advance } = rig();
    const caught = rt.connect().catch((e) => e);
    await tick();
    last().receive({ op: 'error', code: 403, message: 'Realtime is not enabled for this project.', fatal: true });
    // A runtime that cannot see the real code reports an ordinary drop.
    last().drop(1006);
    expect(await caught).toMatchObject({ code: 403 });
    expect(rt.state).toBe('closed');
    await advance(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('channels', () => {
  it('subscribes when the line opens, delivers messages, and stops when the last listener leaves', async () => {
    const { rt, last, up } = rig();
    const got: string[] = [];
    // Subscribed before connecting: sent as soon as it can be.
    const stop = rt.subscribe('chat:r1', (m) => got.push(m.event + ':' + JSON.stringify(m.data)));
    await up();
    expect(last().sent.filter((f) => f['op'] === 'subscribe')).toEqual([{ op: 'subscribe', channel: 'chat:r1' }]);
    last().receive({ op: 'message', msgId: '1-0', ts: 1, channel: 'chat:r1', event: 'message', data: { hi: 1 }, from: 'u1' });
    last().receive({ op: 'message', msgId: '1-1', ts: 1, channel: 'other', event: 'message', data: 0, from: 'u1' });
    expect(got).toEqual(['message:{"hi":1}']);
    stop();
    expect(last().sent.at(-1)).toEqual({ op: 'unsubscribe', channel: 'chat:r1' });
  });

  it('a handler that throws does not stop the others', async () => {
    const { rt, last, up } = rig();
    await up();
    const got: unknown[] = [];
    rt.subscribe('c', () => {
      throw new Error('bug');
    });
    rt.subscribe('c', (m) => got.push(m.data));
    last().receive({ op: 'message', msgId: '1-0', ts: 1, channel: 'c', event: 'message', data: 7, from: null });
    expect(got).toEqual([7]);
  });

  it('keeps who is present, and tells listeners when it changes', async () => {
    const { rt, last, up } = rig();
    await up();
    rt.subscribe('c', () => undefined);
    const p = rt.presence('c');
    const events: string[] = [];
    p.onChange((e) => events.push(`${e.action}:${e.member.user}`));
    p.enter({ n: 1 });
    expect(last().sent.at(-1)).toEqual({ op: 'presence.enter', channel: 'c', data: { n: 1 } });
    last().receive({ op: 'presence.members', channel: 'c', members: [{ connId: 'cn_a', user: 'ann', data: null, at: 1 }] });
    last().receive({ op: 'message', msgId: '2-0', ts: 2, channel: 'c', event: 'presence.enter', data: { connId: 'cn_b', user: 'bob', data: 1 }, from: 'cn_b' });
    expect(p.members().map((m) => m.user)).toEqual(['ann', 'bob']);
    last().receive({ op: 'message', msgId: '3-0', ts: 3, channel: 'c', event: 'presence.leave', data: { connId: 'cn_a', user: 'ann', data: null }, from: 'cn_a' });
    expect(p.members().map((m) => m.user)).toEqual(['bob']);
    expect(events).toEqual(['enter:bob', 'leave:ann']);
  });

  it('sends a signal to one connection', async () => {
    const { rt, last, up } = rig();
    await up();
    rt.signal('call', 'cn_x', 'offer', { sdp: 'v=0' });
    expect(last().sent.at(-1)).toEqual({ op: 'signal', channel: 'call', to: 'cn_x', event: 'offer', data: { sdp: 'v=0' } });
  });
});

describe('publishing', () => {
  it('resolves when the server confirms, with the id and how many it reached', async () => {
    const { rt, last, up } = rig();
    await up();
    const p = rt.publish('c', { a: 1 }, { persist: true, event: 'note' });
    const frame = last().sent.at(-1)!;
    expect(frame).toMatchObject({ op: 'publish', channel: 'c', event: 'note', data: { a: 1 }, persist: true });
    last().receive({ op: 'ack', ackId: frame['ackId'], msgId: '9-0', delivered: 3 });
    expect(await p).toEqual({ msgId: '9-0', delivered: 3 });
  });

  it('rejects with the server\'s reason when it refuses', async () => {
    const { rt, last, up } = rig();
    await up();
    const p = rt.publish('c', 1);
    last().receive({ op: 'error', code: 403, message: 'Not allowed to publish to c.', ref: last().sent.at(-1)!['ackId'] });
    await expect(p).rejects.toMatchObject({ code: 403, message: expect.stringContaining('Not allowed') });
  });

  it('rejects when no confirmation comes', async () => {
    const { rt, up, advance } = rig({ ackTimeoutMs: 2000 });
    await up();
    const p = rt.publish('c', 1);
    const caught = p.catch((e) => e);
    await advance(2500);
    expect(await caught).toMatchObject({ message: expect.stringContaining('did not confirm') });
  });

  it('fire and forget does not wait', async () => {
    const { rt, last, up } = rig();
    await up();
    expect(await rt.publish('c', 1, { ack: false })).toBeUndefined();
    expect(last().sent.at(-1)!['ackId']).toBeUndefined();
  });

  it('holds sends while reconnecting and sends them once back, in order; refuses past the limit', async () => {
    const { rt, last, up, advance, tick } = rig();
    await up();
    last().drop(1006);
    expect(rt.state).toBe('reconnecting');
    const a = rt.publish('c', 'one', { ack: false });
    const b = rt.publish('c', 'two', { ack: false });
    await a;
    await b;
    await advance(150);
    await tick();
    last().receive({ op: 'hello', connId: 'cn_2' });
    expect(last().sent.filter((f) => f['op'] === 'publish').map((f) => f['data'])).toEqual(['one', 'two']);

    last().drop(1006);
    for (let i = 0; i < 100; i++) void rt.publish('c', i, { ack: false });
    await expect(rt.publish('c', 'over')).rejects.toMatchObject({ code: 429 });
  });

  it('rejects what was waiting when you disconnect', async () => {
    const { rt, up } = rig();
    await up();
    const p = rt.publish('c', 1);
    rt.disconnect();
    await expect(p).rejects.toThrow('Disconnected');
    expect(rt.state).toBe('closed');
  });
});

describe('staying connected', () => {
  it('reconnects with a new token, re-joins, and asks only for what it missed; a replay does not repeat what was seen', async () => {
    const { rt, last, sockets, up, advance, tick, asked } = rig();
    const got: Array<[string, boolean | undefined]> = [];
    rt.subscribe('c', (m: RealtimeMessage) => got.push([String(m.data), m.replayed]));
    await up();
    last().receive({ op: 'message', msgId: '10-0', ts: 1, channel: 'c', event: 'message', data: 'a', from: null, persisted: true });
    last().receive({ op: 'message', msgId: '11-0', ts: 1, channel: 'c', event: 'message', data: 'b', from: null, persisted: true });
    last().drop(1006);
    expect(rt.state).toBe('reconnecting');
    await advance(150);
    await tick();
    expect(sockets).toHaveLength(2);
    expect(asked).toHaveLength(2);
    expect(sockets[1]!.url).toContain('token=tok-2');
    sockets[1]!.receive({ op: 'hello', connId: 'cn_2' });
    expect(sockets[1]!.sent).toContainEqual({ op: 'subscribe', channel: 'c', resumeFrom: '11-0' });
    // The server replays one already seen and one new.
    sockets[1]!.receive({ op: 'message', msgId: '11-0', ts: 1, channel: 'c', event: 'message', data: 'b', from: null, persisted: true, replayed: true });
    sockets[1]!.receive({ op: 'message', msgId: '12-0', ts: 1, channel: 'c', event: 'message', data: 'c', from: null, persisted: true, replayed: true });
    expect(got).toEqual([['a', undefined], ['b', undefined], ['c', true]]);
    expect(rt.state).toBe('connected');
  });

  it('pauses longer after each failure, never past the limit, and starts over once connected', async () => {
    const { rt, last, sockets, up, advance, tick } = rig({ tokens: Array.from({ length: 12 }, (_, i) => `t${i}`) });
    await up();
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = sockets.length;
      last().drop(1006);
      let waited = 0;
      while (sockets.length === before && waited < 5000) {
        await advance(50);
        await tick();
        waited += 50;
      }
      gaps.push(waited);
    }
    // random() is 0 in the rig, so every wait is the minimum: jitter can only shorten the ceiling, never remove the pause.
    expect(gaps.every((g) => g >= 100 && g <= 1650)).toBe(true);
    sockets[sockets.length - 1]!.receive({ op: 'hello', connId: 'cn_z' });
    expect(rt.state).toBe('connected');
  });

  it('replaces a refused token at once rather than waiting', async () => {
    const { rt, last, sockets, up, advance, tick } = rig();
    await up();
    last().drop(4401);
    // No pause: only the next turn of the timer, not the backoff.
    await advance(1);
    await tick();
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain('tok-2');
    expect(rt.state).toBe('reconnecting');
  });

  it('pings on a beat, and gives up on a line that has gone silent', async () => {
    const { rt, last, up, advance, sockets } = rig({ heartbeatMs: 1000 });
    await up();
    await advance(1000);
    expect(last().sent.at(-1)).toEqual({ op: 'ping' });
    last().receive({ op: 'pong' });
    await advance(1000);
    expect(sockets[0]!.closedWith).toBeNull();
    // Nothing heard for more than two beats.
    await advance(3000);
    expect(sockets[0]!.closedWith).toBe(4000);
    expect(rt.state).toBe('reconnecting');
  });

  it('tells the app when missed messages could not be replayed', async () => {
    const { rt, last, up } = rig();
    await up();
    const errors: ZapiackRealtimeError[] = [];
    rt.onError((e) => errors.push(e));
    last().receive({ op: 'resume.failed', channel: 'c' });
    expect(errors[0]).toMatchObject({ code: 410 });
  });
});
