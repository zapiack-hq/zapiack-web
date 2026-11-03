import { RegisterBody, SdkApi } from './api';
import { uuid } from './ids';
import { EventQueue } from './queue';
import { SessionTracker, TrackerEnv } from './session';
import { IdbStore, KeyValueStore } from './storage';
import { base64UrlToBytes } from './sw-handlers';
import { CONFIG_KEY, ClickInfo, DEFAULT_BASE_URL, INSTALLATION_KEY, PENDING_CLICK_KEY, Permission, StoredConfig, TAGS_KEY, Tags, USER_KEY } from './types';

interface Subscription {
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

interface Registration {
  pushManager: {
    getSubscription(): Promise<Subscription | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<Subscription>;
  };
}

export interface BrowserEnv {
  store: KeyValueStore;
  fetch: typeof fetch;
  serviceWorker?: {
    register(url: string, options?: { scope?: string }): Promise<Registration>;
    ready: Promise<Registration>;
    addEventListener(type: 'message', listener: (event: { data?: unknown }) => void): void;
  };
  notification?: { permission: string; requestPermission(): Promise<string> };
  /** Whether this browser can do web push at all. */
  supported: boolean;
  tracker: TrackerEnv;
  /** Runs `fn` when the page is hidden, closing or back online. Returns how to stop. */
  onLifecycle: (fn: () => void) => () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

export interface InitOptions {
  /** Your app's public key, from the dashboard. Safe to put in your page. */
  appKey: string;
  baseUrl?: string;
  /** Where you host the service worker file. Default `/zapiack-sw.js`. */
  serviceWorkerPath?: string;
  serviceWorkerScope?: string;
  /** Register this browser again on every page load while permission is granted. Default true. */
  autoRegister?: boolean;
  appVersion?: string;
}

export type ClickHandler = (click: ClickInfo) => void;

export class ZapiackPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZapiackPushError';
  }
}

const FLUSH_EVERY_MS = 15_000;
const PENDING_CLICK_MAX_AGE_MS = 60_000;

export function browserEnv(): BrowserEnv {
  const g = globalThis as any;
  const hasPush = Boolean(g.navigator?.serviceWorker && g.PushManager && g.Notification);
  return {
    store: new IdbStore(),
    fetch: (...args) => g.fetch(...args),
    serviceWorker: g.navigator?.serviceWorker,
    notification: g.Notification,
    supported: hasPush,
    tracker: {
      now: () => Date.now(),
      pathname: () => g.location?.pathname ?? '/',
      history: g.history,
      listen: (type, listener) => {
        g.addEventListener?.(type, listener);
        return () => g.removeEventListener?.(type, listener);
      },
      setTimeout: (fn, ms) => g.setTimeout(fn, ms),
      clearTimeout: (id) => g.clearTimeout(id as number),
    },
    onLifecycle: (fn) => {
      const onHide = () => g.document?.visibilityState !== 'visible' && fn();
      g.addEventListener?.('pagehide', fn);
      g.addEventListener?.('online', fn);
      g.document?.addEventListener?.('visibilitychange', onHide);
      return () => {
        g.removeEventListener?.('pagehide', fn);
        g.removeEventListener?.('online', fn);
        g.document?.removeEventListener?.('visibilitychange', onHide);
      };
    },
    setInterval: (fn, ms) => g.setInterval(fn, ms),
    clearInterval: (id) => g.clearInterval(id as number),
  };
}

interface UserState {
  externalUserId: string | null;
  /** Not yet told to Zapiack. */
  dirty: boolean;
}

export class ZapiackPushClient {
  private options?: InitOptions;
  private api?: SdkApi;
  private queue?: EventQueue;
  private tracker?: SessionTracker;
  private readonly handlers = new Set<ClickHandler>();
  private timer?: unknown;
  private stopLifecycle?: () => void;
  private registering?: Promise<void>;

  constructor(private readonly makeEnv: () => BrowserEnv = browserEnv) {}

  private env!: BrowserEnv;

  /** Whether this browser can receive web push. False in older browsers and in some in-app browsers. */
  isSupported(): boolean {
    return (this.env ?? this.makeEnv()).supported;
  }

  /** What the visitor has answered: `granted`, `denied`, or `default` for not yet asked. */
  permission(): Permission {
    const env = this.env ?? this.makeEnv();
    const p = env.notification?.permission;
    return p === 'granted' || p === 'denied' ? p : 'default';
  }

