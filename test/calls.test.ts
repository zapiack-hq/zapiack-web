import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZapiackCall } from '../src/calls';
import { ZapiackRealtimeError } from '../src/realtime';

/** Just enough of a browser: a stream that holds tracks. */
(globalThis as any).MediaStream = class {
  constructor(readonly tracks: unknown[] = []) {}
};

type Handler = (...a: any[]) => void;
const emitter = () => {
  const h = new Map<string, Handler>();
  return { on: (e: string, fn: Handler) => void h.set(e, fn), fire: (e: string, ...a: any[]) => h.get(e)?.(...a), h };
};

function fakeTransport(id: string, asked: Array<[string, any]>) {
  const e = emitter();
  let connected = false;
  /** mediasoup-client asks the app to connect a transport once, the first time anything uses it. */
  const connect = async () => {
    if (connected) return;
    connected = true;
    await new Promise<void>((ok, fail) => e.fire('connect', { dtlsParameters: { role: 'client' } }, ok, fail));
  };
  const t: any = {
    id,
    closed: false,
    on: e.on,
    fire: e.fire,
    close() {
      t.closed = true;
    },
    async produce({ track, appData }: any) {
      // What mediasoup-client does: tell the app to connect, then to produce, before it hands back the producer.
      await connect();
      const { id: pid } = await new Promise<{ id: string }>((ok, fail) => e.fire('produce', { kind: track.kind, rtpParameters: { codecs: [] }, appData }, ok, fail));
      const pe = emitter();
      const p: any = { id: pid, track, appData, paused: false, closed: false, on: pe.on, pause: () => (p.paused = true), resume: () => (p.paused = false), close: () => (p.closed = true) };
      return p;
    },
    async consume({ id: cid, kind }: any) {
      await connect();
      const ce = emitter();
      const c: any = { id: cid, kind, track: { kind, id: 'trk-' + cid }, closed: false, on: ce.on, close: () => (c.closed = true), getStats: async () => new Map([['x', { type: 'inbound-rtp', bytesReceived: 5000, packetsReceived: 50, packetsLost: 1, jitter: 0.01 }]]) };
      return c;
    },
    async restartIce() {
      asked.push(['t.restartIce', id]);
    },
  };
  return t;
}

function rig(join: Record<string, any> = {}, options: Record<string, any> = {}) {
  const asked: Array<[string, any]> = [];
  const transports: any[] = [];
  let roomListener: ((m: any) => void) | null = null;
  let stateListener: ((s: string) => void) | null = null;
  let tcount = 0;
  const reply = (over: Record<string, any> = {}) => ({ roomId: 'room-1', identity: 'me', routerRtpCapabilities: { codecs: [] }, iceServers: [], role: 'speaker', peers: [], ...join, ...over });
  const answers: Record<string, (d: any) => any> = {
    'media.join': () => reply(),
    'media.createTransport': () => ({ id: `t${++tcount}`, iceParameters: {}, iceCandidates: [], dtlsParameters: {} }),
    'media.connectTransport': () => ({}),
    'media.produce': () => ({ id: `p${++tcount}` }),
    'media.consume': (d) => ({ id: `c-${d.producerId}`, producerId: d.producerId, kind: d.producerId.includes('v') ? 'video' : 'audio', source: d.producerId.includes('s') ? 'screen' : d.producerId.includes('v') ? 'video' : 'audio', identity: d.producerId === 'p-v2' ? 'bola' : 'ada', rtpParameters: {} }),
  };
  const rt: any = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    request: vi.fn(async (method: string, data: any) => {
      asked.push([method, data]);
      const a = answers[method];
      if (!a) return {};
      return a(data);
    }),
    subscribe: vi.fn((channel: string, fn: (m: any) => void) => {
      roomListener = fn;
      asked.push(['subscribe', channel]);
      return () => undefined;
    }),
    onState: vi.fn((fn: (s: string) => void) => {
      stateListener = fn;
      return () => undefined;
    }),
  };
  const device: any = {
    loaded: false,
    rtpCapabilities: { codecs: ['x'] },
    async load() {
      device.loaded = true;
    },
    createSendTransport: (o: any) => transports.push(fakeTransport(o.id, asked)) && transports[transports.length - 1],
    createRecvTransport: (o: any) => transports.push(fakeTransport(o.id, asked)) && transports[transports.length - 1],
  };
  const track = (kind: string) => ({ kind, stopped: false, stop() { this.stopped = true; }, addEventListener: () => undefined });
  const call = new ZapiackCall({ getToken: async () => 'tok', resyncMs: 0, ...options }, { realtime: rt, device: () => device, getUserMedia: async (c: any) => ({ getAudioTracks: () => (c.audio ? [track('audio')] : []), getVideoTracks: () => (c.video ? [track('video')] : []) }) as any });
  const room = (event: string, data: any) => roomListener!({ event, data, channel: 'call:room-1' });
  const line = (s: string) => stateListener!(s);
  const methods = () => asked.map((a) => a[0]);
  return { call, rt, asked, answers, transports, room, line, methods, track };
}

