import { BrowserEnv } from '../src/client';
import { MemoryStore } from '../src/storage';
import { SwScope } from '../src/sw-handlers';

export const KEY = 'pk_testkey_1234567890';
export const BASE = 'https://api.example.test/v1';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: Call) => { status?: number; body?: unknown } | Error;

/** A fetch that answers the SDK routes: config, register and events. Override any of them, or make one fail. */
export function fakeApi(overrides: { config?: Handler; devices?: Handler; events?: Handler } = {}) {
  const calls: Call[] = [];
  const defaults: Record<string, Handler> = {
    config: () => ({ body: { appId: 'app1', vapidPublicKey: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM' } }),
    devices: () => ({ body: { deviceId: 'd1', installationId: 'i' } }),
    events: (c) => ({ body: { accepted: c.body.events.length, ignored: 0, rejected: [] } }),
  };
  const fn = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const call: Call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = url.split('/push/sdk/')[1] ?? '';
    const answer = (overrides as Record<string, Handler | undefined>)[route]?.(call) ?? defaults[route]?.(call) ?? { status: 404 };
    if (answer instanceof Error) throw answer;
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.body, text: async () => JSON.stringify(answer.body ?? '') };
  }) as unknown as typeof fetch;
  return { fn, calls, of: (route: string) => calls.filter((c) => c.url.endsWith(`/push/sdk/${route}`)) };
}

/** A push manager that remembers its subscription, as a browser does. */
export function fakePushManager(endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
  let subscription: { toJSON(): unknown; unsubscribe(): Promise<boolean> } | null = null;
  let subscribes = 0;
  const make = () => ({
    toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-secret' } }),
    unsubscribe: async () => {
      subscription = null;
      return true;
    },
  });
  return {
    manager: {
      getSubscription: async () => subscription,
      subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
        subscribes++;
        expectedKeys.push(options);
        subscription = make();
        return subscription;
      },
    },
    subscribes: () => subscribes,
    has: () => subscription !== null,
    keys: expectedKeys,
  };
}
const expectedKeys: Array<{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }> = [];

/** A browser the SDK can run in, with the clock, the address bar and the permission prompt in the test's hands. */
export function fakeBrowser(opts: { permission?: string; prompt?: string; supported?: boolean; fetch?: typeof fetch; store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const push = fakePushManager();
  const api = fakeApi();
  let permission = opts.permission ?? 'default';
  const state = { now: 1_800_000_000_000, path: '/', registered: [] as Array<{ url: string; scope?: string }> };
  const listeners = new Map<string, Set<() => void>>();
  const swListeners: Array<(e: { data?: unknown }) => void> = [];
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const lifecycle: Array<() => void> = [];
  let timerId = 0;
  const registration = { pushManager: push.manager };

  const history = {
    pushState: (_data: unknown, _t: string, url?: string) => url && (state.path = url),
    replaceState: (_data: unknown, _t: string, url?: string) => url && (state.path = url),
  };

  const env: BrowserEnv = {
    store,
    fetch: opts.fetch ?? api.fn,
    serviceWorker: {
      register: async (url, options) => (state.registered.push({ url, scope: options?.scope }), registration),
      ready: Promise.resolve(registration),
      addEventListener: (_type, listener) => void swListeners.push(listener),
    },
    notification: {
      get permission() {
        return permission;
      },
      requestPermission: async () => (permission = opts.prompt ?? 'granted'),
    },
    supported: opts.supported ?? true,
    tracker: {
      now: () => state.now,
      pathname: () => state.path,
      history,
      listen: (type, listener) => {
        (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener);
        return () => listeners.get(type)?.delete(listener);
      },
      setTimeout: (fn, ms) => {
        const id = ++timerId;
        timers.push({ id, at: state.now + ms, fn });
        return id;
      },
      clearTimeout: (id) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    onLifecycle: (fn) => {
      lifecycle.push(fn);
      return () => lifecycle.splice(lifecycle.indexOf(fn), 1);
    },
    setInterval: (fn, ms) => (intervals.push({ fn, ms }), intervals.length),
    clearInterval: () => undefined,
  };

  return {
    env, store, push, api, state, history, intervals, lifecycle, registration,
    setPermission: (p: string) => (permission = p),
    navigate: (path: string) => history.pushState(null, '', path),
    fire: (type: string) => listeners.get(type)?.forEach((l) => l()),
    advance: (ms: number) => {
      state.now += ms;
      for (const t of timers.filter((x) => x.at <= state.now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
    message: (data: unknown) => swListeners.forEach((l) => l({ data })),
  };
}

export const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A service worker's scope: listeners to fire events at, and records of what it showed and opened. */
export function fakeScope(windows: Array<{ url: string; focus?: () => Promise<unknown> }> = []) {
  const listeners = new Map<string, (event: any) => void>();
  const shown: Array<{ title: string; options: Record<string, any> }> = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const messages: Array<{ url: string; message: any }> = [];
  const subscribed: Array<{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }> = [];

  const clients = windows.map((w) => ({
    url: w.url,
    focus: async () => void focused.push(w.url),
    postMessage: (message: unknown) => void messages.push({ url: w.url, message }),
  }));

  const scope: SwScope = {
    addEventListener: (type, listener) => void listeners.set(type, listener),
    registration: {
      showNotification: async (title, options) => void shown.push({ title, options }),
      pushManager: { subscribe: async (o) => (subscribed.push(o), { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'k', auth: 'a' } }) }) },
    },
    clients: {
      matchAll: async () => clients,
      openWindow: async (url) => {
        opened.push(url);
        return { url, postMessage: (message: unknown) => void messages.push({ url, message }) };
      },
    },
    location: { origin: 'https://myshop.com' },
  };

  /** Fires an event and waits for what the handler passed to `waitUntil`. */
  const fire = async (type: string, event: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };

  return { scope, fire, shown, opened, focused, messages, subscribed, has: (t: string) => listeners.has(t) };
}
