import { SdkApi } from './api';
import { uuid } from './ids';
import { EventQueue } from './queue';
import { KeyValueStore } from './storage';
import { ActiveSession, CONFIG_KEY, ClickInfo, DEFAULT_WINDOW_MINUTES, INSTALLATION_KEY, PENDING_CLICK_KEY, PushBlock, SESSION_KEY, StoredConfig } from './types';

interface WindowClient {
  url: string;
  focus?: () => Promise<unknown>;
  postMessage(message: unknown): void;
}

/** The parts of a service worker's scope the handlers use. */
export interface SwScope {
  addEventListener(type: string, listener: (event: any) => void): void;
  registration: {
    showNotification(title: string, options: Record<string, unknown>): Promise<void>;
    pushManager: {
      subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<{ toJSON(): unknown }>;
    };
  };
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<WindowClient | null>;
  };
  location: { origin: string };
}

export interface SwDeps {
  store: KeyValueStore;
  fetch?: typeof fetch;
  now?: () => number;
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

interface PushPayload {
  title?: string;
  body?: string;
  image?: string;
  tag?: string;
  data?: Record<string, unknown>;
  actions?: Array<{ action: string; title: string }>;
  zapiack?: PushBlock;
}

/** Only web links open: nothing here may be turned into a way to run script. */
function openableUrl(link: string | undefined, origin: string): string | undefined {
  if (!link) return undefined;
  try {
    const url = new URL(link, origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const sameDocument = (a: string, b: string) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
  } catch {
    return false;
  }
};

/**
 * What the service worker does for Zapiack: show a push when it arrives and report that it did, and when it is tapped, report
 * the tap, open the link and leave a note for the page about what was tapped so it can follow what happens next.
 */
export function registerHandlers(scope: SwScope, deps: SwDeps): void {
  const now = deps.now ?? Date.now;

  const services = async () => {
    const config = await deps.store.get<StoredConfig>(CONFIG_KEY);
    if (!config) return undefined;
    const api = new SdkApi(config.baseUrl, config.appKey, deps.fetch);
    return { config, api, queue: new EventQueue(deps.store, () => api) };
  };

  scope.addEventListener('push', (event) => {
    event.waitUntil(
      (async () => {
        let payload: PushPayload | undefined;
        try {
          payload = event.data?.json() as PushPayload | undefined;
        } catch {
          return;
        }
        if (!payload?.title) return;

        const block = payload.zapiack;
        await scope.registration.showNotification(payload.title, {
          body: payload.body,
          ...(payload.image ? { image: payload.image } : {}),
          ...(payload.tag ? { tag: payload.tag } : {}),
          ...(payload.actions?.length ? { actions: payload.actions } : {}),
          data: { ...(payload.data ?? {}), zapiack: block },
        });

        if (block?.d) {
          const s = await services();
          if (s) {
            await s.queue.add({ type: 'received', deliveryId: block.d });
            await s.queue.flush();
          }
        }
      })(),
    );
  });

  scope.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
      (async () => {
        const block = (event.notification.data as { zapiack?: PushBlock } | undefined)?.zapiack;
        const button = event.action ? block?.a?.find((a) => a.id === event.action) : undefined;
        const link = openableUrl(button?.link ?? block?.l, scope.location.origin);

        let click: ClickInfo | undefined;
        if (block?.d) {
          const sessionId = uuid();
          const at = now();
          click = { messageId: block.m, deliveryId: block.d, sessionId, ...(button ? { actionId: button.id } : {}), event: button ? button.event : block.e, link, at };
          const session: ActiveSession = { sessionId, deliveryId: block.d, messageId: block.m, startedAt: at, windowMinutes: block.t?.w ?? DEFAULT_WINDOW_MINUTES, screens: Boolean(block.t?.s) };

          // The note and the session are written first: the page may load before the report below has finished.
          await deps.store.set(SESSION_KEY, session);
          await deps.store.set(PENDING_CLICK_KEY, click);

          const s = await services();
          if (s) {
            await s.queue.add({
              type: button ? 'action' : 'clicked',
              deliveryId: block.d,
              sessionId,
              ...(button ? { actionId: button.id } : {}),
              ...((button ? button.event : block.e) ? { name: button ? button.event : block.e } : {}),
              at,
            });
            await s.queue.flush();
          }
        }

        const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = link ? windows.find((w) => sameDocument(w.url, link)) : windows[0];
        // The browser may refuse to open a window (no permission, or the tap was not a user action). The tap is already reported and
        // the page that is open must still hear about it, so a refusal is not an error here.
        const opened = await (async () => {
          try {
            return existing?.focus ? (await existing.focus(), existing) : await scope.clients.openWindow(link ?? '/');
          } catch {
            return null;
          }
        })();

        if (click) for (const w of opened ? [opened, ...windows] : windows) w.postMessage({ zapiack: 'click', click });
      })(),
    );
  });

  // The browser replaced the subscription: subscribe again and tell Zapiack, so pushes keep arriving.
  scope.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(
      (async () => {
        const s = await services();
        const installationId = await deps.store.get<string>(INSTALLATION_KEY);
        if (!s || !s.config.vapidPublicKey || !installationId) return;
        const subscription = await scope.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(s.config.vapidPublicKey) });
        await s.api.register({ installationId, platform: 'web', token: subscription.toJSON(), permission: 'granted' });
      })().catch(() => undefined),
    );
  });
}