const tick = () => new Promise<void>((r) => setImmediate(r));
let r: ReturnType<typeof rig>;

describe('joining', () => {
  beforeEach(() => (r = rig()));

  it('connects, joins, loads the device, listens to the room, and joins again to see anything that changed in between', async () => {
    const out = await r.call.join();
    expect(out).toMatchObject({ role: 'speaker', roomId: 'room-1', members: [] });
    expect(r.methods()).toEqual(['media.join', 'subscribe', 'media.join']);
    expect(r.asked[1]).toEqual(['subscribe', 'call:room-1']);
    expect(r.call.state).toBe('joined');
    expect(r.call.role).toBe('speaker');
  });

  it('receives what others are already sending, and tells the app', async () => {
    r = rig({ peers: [{ identity: 'ada', role: 'host', producers: [{ id: 'p-a', kind: 'audio', paused: false }, { id: 'p-v', kind: 'video', paused: false }] }] });
    const tracks: any[] = [];
    const peers: string[] = [];
    r.call.on('track', (t) => tracks.push(`${t.identity}:${t.source}`));
    r.call.on('peerJoined', (p) => peers.push(p.identity));
    await r.call.join();
    expect(peers).toEqual(['ada']);
    expect(tracks.sort()).toEqual(['ada:audio', 'ada:video']);
    // A receive transport is made once, the track is asked for with this device's capabilities, then resumed.
    expect(r.methods().filter((m) => m === 'media.createTransport')).toHaveLength(1);
    expect(r.asked.find((a) => a[0] === 'media.consume')![1]).toMatchObject({ rtpCapabilities: { codecs: ['x'] } });
    expect(r.methods()).toContain('media.resumeConsumer');
  });

  it('closes everything and reports the problem when the join is refused', async () => {
    r.answers['media.join'] = () => {
      throw new ZapiackRealtimeError('This token is not for a call.', 0, 'forbidden');
    };
    await expect(r.call.join()).rejects.toMatchObject({ reason: 'forbidden' });
    expect(r.call.state).toBe('closed');
    expect(r.rt.disconnect).toHaveBeenCalled();
  });
});

describe('sending', () => {
  beforeEach(async () => {
    r = rig();
    await r.call.join();
  });

  it('opens a send transport the first time, connects it and publishes the track under its own name', async () => {
    await r.call.enableMicrophone();
    await r.call.enableCamera();
    const t = r.asked.filter((a) => a[0] === 'media.createTransport');
    expect(t).toHaveLength(1);
    expect(t[0]![1]).toEqual({ direction: 'send' });
    expect(r.asked.filter((a) => a[0] === 'media.produce').map((a) => a[1].kind)).toEqual(['audio', 'video']);
    expect(r.asked.filter((a) => a[0] === 'media.connectTransport')).toHaveLength(1);
    expect(r.call.sending.sort()).toEqual(['audio', 'video']);
  });

  it('sends a shared screen as a screen, not as the camera', async () => {
    await r.call.shareScreen(r.track('video') as any);
    expect(r.asked.find((a) => a[0] === 'media.produce')![1].kind).toBe('screen');
    expect(r.call.sending).toEqual(['screen']);
  });

  it('mutes by pausing and telling the server, and unmutes the same way', async () => {
    await r.call.enableMicrophone();
    await r.call.setMuted('audio', true);
    expect(r.call.isMuted('audio')).toBe(true);
    expect(r.methods()).toContain('media.pauseProducer');
    await r.call.setMuted('audio', false);
    expect(r.call.isMuted('audio')).toBe(false);
    expect(r.methods()).toContain('media.resumeProducer');
  });

  it('stops a track: closes it, lets go of the device and tells the server', async () => {
    const t = await r.call.enableCamera();
    await r.call.stop('video');
    expect((t as any).stopped).toBe(true);
    expect(r.methods()).toContain('media.closeProducer');
    expect(r.call.sending).toEqual([]);
  });

  it('replaces a track sent twice instead of sending two', async () => {
    await r.call.enableMicrophone();
    await r.call.enableMicrophone();
    expect(r.call.sending).toEqual(['audio']);
    expect(r.methods().filter((m) => m === 'media.closeProducer')).toHaveLength(1);
  });

  it('refuses before the join', async () => {
    const fresh = rig();
    await expect(fresh.call.enableMicrophone()).rejects.toThrow(/Join the call first/);
  });
});

