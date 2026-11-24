import { describe, expect, it } from 'vitest';
import { RealtimeEnv, SocketLike, ZapiackRealtime, ZapiackRealtimeError } from '../src/realtime';

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function rig() {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, () => void>();
  let n = 1;
  const env: RealtimeEnv = {
    socket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimeout: (fn) => {
      timers.set(n, fn);
      return n++;
    },
    clearTimeout: (id) => void timers.delete(id as number),
    setInterval: () => n++,
    clearInterval: () => undefined,
    random: () => 0,
  };
  const rt = new ZapiackRealtime({ getToken: async () => 'tok', url: 'wss://rt.test', ackTimeoutMs: 100 }, env);
  const up = async () => {
    const p = rt.connect();
    await tick();
    sockets[0]!.receive({ op: 'hello', connId: 'cn_1', expiresAt: 0 });
    await p;
  };
  return { rt, sockets, up, timers };
}

describe('request', () => {
  it('sends an rpc frame and resolves with the data of the matching answer', async () => {
    const { rt, sockets, up } = rig();
    await up();
    const a = rt.request('media.ping', { x: 1 });
    const b = rt.request('media.join', {});
    const [first, second] = sockets[0]!.sent.filter((f) => f['op'] === 'rpc');
    expect(first).toMatchObject({ method: 'media.ping', data: { x: 1 } });
    // Answers may come in any order; each goes to its own question.
    sockets[0]!.receive({ op: 'rpc.result', correlationId: second!['correlationId'], data: { joined: true } });
    sockets[0]!.receive({ op: 'rpc.result', correlationId: first!['correlationId'], data: { pong: true } });
    expect(await a).toEqual({ pong: true });
    expect(await b).toEqual({ joined: true });
  });

  it('rejects with the service\'s code as the reason, so an app can tell a refusal from a fault', async () => {
    const { rt, sockets, up } = rig();
    await up();
    const p = rt.request('media.produce', {});
    const id = sockets[0]!.sent.find((f) => f['op'] === 'rpc')!['correlationId'];
    sockets[0]!.receive({ op: 'rpc.error', correlationId: id, code: 'forbidden', message: 'Your role cannot send video.' });
    await expect(p).rejects.toMatchObject({ message: 'Your role cannot send video.', reason: 'forbidden' });
  });

  it('fails at once when the line is down, and never queues a question for later', async () => {
    const { rt, sockets } = rig();
    await expect(rt.request('media.join')).rejects.toMatchObject({ reason: 'no_route' });
    expect(sockets.length).toBe(0);
  });

  it('fails what was waiting when the line drops, without touching a later question', async () => {
    const { rt, sockets, up } = rig();
    await up();
    const p = rt.request('media.join');
    sockets[0]!.close(1006);
    await expect(p).rejects.toBeInstanceOf(ZapiackRealtimeError);
    await expect(p).rejects.toMatchObject({ reason: 'no_route' });
  });

  it('gives up when no answer comes', async () => {
    const { rt, up, timers } = rig();
    await up();
    const p = rt.request('media.join');
    for (const fn of [...timers.values()]) fn();
    await expect(p).rejects.toMatchObject({ reason: 'timeout' });
  });
});
