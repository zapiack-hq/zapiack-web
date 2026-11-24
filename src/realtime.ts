/**
 * Zapiack Realtime: live messages over one WebSocket.
 *
 * Your server mints a short-lived token with its API key (`POST /v1/realtime/tokens`) and hands it to the client, so the API key never
 * reaches a browser or an app. The client asks for a token every time it connects, so a token that expires is simply replaced.
 *
 * It reconnects by itself with a growing, jittered pause, re-joins every channel and asks for what it missed since the last persisted
 * message it saw, so a lost signal costs no messages. Nothing here touches push, so it works in any JavaScript runtime that has a
 * WebSocket: browsers, React Native, Node 22+.
 */

export type RealtimeState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface RealtimeMessage<T = unknown> {
  msgId: string;
  ts: number;
  channel: string;
  event: string;
  data: T;
  /** The user id (or connection id) of the sender. */
  from: string | null;
  /** True when it was sent while this client was away and is being replayed. */
  replayed?: boolean;
}

export interface PresenceMember {
  connId: string;
  user: string | null;
  data: unknown;
  at: number;
}

export interface PublishOptions {
  /** The name of the event. Default `message`. */
  event?: string;
  /** Keep it in the channel's history, so clients that were away can replay it. Default false. */
  persist?: boolean;
  /** Wait for the server to confirm. Default true. Pass false to fire and forget. */
  ack?: boolean;
}

export interface PublishResult {
  msgId: string;
  /** How many connections were subscribed when it was sent. */
  delivered: number;
}

export class ZapiackRealtimeError extends Error {
  constructor(
    message: string,
    /** The server's code: 401 token, 403 not allowed, 413 too large, 429 slow down, 503 try again. 0 for a problem on this side. */
    readonly code = 0,
    /** For a failed request (`request()`): the service's own word for it: `forbidden`, `invalid`, `no_route`, `timeout`, `rate_limited` or `internal`. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'ZapiackRealtimeError';
  }
}

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface RealtimeEnv {
  socket(url: string): SocketLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  random(): number;
}

export interface RealtimeOptions {
  /** Returns a fresh token from your server. Called on every connect, so an expired token is replaced. */
  getToken: () => Promise<string>;
  /** Default `wss://rt.zapiack.com`. */
  url?: string;
  /** How often to check the line is alive. Default 25 seconds. */
  heartbeatMs?: number;
  /** The shortest and longest pause before reconnecting. Default 1s and 30s. */
  backoffMs?: { min: number; max: number };
  /** How long to wait for a confirmation. Default 10 seconds. */
  ackTimeoutMs?: number;
}

export const DEFAULT_REALTIME_URL = 'wss://rt.zapiack.com';
const OPEN = 1;
const MAX_OUTBOX = 100;

export const browserRealtimeEnv = (): RealtimeEnv => ({
  socket: (url) => new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  random: () => Math.random(),
});

type Handler = (m: RealtimeMessage) => void;
interface Sub {
  handlers: Set<Handler>;
  /** The last persisted message seen: where to resume from. */
  cursor?: string;
}
interface Waiting {
  resolve: (r: PublishResult) => void;
  reject: (e: Error) => void;
  timer: unknown;
}
interface Pending {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer: unknown;
}

/** Message ids are `milliseconds-sequence`; this orders them. */
const after = (a: string, b?: string) => {
  if (!b) return true;
  const [am = 0, as = 0] = a.split('-').map(Number);
  const [bm = 0, bs = 0] = b.split('-').map(Number);
  return am > bm || (am === bm && as > bs);
};

export class ZapiackRealtime {
  private readonly o: Required<Omit<RealtimeOptions, 'getToken'>> & Pick<RealtimeOptions, 'getToken'>;
  private ws: SocketLike | null = null;
  private _state: RealtimeState = 'idle';
  private readonly subs = new Map<string, Sub>();
  private readonly presenceHandlers = new Map<string, Set<(e: { action: 'enter' | 'update' | 'leave'; member: Partial<PresenceMember> }) => void>>();
  private readonly members = new Map<string, Map<string, PresenceMember>>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly pending = new Map<string, Pending>();
  private rpcSeq = 0;
  private readonly stateHandlers = new Set<(s: RealtimeState) => void>();
  private readonly errorHandlers = new Set<(e: ZapiackRealtimeError) => void>();
  private outbox: string[] = [];
  private attempt = 0;
  private wanted = false;
  private retry: unknown;
  private beat: unknown;
  private heard = 0;
  private ackSeq = 0;
  private first: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /** Set by an error the server marks fatal, for runtimes that cannot see a custom close code. */
  private refused = false;
  private _connId: string | null = null;