describe('a listener', () => {
  it('can receive but is told plainly it cannot send, without asking the server', async () => {
    r = rig({ role: 'listener' });
    await r.call.join();
    await expect(r.call.enableMicrophone()).rejects.toMatchObject({ reason: 'forbidden', message: expect.stringContaining('only listen') });
    expect(r.methods()).not.toContain('media.createTransport');
  });
});

describe('what the room says', () => {
  beforeEach(async () => {
    r = rig();
    await r.call.join();
  });

  it('shows a person who joins, and takes a person who leaves along with their tracks', async () => {
    const seen: string[] = [];
    r.call.on('peerJoined', (p) => seen.push('+' + p.identity));
    r.call.on('peerLeft', (p) => seen.push('-' + p.identity));
    r.call.on('trackEnded', (t) => seen.push('x' + t.source));
    r.room('peerJoined', { identity: 'ada', role: 'host' });
    r.room('newProducer', { identity: 'ada', producerId: 'p-a', kind: 'audio' });
    await tick();
    await tick();
    expect(r.call.members).toEqual([{ identity: 'ada', role: 'host' }]);
    r.room('peerLeft', { identity: 'ada' });
    expect(seen).toEqual(['+ada', 'xaudio', '-ada']);
    expect(r.call.members).toEqual([]);
  });

  it('plays a new track once, even when the room says it twice', async () => {
    const tracks: string[] = [];
    r.call.on('track', (t) => tracks.push(t.producerId));
    r.room('newProducer', { identity: 'ada', producerId: 'p-v', kind: 'video' });
    r.room('newProducer', { identity: 'ada', producerId: 'p-v', kind: 'video' });
    await tick();
    await tick();
    expect(tracks).toEqual(['p-v']);
  });

  it('never tries to receive its own track', async () => {
    r.room('newProducer', { identity: 'me', producerId: 'p-own', kind: 'audio' });
    await tick();
    expect(r.methods()).not.toContain('media.consume');
  });

  it('ends a track when its sender closes it, and passes on a mute', async () => {
    const seen: string[] = [];
    r.call.on('trackEnded', (t) => seen.push('x' + t.source));
    r.call.on('paused', (t) => seen.push(`${t.source}:${t.paused}`));
    r.room('newProducer', { identity: 'ada', producerId: 'p-v', kind: 'video' });
    await tick();
    await tick();
    r.room('producerPaused', { identity: 'ada', producerId: 'p-v', paused: true });
    r.room('producerClosed', { identity: 'ada', producerId: 'p-v' });
    expect(seen).toEqual(['video:true', 'xvideo']);
  });

  it('reports a track it could not play as an event, and carries on', async () => {
    const errors: string[] = [];
    r.call.on('error', (e) => errors.push(e.message));
    r.answers['media.consume'] = () => {
      throw new ZapiackRealtimeError('This device cannot play that track.', 0, 'invalid');
    };
    r.room('newProducer', { identity: 'ada', producerId: 'p-v', kind: 'video' });
    await tick();
    await tick();
    expect(errors).toEqual(['This device cannot play that track.']);
    expect(r.call.state).toBe('joined');
  });

  it('closes the call when the room is ended, and says so', async () => {
    const ended: string[] = [];
    r.call.on('ended', (e) => ended.push(e.reason));
    r.room('roomEnded', { reason: 'ended_by_host' });
    await tick();
    await tick();
    expect(ended).toEqual(['ended_by_host']);
    expect(r.call.state).toBe('closed');
  });
});

describe('receiving numbers', () => {
  it('reports what is arriving for each track', async () => {
    r = rig({ peers: [{ identity: 'ada', role: 'host', producers: [{ id: 'p-a', kind: 'audio', paused: false }] }] });
    await r.call.join();
    expect(await r.call.stats()).toEqual([{ identity: 'ada', source: 'audio', bytesReceived: 5000, packetsReceived: 50, packetsLost: 1, jitter: 0.01 }]);
  });
});