  /** Sets Zapiack up. Safe to call on every page load. */
  async init(options: InitOptions): Promise<void> {
    if (!/^pk_[A-Za-z0-9_-]{10,}$/.test(options.appKey)) {
      throw new ZapiackPushError('init needs your public app key, which starts with pk_. A secret API key must never be used in a page.');
    }
    this.env = this.makeEnv();
    this.options = options;
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.api = new SdkApi(baseUrl, options.appKey, this.env.fetch);
    this.queue = new EventQueue(this.env.store, () => this.api);
    this.tracker = new SessionTracker(this.env.store, this.queue, this.env.tracker);

    const previous = await this.env.store.get<StoredConfig>(CONFIG_KEY);
    await this.env.store.set<StoredConfig>(CONFIG_KEY, { appKey: options.appKey, baseUrl, vapidPublicKey: previous?.appKey === options.appKey ? previous.vapidPublicKey : undefined });

    if (this.env.supported && this.env.serviceWorker) {
      await this.env.serviceWorker.register(options.serviceWorkerPath ?? '/zapiack-sw.js', { scope: options.serviceWorkerScope });
      this.env.serviceWorker.addEventListener('message', (event) => {
        const data = event.data as { zapiack?: string; click?: ClickInfo } | undefined;
        if (data?.zapiack === 'click' && data.click) void this.handleClick(data.click);
      });
    }

    await this.tracker.resume();
    await this.deliverPendingClick();

    this.stopLifecycle?.();
    this.stopLifecycle = this.env.onLifecycle(() => void this.queue?.flush());
    if (this.timer !== undefined) this.env.clearInterval(this.timer);
    this.timer = this.env.setInterval(() => void this.queue?.flush(), FLUSH_EVERY_MS);

    if (this.permission() === 'granted' && options.autoRegister !== false) await this.register().catch(() => undefined);
    await this.queue.flush();
  }

  private ready(): { env: BrowserEnv; api: SdkApi; queue: EventQueue; tracker: SessionTracker; options: InitOptions } {
    if (!this.options || !this.api || !this.queue || !this.tracker) throw new ZapiackPushError('Call init first.');
    return { env: this.env, api: this.api, queue: this.queue, tracker: this.tracker, options: this.options };
  }

  /** A UUID made on first use and kept, that identifies this browser to Zapiack even when its push address changes. */
  async installationId(): Promise<string> {
    const store = (this.env ?? this.makeEnv()).store;
    const existing = await store.get<string>(INSTALLATION_KEY);
    if (existing) return existing;
    const created = uuid();
    await store.set(INSTALLATION_KEY, created);
    return created;
  }

  /** Asks the visitor for permission, and when they agree, subscribes this browser and registers it. Call it from a click. */
  async requestPermission(): Promise<Permission> {
    const { env } = this.ready();
    if (!env.supported || !env.notification) return 'denied';
    const answer = await env.notification.requestPermission();
    const permission: Permission = answer === 'granted' || answer === 'denied' ? answer : 'default';
    if (permission === 'granted') await this.register();
    else if (permission === 'denied') await this.tell('denied').catch(() => undefined);
    return permission;
  }

  /** Subscribes this browser if it is not already, and tells Zapiack about it. Runs on its own while permission is granted. */
  register(): Promise<void> {
    this.registering ??= this.doRegister().finally(() => {
      this.registering = undefined;
    });
    return this.registering;
  }