  constructor(
    options: RealtimeOptions,
    private readonly env: RealtimeEnv = browserRealtimeEnv(),
    private readonly now: () => number = Date.now,
  ) {
    if (typeof options?.getToken !== 'function') throw new ZapiackRealtimeError('getToken is required: a function that asks your server for a token.');
    this.o = { url: DEFAULT_REALTIME_URL, heartbeatMs: 25_000, backoffMs: { min: 1000, max: 30_000 }, ackTimeoutMs: 10_000, ...options };
  }

  get state(): RealtimeState {
    return this._state;
  }
  /** This connection's id, once connected. Other members use it to signal you. */
  get connectionId(): string | null {
    return this._connId;
  }

  onState(fn: (s: RealtimeState) => void): () => void {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }
  onError(fn: (e: ZapiackRealtimeError) => void): () => void {
    this.errorHandlers.add(fn);
    return () => this.errorHandlers.delete(fn);
  }

  /** Connects and resolves once the server has said hello. It keeps itself connected afterwards until `disconnect()`. */
  connect(): Promise<void> {
    if (this._state === 'connected') return Promise.resolve();
    if (this.first) return new Promise((resolve, reject) => this.chain(resolve, reject));
    this.wanted = true;
    return new Promise((resolve, reject) => {
      this.first = { resolve, reject };
      void this.open();
    });
  }

  private chain(resolve: () => void, reject: (e: Error) => void) {
    const f = this.first!;
    this.first = {
      resolve: () => {
        f.resolve();
        resolve();
      },
      reject: (e) => {
        f.reject(e);
        reject(e);
      },
    };
  }

  /** Leaves for good: closes the socket, forgets the pending sends. Subscriptions stay, for a later `connect()`. */
  disconnect(): void {
    this.wanted = false;
    this.env.clearTimeout(this.retry);
    this.stopBeat();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'bye');
    this.failAll(new ZapiackRealtimeError('Disconnected.'));
    this.outbox = [];
    this.set('closed');
  }

  /** Calls `handler` for every message on the channel, now and after reconnects. Returns how to stop. */
  subscribe(channel: string, handler: Handler, options: { resumeFrom?: string } = {}): () => void {
    let sub = this.subs.get(channel);
    const fresh = !sub;
    if (!sub) this.subs.set(channel, (sub = { handlers: new Set(), cursor: options.resumeFrom }));
    sub.handlers.add(handler);
    if (fresh) this.send({ op: 'subscribe', channel, resumeFrom: sub.cursor });
    return () => {
      const s = this.subs.get(channel);
      if (!s) return;
      s.handlers.delete(handler);
      if (s.handlers.size === 0) {
        this.subs.delete(channel);
        this.presenceHandlers.delete(channel);
        this.members.delete(channel);
        this.send({ op: 'unsubscribe', channel });
      }
    };
  }

  /** Sends a message. Resolves when the server confirms, unless `ack: false`. */
  publish(channel: string, data: unknown, options: PublishOptions = {}): Promise<PublishResult | void> {
    const frame: Record<string, unknown> = { op: 'publish', channel, event: options.event ?? 'message', data, persist: options.persist === true };
    if (options.ack === false) {
      this.send(frame);
      return Promise.resolve();
    }
    const ackId = `a${++this.ackSeq}`;
    frame['ackId'] = ackId;
    return new Promise<PublishResult>((resolve, reject) => {
      const timer = this.env.setTimeout(() => {
        this.waiting.delete(ackId);
        reject(new ZapiackRealtimeError('The server did not confirm in time.', 0));
      }, this.o.ackTimeoutMs);
      this.waiting.set(ackId, { resolve, reject, timer });
      if (!this.send(frame)) {
        this.settle(ackId)?.reject(new ZapiackRealtimeError('Could not send: too many messages waiting for a connection.', 429));
      }
    });
  }