describe('the line dropping', () => {
  it('takes its place again when the line returns, restarts the paths and picks up what changed', async () => {
    r = rig({ peers: [{ identity: 'ada', role: 'host', producers: [{ id: 'p-a', kind: 'audio', paused: false }] }] });
    await r.call.join();
    await r.call.enableMicrophone();
    r.line('reconnecting');
    expect(r.call.state).toBe('reconnecting');
    // While away, Ada stopped sending and Bola joined with a camera.
    r.answers['media.join'] = () => ({ roomId: 'room-1', identity: 'me', routerRtpCapabilities: {}, iceServers: [], role: 'speaker', peers: [{ identity: 'bola', role: 'speaker', producers: [{ id: 'p-v2', kind: 'video', paused: false }] }] });
    const seen: string[] = [];
    r.call.on('trackEnded', (t) => seen.push('x' + t.identity));
    r.call.on('track', (t) => seen.push('+' + t.identity));
    r.call.on('peerLeft', (p) => seen.push('-' + p.identity));
    r.line('connected');
    await new Promise((ok) => setTimeout(ok, 20));
    expect(r.call.state).toBe('joined');
    expect(r.asked.filter((a) => a[0] === 't.restartIce').length).toBeGreaterThan(0);
    expect(seen.sort()).toEqual(['+bola', '-ada', 'xada'].sort());
  });

  it('ends the call when the server no longer knows this person', async () => {
    r = rig();
    await r.call.join();
    r.line('reconnecting');
    r.answers['media.join'] = () => {
      throw new ZapiackRealtimeError('Join the room first.', 0, 'invalid');
    };
    const ended: string[] = [];
    r.call.on('ended', (e) => ended.push(e.reason));
    r.line('connected');
    await new Promise((ok) => setTimeout(ok, 20));
    expect(r.call.state).toBe('closed');
    expect(ended).toEqual(['invalid']);
  });
});

describe('leaving', () => {
  it('tells the server, stops every track and closes the connection', async () => {
    r = rig({ peers: [{ identity: 'ada', role: 'host', producers: [{ id: 'p-a', kind: 'audio', paused: false }] }] });
    await r.call.join();
    const mic = await r.call.enableMicrophone();
    await r.call.leave();
    expect(r.methods()).toContain('media.leave');
    expect((mic as any).stopped).toBe(true);
    expect(r.transports.every((t) => t.closed)).toBe(true);
    expect(r.rt.disconnect).toHaveBeenCalled();
    expect(r.call.state).toBe('closed');
    expect(r.call.members).toEqual([]);
  });
});

describe('catching up on events that never arrived', () => {
  const ada = { identity: 'ada', role: 'host', producers: [{ id: 'p-a', kind: 'audio', paused: false }] };

  it('finds a person and their track that the room events never told it about', async () => {
    r = rig({}, { resyncMs: 20 });
    const log: string[] = [];
    r.call.on('peerJoined', (p) => log.push('+' + p.identity));
    r.call.on('track', (t) => log.push('track:' + t.source));
    await r.call.join();
    // Nothing was announced; the server simply has ada in the room now.
    r.answers['media.join'] = () => ({ roomId: 'room-1', identity: 'me', routerRtpCapabilities: { codecs: [] }, iceServers: [], role: 'speaker', peers: [ada] });
    await new Promise((ok) => setTimeout(ok, 150));
    expect(log).toEqual(['+ada', 'track:audio']);
    await r.call.leave();
  });

  it('notices that someone has gone without hearing about it', async () => {
    r = rig({ peers: [ada] }, { resyncMs: 20 });
    const log: string[] = [];
    r.call.on('peerLeft', (p) => log.push('-' + p.identity));
    r.call.on('trackEnded', (t) => log.push('ended:' + t.source));
    await r.call.join();
    await tick();
    r.answers['media.join'] = () => ({ roomId: 'room-1', identity: 'me', routerRtpCapabilities: { codecs: [] }, iceServers: [], role: 'speaker', peers: [] });
    await new Promise((ok) => setTimeout(ok, 150));
    expect(log.sort()).toEqual(['-ada', 'ended:audio']);
    await r.call.leave();
  });

  it('stops asking once the call is left', async () => {
    r = rig({}, { resyncMs: 20 });
    await r.call.join();
    await r.call.leave();
    const asked = r.methods().filter((m) => m === 'media.join').length;
    await new Promise((ok) => setTimeout(ok, 120));
    expect(r.methods().filter((m) => m === 'media.join').length).toBe(asked);
  });

  it('is not ended by a question that fails', async () => {
    r = rig({}, { resyncMs: 20 });
    await r.call.join();
    r.answers['media.join'] = () => {
      throw new ZapiackRealtimeError('busy', 0, 'internal');
    };
    await new Promise((ok) => setTimeout(ok, 120));
    expect(r.call.state).toBe('joined');
    await r.call.leave();
  });

  it('can be turned off', async () => {
    r = rig({}, { resyncMs: 0 });
    await r.call.join();
    const asked = r.methods().filter((m) => m === 'media.join').length;
    await new Promise((ok) => setTimeout(ok, 120));
    expect(r.methods().filter((m) => m === 'media.join').length).toBe(asked);
    await r.call.leave();
  });
});
