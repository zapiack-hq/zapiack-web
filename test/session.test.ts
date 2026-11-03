import { describe, expect, it } from 'vitest';
import { SdkApi } from '../src/api';
import { EventQueue } from '../src/queue';
import { SessionTracker } from '../src/session';
import { MemoryStore } from '../src/storage';
import { ActiveSession } from '../src/types';
import { BASE, fakeApi, fakeBrowser, KEY } from './helpers';

const session = (over: Partial<ActiveSession> = {}, now = 1_800_000_000_000): ActiveSession => ({ sessionId: 'ses-1', deliveryId: 'dlv_1', messageId: 'msg_1', startedAt: now, windowMinutes: 30, screens: false, ...over });

async function setup(s?: Partial<ActiveSession> | null) {
  const b = fakeBrowser();
  const api = fakeApi();
  const queue = new EventQueue(b.store, () => new SdkApi(BASE, KEY, api.fn));
  const tracker = new SessionTracker(b.store, queue, b.env.tracker);
  if (s !== null) await b.store.set('session', session(s));
  return { b, api, queue, tracker };
}
const queued = async (b: ReturnType<typeof fakeBrowser>) =>
  Promise.all((await b.store.keys('queue:')).map((k) => b.store.get<{ type: string; name?: string; previousScreen?: string; sessionId?: string; deliveryId: string }>(k))) as Promise<Array<{ type: string; name?: string; previousScreen?: string; sessionId?: string; deliveryId: string }>>;
const settle = () => new Promise<void>((r) => setTimeout(r, 5));

describe('the window a tap opens', () => {
  it('is open from the tap until the push\'s window has passed', async () => {
    const { b, tracker } = await setup({ windowMinutes: 10 });
    expect((await tracker.current())?.sessionId).toBe('ses-1');
    b.advance(9 * 60_000);
    expect(await tracker.current()).toBeDefined();
    b.advance(2 * 60_000);
    expect(await tracker.current()).toBeUndefined();
  });

  it('is not there when the visitor did not arrive from a push', async () => {
    const { tracker } = await setup(null);
    expect(await tracker.current()).toBeUndefined();
    expect(await tracker.resume()).toBeUndefined();
  });
});

describe('reporting what the app does', () => {
  it('credits an event to the push that was tapped, while the window is open', async () => {
    const { b, tracker } = await setup();
    expect(await tracker.track('contact_rider', { orderId: 'o1' })).toBe(true);
    const [event] = await queued(b);
    expect(event).toMatchObject({ type: 'custom', name: 'contact_rider', sessionId: 'ses-1', deliveryId: 'dlv_1', properties: { orderId: 'o1' } });
  });

  it('does nothing, and says so, when there is no open window to credit', async () => {
    const none = await setup(null);
    expect(await none.tracker.track('x')).toBe(false);
    expect(await queued(none.b)).toEqual([]);

    const late = await setup({ windowMinutes: 1 });
    late.b.advance(2 * 60_000);
    expect(await late.tracker.track('x')).toBe(false);
    expect(await queued(late.b)).toEqual([]);
  });
});

describe('following the screens after a tap', () => {
  it('reports the screen the visitor landed on, and each one they go to after, with the one before it', async () => {
    const { b, tracker } = await setup({ screens: true });
    b.state.path = '/orders/1/track';
    await tracker.resume();
    await settle();
    b.navigate('/orders/1/rider');
    await settle();
    b.navigate('/home');
    await settle();

    const screens = (await queued(b)).filter((e) => e.type === 'screen');
    expect(screens.map((s) => s.name)).toEqual(['/orders/1/track', '/orders/1/rider', '/home']);
    expect(screens.map((s) => s.previousScreen)).toEqual([undefined, '/orders/1/track', '/orders/1/rider']);
    expect(screens.every((s) => s.sessionId === 'ses-1' && s.deliveryId === 'dlv_1')).toBe(true);
  });

  it('notices navigation however the app does it: pushState, replaceState, back and the hash', async () => {
    const { b, tracker } = await setup({ screens: true });
    await tracker.resume();
    await settle();
    b.history.pushState(null, '', '/a');
    await settle();
    b.history.replaceState(null, '', '/b');
    await settle();
    b.state.path = '/c';
    b.fire('popstate');
    await settle();
    b.state.path = '/d';
    b.fire('hashchange');
    await settle();
    expect((await queued(b)).filter((e) => e.type === 'screen').map((s) => s.name)).toEqual(['/', '/a', '/b', '/c', '/d']);
  });

  it('does not report the same screen twice in a row', async () => {
    const { b, tracker } = await setup({ screens: true });
    await tracker.resume();
    await settle();
    b.navigate('/');
    b.navigate('/');
    await settle();
    expect((await queued(b)).filter((e) => e.type === 'screen')).toHaveLength(1);
  });

  it('follows nothing unless the push asked for screens', async () => {
    const { b, tracker } = await setup({ screens: false });
    await tracker.resume();
    b.navigate('/a');
    await settle();
    expect((await queued(b)).filter((e) => e.type === 'screen')).toEqual([]);
  });

  it('stops when the window ends, without waiting for another navigation, and gives the browser its own history functions back', async () => {
    const { b, tracker } = await setup({ screens: true, windowMinutes: 5 });
    const originalPush = b.history.pushState;
    await tracker.resume();
    await settle();
    expect(b.history.pushState).not.toBe(originalPush);

    b.advance(6 * 60_000);
    expect(b.history.pushState).toBe(originalPush);
    b.navigate('/after');
    await settle();
    expect((await queued(b)).filter((e) => e.type === 'screen').map((s) => s.name)).toEqual(['/']);
  });

  it('stops following a tap once a newer tap has replaced it', async () => {
    const { b, tracker } = await setup({ screens: true });
    await tracker.resume();
    await settle();
    await b.store.set('session', session({ sessionId: 'ses-2', deliveryId: 'dlv_2', screens: true }, b.state.now));
    b.navigate('/after-new-tap');
    await settle();
    expect((await queued(b)).filter((e) => e.sessionId === 'ses-1' && e.name === '/after-new-tap')).toEqual([]);
  });

  it('can be stopped, and picks up again from a new tap, without stacking up watchers', async () => {
    const { b, tracker } = await setup({ screens: true });
    const originalPush = b.history.pushState;
    await tracker.resume();
    await tracker.resume();
    await tracker.resume();
    tracker.stop();
    expect(b.history.pushState).toBe(originalPush);
  });
});