  private async doRegister(): Promise<void> {
    const { env, api, options } = this.ready();
    if (!env.supported || !env.serviceWorker) throw new ZapiackPushError('This browser cannot receive push notifications.');
    if (this.permission() !== 'granted') throw new ZapiackPushError('Permission has not been granted. Call requestPermission first.');

    const config = (await env.store.get<StoredConfig>(CONFIG_KEY))!;
    let vapid = config.vapidPublicKey;
    if (!vapid) {
      vapid = (await api.config()).vapidPublicKey;
      if (!vapid) throw new ZapiackPushError('Web push is not turned on for this app. Enable the web platform in the dashboard.');
      await env.store.set<StoredConfig>(CONFIG_KEY, { ...config, vapidPublicKey: vapid });
    }

    const registration = await env.serviceWorker.ready;
    const subscription = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapid) }));

    const user = await env.store.get<UserState>(USER_KEY);
    const tags = await env.store.get<Tags>(TAGS_KEY);
    const body: RegisterBody = {
      installationId: await this.installationId(),
      platform: 'web',
      token: subscription.toJSON(),
      permission: 'granted',
      ...(options.appVersion ? { appVersion: options.appVersion } : {}),
      // Only what the app changed is sent, so an ordinary page load never overwrites what the server knows.
      ...(user?.dirty ? { externalUserId: user.externalUserId } : {}),
      ...(tags ? { tags } : {}),
    };
    await api.register(body);
    if (user?.dirty) await env.store.set<UserState>(USER_KEY, { ...user, dirty: false });
  }

  /** Tells Zapiack the visitor's answer when it is a no, so pushes stop going to this browser. */
  private async tell(permission: 'denied'): Promise<void> {
    const { env, api } = this.ready();
    const registration = env.serviceWorker ? await env.serviceWorker.ready : undefined;
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await api.register({ installationId: await this.installationId(), platform: 'web', token: subscription.toJSON(), permission });
  }

  /** Links this browser to your own user. Use the id your server knows them by. */
  async login(externalUserId: string): Promise<void> {
    const { env } = this.ready();
    await env.store.set<UserState>(USER_KEY, { externalUserId, dirty: true });
    if (this.permission() === 'granted') await this.register().catch(() => undefined);
  }

  /** Unlinks this browser from the user, for sign-out. It stays subscribed, and can still receive pushes meant for everyone. */
  async logout(): Promise<void> {
    const { env } = this.ready();
    await env.store.set<UserState>(USER_KEY, { externalUserId: null, dirty: true });
    if (this.permission() === 'granted') await this.register().catch(() => undefined);
  }

  async addTags(tags: Tags): Promise<void> {
    const { env } = this.ready();
    await env.store.set<Tags>(TAGS_KEY, { ...((await env.store.get<Tags>(TAGS_KEY)) ?? {}), ...tags });
    if (this.permission() === 'granted') await this.register().catch(() => undefined);
  }

  async removeTags(keys: string[]): Promise<void> {
    const { env } = this.ready();
    const current = { ...((await env.store.get<Tags>(TAGS_KEY)) ?? {}) };
    for (const key of keys) delete current[key];
    await env.store.set<Tags>(TAGS_KEY, current);
    if (this.permission() === 'granted') await this.register().catch(() => undefined);
  }

  /**
   * Reports something the visitor did, credited to the push they tapped. Does nothing, and returns false, when they did not arrive
   * from a push or the window the push allowed has passed.
   */
  async track(name: string, properties?: Record<string, unknown>): Promise<boolean> {
    const { tracker, queue } = this.ready();
    const reported = await tracker.track(name, properties);
    if (reported) void queue.flush();
    return reported;
  }

  /** Runs `handler` when a notification is tapped, with what was tapped and where it leads. Returns how to stop. */
  onClick(handler: ClickHandler): () => void {
    this.handlers.add(handler);
    void this.deliverPendingClick();
    return () => this.handlers.delete(handler);
  }

  private async handleClick(click: ClickInfo): Promise<void> {
    const { env, tracker } = this.ready();
    await env.store.delete(PENDING_CLICK_KEY);
    await tracker.resume();
    for (const handler of this.handlers) {
      try {
        handler(click);
      } catch {
        /* one handler's mistake must not stop the others */
      }
    }
  }

  /** A tap that opened this page before it had a handler is delivered once a handler exists. */
  private async deliverPendingClick(): Promise<void> {
    if (!this.options || this.handlers.size === 0) return;
    const { env } = this.ready();
    const click = await env.store.get<ClickInfo>(PENDING_CLICK_KEY);
    if (!click) return;
    await env.store.delete(PENDING_CLICK_KEY);
    if (env.tracker.now() - click.at > PENDING_CLICK_MAX_AGE_MS) return;
    for (const handler of this.handlers) {
      try {
        handler(click);
      } catch {
        /* one handler's mistake must not stop the others */
      }
    }
  }

  /** Stops notifications for this browser. */
  async unsubscribe(): Promise<void> {
    const { env } = this.ready();
    const registration = env.serviceWorker ? await env.serviceWorker.ready : undefined;
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await this.tell('denied').catch(() => undefined);
    await subscription.unsubscribe();
  }
}
