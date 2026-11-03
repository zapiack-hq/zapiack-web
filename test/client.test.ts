import { describe, expect, it } from 'vitest';
import { ZapiackPushClient, ZapiackPushError } from '../src/client';
import { ActiveSession, ClickInfo } from '../src/types';
import { BASE, fakeBrowser, flushPromises, KEY } from './helpers';

async function ready(opts: Parameters<typeof fakeBrowser>[0] = {}, init: Partial<Parameters<ZapiackPushClient['init']>[0]> = {}) {
  const b = fakeBrowser(opts);
  const client = new ZapiackPushClient(() => b.env);
  await client.init({ appKey: KEY, baseUrl: BASE, ...init });
  return { b, client };
}

const click = (over: Partial<ClickInfo> = {}, now = 1_800_000_000_000): ClickInfo => ({ messageId: 'msg_1', deliveryId: 'dlv_1', sessionId: 'ses-1', event: 'opened', link: 'https://myshop.com/x', at: now, ...over });

describe('setting up', () => {
  it('registers the service worker where it was told it lives, and keeps the key for the worker to use', async () => {
    const { b } = await ready({}, { serviceWorkerPath: '/assets/zapiack-sw.js', serviceWorkerScope: '/' });
    expect(b.state.registered).toEqual([{ url: '/assets/zapiack-sw.js', scope: '/' }]);
    expect(await b.store.get('config')).toMatchObject({ appKey: KEY, baseUrl: BASE });
  });

  it('looks for the service worker at /zapiack-sw.js unless told otherwise', async () => {
    const { b } = await ready();
    expect(b.state.registered[0]?.url).toBe('/zapiack-sw.js');
  });

  it('refuses anything that is not a public app key, including a secret API key', async () => {
    const b = fakeBrowser();
    for (const key of ['zpk_abc12345_secretsecret', 'sk_live_abcdefghij', '', 'pk_short', undefined]) {
      await expect(new ZapiackPushClient(() => b.env).init({ appKey: key as string })).rejects.toThrow(ZapiackPushError);
    }
    await expect(new ZapiackPushClient(() => b.env).init({ appKey: 'zpk_abc12345_secretsecret' })).rejects.toThrow('public app key');
  });

  it('asks for nothing, and registers nothing, until the visitor has agreed to notifications', async () => {
    const { b } = await ready({ permission: 'default' });
    expect(b.api.of('devices')).toHaveLength(0);
    expect(b.api.of('config')).toHaveLength(0);
    expect(b.push.subscribes()).toBe(0);
  });

  it('registers on its own at every page load once permission is granted', async () => {
    const { b } = await ready({ permission: 'granted' });
    expect(b.api.of('devices')).toHaveLength(1);
    expect(b.push.has()).toBe(true);
    expect(b.api.of('devices')[0]?.body).toMatchObject({ platform: 'web', permission: 'granted', token: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p256dh-key', auth: 'auth-secret' } } });
  });

  it('can be told not to register on its own', async () => {
    const { b } = await ready({ permission: 'granted' }, { autoRegister: false });
    expect(b.api.of('devices')).toHaveLength(0);
  });

  it('is safe to call again on the next page: it subscribes only once, and asks for the key only once', async () => {
    const b = fakeBrowser({ permission: 'granted' });
    await new ZapiackPushClient(() => b.env).init({ appKey: KEY, baseUrl: BASE });
    await new ZapiackPushClient(() => b.env).init({ appKey: KEY, baseUrl: BASE });
    expect(b.push.subscribes()).toBe(1);
    expect(b.api.of('config')).toHaveLength(1);
    expect(b.api.of('devices')).toHaveLength(2);
  });

  it('does not stop the page when registering fails: the visitor is on a page, not in a push flow', async () => {
    const { client } = await ready({ permission: 'granted', fetch: (async () => { throw new Error('offline'); }) as never });
    expect(client.permission()).toBe('granted');
  });

  it('works in a browser that cannot do push, doing nothing and saying so', async () => {
    const { b, client } = await ready({ supported: false });
    expect(client.isSupported()).toBe(false);
    expect(b.state.registered).toEqual([]);
    expect(await client.requestPermission()).toBe('denied');
  });

  it('has to be set up before it is used', async () => {
    const b = fakeBrowser();
    const client = new ZapiackPushClient(() => b.env);
    await expect(client.register()).rejects.toThrow('Call init first');
    await expect(client.login('u1')).rejects.toThrow('Call init first');
    await expect(client.track('x')).rejects.toThrow('Call init first');
  });
});

describe('asking for permission', () => {
  it('subscribes this browser with the app\'s public key and registers it when the visitor says yes', async () => {
    const { b, client } = await ready({ permission: 'default', prompt: 'granted' });
    expect(await client.requestPermission()).toBe('granted');

    expect(b.api.of('config')).toHaveLength(1);
    expect(b.push.keys[0]?.userVisibleOnly).toBe(true);
    expect(b.push.keys[0]?.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect(b.api.of('devices')).toHaveLength(1);
    expect(b.api.of('devices')[0]?.method).toBe('PUT');
    expect(b.api.of('devices')[0]?.headers['x-zapiack-app-key']).toBe(KEY);
  });

  it('registers nothing when the visitor says no, and answers honestly', async () => {
    const { b, client } = await ready({ permission: 'default', prompt: 'denied' });
    expect(await client.requestPermission()).toBe('denied');
    expect(b.api.of('devices')).toHaveLength(0);
    expect(client.permission()).toBe('denied');
  });

  it('treats closing the prompt as not yet, not as a no', async () => {
    const { b, client } = await ready({ permission: 'default', prompt: 'default' });
    expect(await client.requestPermission()).toBe('default');
    expect(b.api.of('devices')).toHaveLength(0);
  });

  it('tells Zapiack when a visitor who had agreed now says no, so pushes stop going to them', async () => {
    const { b, client } = await ready({ permission: 'granted' });
    b.setPermission('default');
    b.env.notification = { permission: 'default', requestPermission: async () => 'denied' };
    await client.requestPermission();
    const last = b.api.of('devices').at(-1);
    expect(last?.body).toMatchObject({ permission: 'denied' });
  });

  it('explains when the app has no web push set up, instead of failing quietly', async () => {
    const b = fakeBrowser({ permission: 'default', prompt: 'granted' });
    b.env.fetch = (async (url: string) => ({ ok: true, status: 200, json: async () => ({ appId: 'a', vapidPublicKey: null }), text: async () => '' })) as never;
    const client = new ZapiackPushClient(() => b.env);
    await client.init({ appKey: KEY, baseUrl: BASE });
    await expect(client.requestPermission()).rejects.toThrow('Web push is not turned on');
  });

  it('will not register without permission', async () => {
    const { client } = await ready({ permission: 'default' });
    await expect(client.register()).rejects.toThrow('Permission has not been granted');
  });
});

describe('who this browser is', () => {
  it('has an installation id that is made once and kept', async () => {
    const { client, b } = await ready();
    const first = await client.installationId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await client.installationId()).toBe(first);
    expect(await b.store.get('installationId')).toBe(first);
  });

  it('sends the same installation id on every registration, so Zapiack knows it is the same browser', async () => {
    const { b } = await ready({ permission: 'granted' });
    const { client } = await ready({ permission: 'granted', store: b.store });
    await client.register();
    const ids = new Set(b.api.of('devices').map((c) => c.body.installationId));
    expect(ids.size).toBe(1);
  });

  it('says nothing about the user on an ordinary page load, so it never overwrites what the server knows', async () => {
    const { b } = await ready({ permission: 'granted' });
    expect(b.api.of('devices')[0]?.body).not.toHaveProperty('externalUserId');
    expect(b.api.of('devices')[0]?.body).not.toHaveProperty('tags');
  });

  it('links to the user on sign-in, once, and not again on the next page load', async () => {
    const { b, client } = await ready({ permission: 'granted' });
    await client.login('user_123');
    expect(b.api.of('devices').at(-1)?.body.externalUserId).toBe('user_123');
    await client.register();
    expect(b.api.of('devices').at(-1)?.body).not.toHaveProperty('externalUserId');
  });

  it('unlinks on sign-out, with null, which is how Zapiack tells sign-out from silence', async () => {
    const { b, client } = await ready({ permission: 'granted' });
    await client.login('user_123');
    await client.logout();
    expect(b.api.of('devices').at(-1)?.body.externalUserId).toBeNull();
    expect(b.api.of('devices').at(-1)?.body).toHaveProperty('externalUserId');
  });

  it('remembers a sign-in made before permission was given, and sends it with the first registration', async () => {
    const { b, client } = await ready({ permission: 'default', prompt: 'granted' });
    await client.login('user_9');
    expect(b.api.of('devices')).toHaveLength(0);
    await client.requestPermission();
    expect(b.api.of('devices')[0]?.body.externalUserId).toBe('user_9');
  });

  it('sends tags once the app has set some, all of them every time, and drops the ones it removes', async () => {
    const { b, client } = await ready({ permission: 'granted' });
    await client.addTags({ plan: 'pro' });
    await client.addTags({ region: 'ng' });
    expect(b.api.of('devices').at(-1)?.body.tags).toEqual({ plan: 'pro', region: 'ng' });
    await client.removeTags(['plan']);
    expect(b.api.of('devices').at(-1)?.body.tags).toEqual({ region: 'ng' });
    await client.register();
    expect(b.api.of('devices').at(-1)?.body.tags).toEqual({ region: 'ng' });
  });

  it('sends the app\'s own version when it was given', async () => {
    const { b } = await ready({ permission: 'granted' }, { appVersion: '2.4.1' });
    expect(b.api.of('devices')[0]?.body.appVersion).toBe('2.4.1');
  });
});

describe('reporting what happens after a tap', () => {
  const tapped = (now: number, over: Partial<ActiveSession> = {}): ActiveSession => ({ sessionId: 'ses-1', deliveryId: 'dlv_1', messageId: 'msg_1', startedAt: now, windowMinutes: 30, screens: false, ...over });

  it('credits an event to the push the visitor arrived from, and sends it', async () => {
    const b = fakeBrowser();
    await b.store.set('session', tapped(b.state.now));
    const client = new ZapiackPushClient(() => b.env);
    await client.init({ appKey: KEY, baseUrl: BASE });

    expect(await client.track('purchase_completed', { orderId: 'o1' })).toBe(true);
    await flushPromises();
    const sent = b.api.of('events').flatMap((c) => c.body.events);
    expect(sent.find((e: { type: string }) => e.type === 'custom')).toMatchObject({ name: 'purchase_completed', sessionId: 'ses-1', deliveryId: 'dlv_1', properties: { orderId: 'o1' } });
  });

  it('does nothing, and says so, for a visitor who did not arrive from a push', async () => {
    const { b, client } = await ready();
    expect(await client.track('purchase_completed')).toBe(false);
    expect(b.api.of('events')).toHaveLength(0);
  });

  it('does nothing once the window the push allowed has passed', async () => {
    const b = fakeBrowser();
    await b.store.set('session', tapped(b.state.now, { windowMinutes: 5 }));
    const client = new ZapiackPushClient(() => b.env);
    await client.init({ appKey: KEY, baseUrl: BASE });
    b.advance(6 * 60_000);
    expect(await client.track('late')).toBe(false);
  });

  it('follows screens from the moment the page loads, when the push asked for it', async () => {
    const b = fakeBrowser();
    b.state.path = '/orders/1/track';
    await b.store.set('session', tapped(b.state.now, { screens: true }));
    const client = new ZapiackPushClient(() => b.env);
    await client.init({ appKey: KEY, baseUrl: BASE });
    b.navigate('/orders/1/rider');
    await flushPromises();
    await client.track('contact_rider');
    await flushPromises();
    const events = b.api.of('events').flatMap((c) => c.body.events) as Array<{ type: string; name: string }>;
    expect(events.filter((e) => e.type === 'screen').map((e) => e.name)).toEqual(['/orders/1/track', '/orders/1/rider']);
  });
});

describe('knowing when a notification was tapped', () => {
  it('runs the handler with what was tapped when the service worker says so', async () => {
    const { b, client } = await ready();
    const seen: ClickInfo[] = [];
    client.onClick((c) => seen.push(c));
    b.message({ zapiack: 'click', click: click({}, b.state.now) });
    await flushPromises();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ messageId: 'msg_1', event: 'opened', link: 'https://myshop.com/x' });
  });

  it('passes on which button was tapped', async () => {
    const { b, client } = await ready();
    const seen: ClickInfo[] = [];
    client.onClick((c) => seen.push(c));
    b.message({ zapiack: 'click', click: click({ actionId: 'track', event: 'track_clicked' }, b.state.now) });
    await flushPromises();
    expect(seen[0]).toMatchObject({ actionId: 'track', event: 'track_clicked' });
  });

  it('gives a tap that opened the page before there was a handler to the handler, once', async () => {
    const b = fakeBrowser();
    await b.store.set('pendingClick', click({}, b.state.now));
    const client = new ZapiackPushClient(() => b.env);
    await client.init({ appKey: KEY, baseUrl: BASE });

    const seen: ClickInfo[] = [];
    client.onClick((c) => seen.push(c));
    await flushPromises();
    client.onClick((c) => seen.push(c));
    await flushPromises();
    expect(seen).toHaveLength(1);
    expect(await b.store.get('pendingClick')).toBeUndefined();
  });

  it('does not hand over a tap from long ago, for example from an earlier visit', async () => {
    const b = fakeBrowser();
    await b.store.set('pendingClick', click({ at: b.state.now - 10 * 60_000 }, b.state.now));
    const client = new ZapiackPushClient(() => b.env);
    await client.init({ appKey: KEY, baseUrl: BASE });
    const seen: ClickInfo[] = [];
    client.onClick((c) => seen.push(c));
    await flushPromises();
    expect(seen).toEqual([]);
  });

  it('keeps going when one handler fails, and lets a handler be removed', async () => {
    const { b, client } = await ready();
    const seen: string[] = [];
    client.onClick(() => { throw new Error('mistake'); });
    const stop = client.onClick(() => seen.push('second'));
    b.message({ zapiack: 'click', click: click({}, b.state.now) });
    await flushPromises();
    expect(seen).toEqual(['second']);
    stop();
    b.message({ zapiack: 'click', click: click({ sessionId: 'ses-2' }, b.state.now) });
    await flushPromises();
    expect(seen).toEqual(['second']);
  });

  it('ignores messages from the worker that are not about a tap', async () => {
    const { b, client } = await ready();
    const seen: ClickInfo[] = [];
    client.onClick((c) => seen.push(c));
    b.message({ something: 'else' });
    b.message(undefined);
    b.message({ zapiack: 'click' });
    await flushPromises();
    expect(seen).toEqual([]);
  });
});

describe('stopping notifications', () => {
  it('unsubscribes this browser and tells Zapiack, so pushes stop going to it', async () => {
    const { b, client } = await ready({ permission: 'granted' });
    expect(b.push.has()).toBe(true);
    await client.unsubscribe();
    expect(b.push.has()).toBe(false);
    expect(b.api.of('devices').at(-1)?.body).toMatchObject({ permission: 'denied' });
  });

  it('does nothing when there was no subscription', async () => {
    const { b, client } = await ready({ permission: 'default' });
    await client.unsubscribe();
    expect(b.api.of('devices')).toHaveLength(0);
  });
});

describe('keeping the queue moving', () => {
  it('sends what is waiting when the page is hidden or comes back online, and on a timer', async () => {
    const { b, client } = await ready();
    await client.track('x');
    expect(b.lifecycle).toHaveLength(1);
    expect(b.intervals[0]?.ms).toBe(15_000);
  });
});