  /**
   * Asks a Zapiack service something over this connection and waits for the answer: the way a call client talks to the media server.
   * Needs a token minted for a call. It is never queued for later: if the line is down it fails at once, because an answer to an old
   * question is worse than none.
   */
  request<T = unknown>(method: string, data: unknown = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== OPEN || this._state !== 'connected') return Promise.reject(new ZapiackRealtimeError('Not connected.', 0, 'no_route'));
    const correlationId = `r${++this.rpcSeq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = this.env.setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new ZapiackRealtimeError('The server did not answer in time.', 0, 'timeout'));
      }, this.o.ackTimeoutMs + 2000);
      this.pending.set(correlationId, { resolve: resolve as (d: unknown) => void, reject, timer });
      this.ws!.send(JSON.stringify({ op: 'rpc', method, correlationId, data }));
    });
  }

  /** Sends to one connection in a channel you are subscribed to. Used for peer-to-peer setup such as WebRTC. */
  signal(channel: string, to: string, event: string, data: unknown): void {
    this.send({ op: 'signal', channel, to, event, data });
  }

  /** Presence in a channel you are subscribed to. */
  presence(channel: string) {
    return {
      enter: (data: unknown = null) => this.send({ op: 'presence.enter', channel, data }),
      update: (data: unknown) => this.send({ op: 'presence.update', channel, data }),
      leave: () => this.send({ op: 'presence.leave', channel }),
      /** Who is here now, as last told. */
      members: (): PresenceMember[] => [...(this.members.get(channel)?.values() ?? [])],
      onChange: (fn: (e: { action: 'enter' | 'update' | 'leave'; member: Partial<PresenceMember> }) => void) => {
        let set = this.presenceHandlers.get(channel);
        if (!set) this.presenceHandlers.set(channel, (set = new Set()));
        set.add(fn);
        return () => set.delete(fn);
      },
    };
  }

  // ───────────────────────────── internals

  private set(s: RealtimeState) {
    if (this._state === s) return;
    this._state = s;
    for (const fn of this.stateHandlers) fn(s);
  }
  private fail(e: ZapiackRealtimeError) {
    for (const fn of this.errorHandlers) fn(e);
  }
  private settle(ackId: string) {
    const w = this.waiting.get(ackId);
    if (!w) return undefined;
    this.waiting.delete(ackId);
    this.env.clearTimeout(w.timer);
    return w;
  }
  private failAll(e: Error) {
    for (const id of [...this.waiting.keys()]) this.settle(id)?.reject(e);
    this.failRequests(e);
  }
  private failRequests(e: Error) {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      this.env.clearTimeout(p.timer);
      p.reject(e);
    }
  }

  /** Writes now if the line is open, otherwise keeps it (a short while) for when it is. False when there is no room. */
  private send(frame: Record<string, unknown>): boolean {
    const text = JSON.stringify(frame);
    if (this.ws && this.ws.readyState === OPEN && this._state === 'connected') {
      this.ws.send(text);
      return true;
    }
    // A subscribe is re-sent from `subs` when the line opens, so queueing it too would only say it twice.
    if (frame['op'] === 'subscribe' || frame['op'] === 'unsubscribe') return true;
    if (this.outbox.length >= MAX_OUTBOX) return false;
    this.outbox.push(text);
    return true;
  }

  private async open() {
    if (!this.wanted) return;
    this.set(this.attempt === 0 && this._state !== 'reconnecting' ? 'connecting' : 'reconnecting');
    let token: string;
    try {
      token = await this.o.getToken();
      if (!token || typeof token !== 'string') throw new Error('getToken returned no token.');
    } catch (e) {
      this.fail(new ZapiackRealtimeError(`Could not get a token: ${e instanceof Error ? e.message : String(e)}`, 0));
      return this.later();
    }
    if (!this.wanted) return;
    let ws: SocketLike;
    try {
      ws = this.env.socket(`${this.o.url.replace(/\/+$/, '')}/?token=${encodeURIComponent(token)}`);
    } catch (e) {
      this.fail(new ZapiackRealtimeError(`Could not open the connection: ${e instanceof Error ? e.message : String(e)}`, 0));
      return this.later();
    }
    this.ws = ws;
    ws.onmessage = (ev) => this.onFrame(ws, ev.data);
    ws.onerror = () => undefined;
    ws.onclose = (ev) => this.onClose(ws, ev?.code ?? 1006);
  }

  private onFrame(ws: SocketLike, raw: unknown) {
    if (ws !== this.ws) return;
    this.heard = this.now();
    let f: Record<string, any>;
    try {
      f = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (f['op']) {
      case 'hello':
        this._connId = f['connId'];
        this.attempt = 0;
        this.set('connected');
        this.rejoin();
        for (const text of this.outbox.splice(0)) ws.send(text);
        this.startBeat(ws);
        this.first?.resolve();
        this.first = null;
        return;
      case 'message':
        return this.onMessage(f as unknown as RealtimeMessage & { persisted?: boolean });
      case 'ack': {
        this.settle(f['ackId'])?.resolve({ msgId: f['msgId'], delivered: f['delivered'] ?? 0 });
        return;
      }
      case 'rpc.result':
      case 'rpc.error': {
        const id = String(f['correlationId']);
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this.env.clearTimeout(p.timer);
        if (f['op'] === 'rpc.result') p.resolve(f['data']);
        else p.reject(new ZapiackRealtimeError(String(f['message'] ?? 'The request failed.'), 0, String(f['code'] ?? 'internal')));
        return;
      }
      case 'error': {
        if (f['fatal'] === true) this.refused = true;
        const err = new ZapiackRealtimeError(String(f['message'] ?? 'Error'), Number(f['code'] ?? 0));
        const ref = typeof f['ref'] === 'string' ? f['ref'] : undefined;
        if (ref && this.settle(ref)?.reject(err)) return;
        return this.fail(err);
      }
      case 'presence.members': {
        const map = new Map<string, PresenceMember>();
        for (const m of f['members'] ?? []) map.set(m.connId, m);
        this.members.set(f['channel'], map);
        return;
      }
      case 'resume.failed':
        // Too long away to replay: the app should reload what it needs over REST. Say so rather than hide the gap.
        return this.fail(new ZapiackRealtimeError(`Missed messages on ${f['channel']} could not be replayed. Reload its history.`, 410));
    }
  }

  private onMessage(m: RealtimeMessage & { persisted?: boolean }) {
    if (m.event.startsWith('presence.')) return this.onPresence(m);
    const sub = this.subs.get(m.channel);
    if (!sub) return;
    if (m.persisted) {
      // Seen already (a replay overlapping a live message): once is enough.
      if (!after(m.msgId, sub.cursor)) return;
      sub.cursor = m.msgId;
    }
    for (const h of [...sub.handlers]) {
      try {
        h(m);
      } catch {
        /* a handler's bug must not stop the others or the connection */
      }
    }
  }

  private onPresence(m: RealtimeMessage) {
    const d = m.data as { connId: string; user: string | null; data: unknown };
    const action = m.event.slice('presence.'.length) as 'enter' | 'update' | 'leave';
    const map = this.members.get(m.channel) ?? new Map<string, PresenceMember>();
    this.members.set(m.channel, map);
    if (action === 'leave') map.delete(d.connId);
    else map.set(d.connId, { connId: d.connId, user: d.user, data: d.data, at: m.ts });
    for (const fn of this.presenceHandlers.get(m.channel) ?? []) fn({ action, member: { connId: d.connId, user: d.user, data: d.data } });
  }

  private rejoin() {
    for (const [channel, sub] of this.subs) this.ws?.send(JSON.stringify({ op: 'subscribe', channel, resumeFrom: sub.cursor }));
  }

  private startBeat(ws: SocketLike) {
    this.stopBeat();
    this.heard = this.now();
    this.beat = this.env.setInterval(() => {
      if (ws !== this.ws) return;
      // Nothing heard for two beats: the line is dead even if the socket says otherwise. Drop it and start again.
      if (this.now() - this.heard > this.o.heartbeatMs * 2) return void ws.close(4000, 'no heartbeat');
      if (ws.readyState === OPEN) ws.send('{"op":"ping"}');
    }, this.o.heartbeatMs);
  }
  private stopBeat() {
    this.env.clearInterval(this.beat);
    this.beat = undefined;
  }

  private onClose(ws: SocketLike, code: number) {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopBeat();
    this._connId = null;
    this.failRequests(new ZapiackRealtimeError('The connection dropped.', 0, 'no_route'));
    if (!this.wanted) return;
    // 4403: the project switched this client off, or Realtime is off. Trying again would only be refused again.
    if (code === 4403 || this.refused) {
      this.refused = false;
      this.wanted = false;
      this.failAll(new ZapiackRealtimeError('The project does not allow this connection.', 403));
      this.first?.reject(new ZapiackRealtimeError('The project does not allow this connection.', 403));
      this.first = null;
      this.set('closed');
      return;
    }
    // 4401 means the token was refused or ran out: fetching a new one is exactly what the next attempt does.
    this.set('reconnecting');
    this.later(code === 4401 || code === 1012 ? 0 : undefined);
  }

  private later(force?: number) {
    this.env.clearTimeout(this.retry);
    this.attempt += 1;
    const { min, max } = this.o.backoffMs;
    const ceiling = Math.min(max, min * 2 ** (this.attempt - 1));
    // Full jitter, so a node that restarts is not met by every client at the same moment.
    const wait = force ?? Math.round(min + this.env.random() * (ceiling - min));
    this.set('reconnecting');
    this.retry = this.env.setTimeout(() => void this.open(), wait);
  }
}
