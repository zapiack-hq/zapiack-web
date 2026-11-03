import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/storage';
import { base64UrlToBytes, registerHandlers } from '../src/sw-handlers';
import { ActiveSession, ClickInfo } from '../src/types';
import { BASE, fakeApi, fakeScope, KEY } from './helpers';

const block = { m: 'msg_1', d: 'dlv_1', l: 'https://myshop.com/orders/1', e: 'order_opened', a: [{ id: 'track', title: 'Track', event: 'track_clicked', link: 'https://myshop.com/orders/1/track' }] };
const NOW = 1_800_000_000_000;

async function setup(opts: { configured?: boolean; windows?: Array<{ url: string }>; api?: ReturnType<typeof fakeApi> } = {}) {
  const store = new MemoryStore();
  if (opts.configured !== false) await store.set('config', { appKey: KEY, baseUrl: BASE, vapidPublicKey: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM' });
  const api = opts.api ?? fakeApi();
  const sw = fakeScope(opts.windows);
  registerHandlers(sw.scope, { store, fetch: api.fn, now: () => NOW });
  return { store, api, sw };
}

const pushEvent = (payload: unknown) => ({ data: { json: () => payload } });
const tap = (data: unknown, action = '') => {
  let closed = false;
  return { event: { notification: { data, close: () => void (closed = true) }, action }, closed: () => closed };
};

describe('when a push arrives', () => {
  it('shows it, with the picture, the buttons and what is needed to follow a tap', async () => {
    const { sw } = await setup();
    await sw.fire('push', pushEvent({ title: 'Order shipped', body: 'Tap to track', image: 'https://cdn.x.test/a.jpg', tag: 'order-1', data: { orderId: 'o1' }, actions: [{ action: 'track', title: 'Track' }], zapiack: block }));

    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe('Order shipped');
    expect(sw.shown[0]?.options).toMatchObject({ body: 'Tap to track', image: 'https://cdn.x.test/a.jpg', tag: 'order-1', actions: [{ action: 'track', title: 'Track' }] });
    expect(sw.shown[0]?.options['data']).toEqual({ orderId: 'o1', zapiack: block });
  });

  it('reports that it arrived, once shown, so the dashboard can say how many were received', async () => {
    const { sw, api } = await setup();
    await sw.fire('push', pushEvent({ title: 'T', body: 'B', zapiack: block }));
    const [call] = api.of('events');
    expect(call?.headers['x-zapiack-app-key']).toBe(KEY);
    expect(call?.body.events).toHaveLength(1);
    expect(call?.body.events[0]).toMatchObject({ type: 'received', deliveryId: 'dlv_1' });
  });

  it('shows it even when it cannot report: showing is what the visitor sees, reporting is for us', async () => {
    const { sw } = await setup({ configured: false });
    await sw.fire('push', pushEvent({ title: 'T', body: 'B', zapiack: block }));
    expect(sw.shown).toHaveLength(1);
  });

  it('shows it, and holds the report for later, when the network is down', async () => {
    const { sw, store } = await setup({ api: fakeApi({ events: () => new Error('offline') }) });
    await sw.fire('push', pushEvent({ title: 'T', body: 'B', zapiack: block }));
    expect(sw.shown).toHaveLength(1);
    expect((await store.keys('queue:')).length).toBe(1);
  });

  it('leaves out what was not sent: no picture, no buttons, no tag', async () => {
    const { sw } = await setup();
    await sw.fire('push', pushEvent({ title: 'T', body: 'B' }));
    expect(Object.keys(sw.shown[0]?.options ?? {}).sort()).toEqual(['body', 'data']);
  });

  it('ignores a push it cannot read, or one with nothing to show, instead of showing an empty notification', async () => {
    const { sw, api } = await setup();
    await sw.fire('push', { data: { json: () => { throw new Error('not json'); } } });
    await sw.fire('push', pushEvent({ body: 'no title' }));
    await sw.fire('push', {});
    expect(sw.shown).toHaveLength(0);
    expect(api.calls).toHaveLength(0);
  });

  it('shows a push that carries no Zapiack block, and reports nothing for it', async () => {
    const { sw, api } = await setup();
    await sw.fire('push', pushEvent({ title: 'T', body: 'B' }));
    expect(sw.shown).toHaveLength(1);
    expect(api.calls).toHaveLength(0);
  });
});

describe('when a notification is tapped', () => {
  it('closes it, reports the tap with a session of its own, and opens the link', async () => {
    const { sw, api } = await setup();
    const { event, closed } = tap({ zapiack: block });
    await sw.fire('notificationclick', event);

    expect(closed()).toBe(true);
    expect(sw.opened).toEqual(['https://myshop.com/orders/1']);
    const [reported] = api.of('events')[0]?.body.events ?? [];
    expect(reported).toMatchObject({ type: 'clicked', deliveryId: 'dlv_1', name: 'order_opened' });
    expect(reported.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(reported).not.toHaveProperty('actionId');
  });

  it('leaves a note for the page: the session to follow and what was tapped', async () => {
    const { sw, store } = await setup();
    await sw.fire('notificationclick', tap({ zapiack: { ...block, t: { w: 60, s: true } } }).event);

    const session = (await store.get<ActiveSession>('session'))!;
    expect(session).toMatchObject({ deliveryId: 'dlv_1', messageId: 'msg_1', startedAt: NOW, windowMinutes: 60, screens: true });
    const click = (await store.get<ClickInfo>('pendingClick'))!;
    expect(click).toMatchObject({ messageId: 'msg_1', deliveryId: 'dlv_1', sessionId: session.sessionId, event: 'order_opened', link: 'https://myshop.com/orders/1', at: NOW });
  });

  it('follows for thirty minutes and no screens unless the push asked for more', async () => {
    const { sw, store } = await setup();
    await sw.fire('notificationclick', tap({ zapiack: block }).event);
    expect(await store.get('session')).toMatchObject({ windowMinutes: 30, screens: false });
  });

  it('reports a button with its own id, event and link', async () => {
    const { sw, api } = await setup();
    await sw.fire('notificationclick', tap({ zapiack: block }, 'track').event);

    expect(sw.opened).toEqual(['https://myshop.com/orders/1/track']);
    expect(api.of('events')[0]?.body.events[0]).toMatchObject({ type: 'action', actionId: 'track', name: 'track_clicked', deliveryId: 'dlv_1' });
  });

  it('uses the notification\'s link for a button that has none of its own', async () => {
    const { sw } = await setup();
    const noLink = { ...block, a: [{ id: 'rate', title: 'Rate', event: 'rate_clicked' }] };
    await sw.fire('notificationclick', tap({ zapiack: noLink }, 'rate').event);
    expect(sw.opened).toEqual(['https://myshop.com/orders/1']);
  });

  it('brings forward a tab that is already on the page, instead of opening another', async () => {
    const { sw } = await setup({ windows: [{ url: 'https://myshop.com/home' }, { url: 'https://myshop.com/orders/1' }] });
    await sw.fire('notificationclick', tap({ zapiack: block }).event);
    expect(sw.focused).toEqual(['https://myshop.com/orders/1']);
    expect(sw.opened).toEqual([]);
  });

  it('opens the link when no tab is on it, even if other tabs are open', async () => {
    const { sw } = await setup({ windows: [{ url: 'https://myshop.com/home' }] });
    await sw.fire('notificationclick', tap({ zapiack: block }).event);
    expect(sw.opened).toEqual(['https://myshop.com/orders/1']);
  });

  it('tells every open page what was tapped, so it can react', async () => {
    const { sw } = await setup({ windows: [{ url: 'https://myshop.com/home' }] });
    await sw.fire('notificationclick', tap({ zapiack: block }).event);
    expect(sw.messages.length).toBeGreaterThan(0);
    expect(sw.messages.every((m) => m.message.zapiack === 'click' && m.message.click.deliveryId === 'dlv_1')).toBe(true);
  });

  it('still tells the open pages, and still reports the tap, when the browser refuses to open a window', async () => {
    const { sw, api } = await setup({ windows: [{ url: 'https://myshop.com/home' }] });
    sw.scope.clients.openWindow = async () => {
      throw new Error('Not allowed to open a window.');
    };
    await sw.fire('notificationclick', tap({ zapiack: block }).event);
    expect(sw.messages.some((m) => m.message.zapiack === 'click')).toBe(true);
    expect(JSON.stringify(api.calls)).toContain('clicked');
  });

  it('brings forward an open tab when there is no link at all', async () => {
    const { sw } = await setup({ windows: [{ url: 'https://myshop.com/home' }] });
    await sw.fire('notificationclick', tap({ zapiack: { m: 'msg_1', d: 'dlv_1' } }).event);
    expect(sw.focused).toEqual(['https://myshop.com/home']);
    expect(sw.opened).toEqual([]);
  });

  it('opens the site when there is no link and nothing is open', async () => {
    const { sw } = await setup();
    await sw.fire('notificationclick', tap({ zapiack: { m: 'msg_1', d: 'dlv_1' } }).event);
    expect(sw.opened).toEqual(['/']);
  });

  it('will not open anything that is not a web page, whatever the push says', async () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'intent://x#Intent;end']) {
      const { sw } = await setup();
      await sw.fire('notificationclick', tap({ zapiack: { m: 'msg_1', d: 'dlv_1', l: link } }).event);
      expect(sw.opened).toEqual(['/']);
    }
  });

  it('opens a link on the site given by a path', async () => {
    const { sw } = await setup();
    await sw.fire('notificationclick', tap({ zapiack: { m: 'msg_1', d: 'dlv_1', l: '/orders/9' } }).event);
    expect(sw.opened).toEqual(['https://myshop.com/orders/9']);
  });

  it('still opens the link when it cannot report: the visitor tapped to go somewhere', async () => {
    const { sw } = await setup({ configured: false });
    await sw.fire('notificationclick', tap({ zapiack: block }).event);
    expect(sw.opened).toEqual(['https://myshop.com/orders/1']);
  });

  it('closes a notification that carries nothing of Zapiack\'s, and opens the site', async () => {
    const { sw } = await setup();
    const { event, closed } = tap(undefined);
    await sw.fire('notificationclick', event);
    expect(closed()).toBe(true);
    expect(sw.opened).toEqual(['/']);
  });
});

describe('when the browser replaces the push subscription', () => {
  it('subscribes again with the app\'s key and tells Zapiack, so pushes keep arriving', async () => {
    const { sw, api, store } = await setup();
    await store.set('installationId', 'install-12345678');
    await sw.fire('pushsubscriptionchange');

    expect(sw.subscribed).toHaveLength(1);
    expect(sw.subscribed[0]?.userVisibleOnly).toBe(true);
    expect(sw.subscribed[0]?.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect(api.of('devices')[0]?.body).toMatchObject({ installationId: 'install-12345678', platform: 'web', permission: 'granted', token: { endpoint: 'https://fcm.googleapis.com/fcm/send/new' } });
  });

  it('does nothing when it was never set up, rather than throwing', async () => {
    const { sw, api } = await setup({ configured: false });
    await expect(sw.fire('pushsubscriptionchange')).resolves.toBeUndefined();
    expect(api.calls).toHaveLength(0);
  });
});

describe('the push key', () => {
  it('is turned from the URL-safe text Zapiack gives into the bytes a browser needs', () => {
    const bytes = base64UrlToBytes('BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM');
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(0x04);
  });
});
