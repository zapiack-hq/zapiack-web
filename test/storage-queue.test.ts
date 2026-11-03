import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { SdkApi } from '../src/api';
import { EventQueue } from '../src/queue';
import { IdbStore, MemoryStore } from '../src/storage';
import { BASE, fakeApi, KEY } from './helpers';

describe('the store both the page and the service worker use', () => {
  it('keeps what was put in it, and gives back a copy, not the original', async () => {
    const store = new MemoryStore();
    const original = { a: [1, 2] };
    await store.set('k', original);
    original.a.push(3);
    expect(await store.get('k')).toEqual({ a: [1, 2] });
    const read = (await store.get<{ a: number[] }>('k'))!;
    read.a.push(9);
    expect(await store.get('k')).toEqual({ a: [1, 2] });
    await store.delete('k');
    expect(await store.get('k')).toBeUndefined();
  });

  it('is shared by two users of the same IndexedDB, which is how a page and its service worker see the same thing', async () => {
    const factory = new IDBFactory();
    const page = new IdbStore(factory);
    const worker = new IdbStore(factory);
    await page.set('session', { sessionId: 's1' });
    expect(await worker.get('session')).toEqual({ sessionId: 's1' });
    await worker.set('queue', [{ id: 1 }]);
    expect(await page.get('queue')).toEqual([{ id: 1 }]);
    await page.delete('queue');
    expect(await worker.get('queue')).toBeUndefined();
  });

  it('overwrites a key, and keeps nothing for a key never set', async () => {
    const store = new IdbStore(new IDBFactory());
    expect(await store.get('nothing')).toBeUndefined();
    await store.set('k', 1);
    await store.set('k', 2);
    expect(await store.get('k')).toBe(2);
  });

  it('lists keys by prefix, in order, in both stores', async () => {
    for (const store of [new MemoryStore(), new IdbStore(new IDBFactory()), new IdbStore(undefined)]) {
      await store.set('queue:2', 'b');
      await store.set('queue:1', 'a');
      await store.set('other', 'x');
      expect(await store.keys('queue:')).toEqual(['queue:1', 'queue:2']);
      expect(await store.keys('none')).toEqual([]);
    }
  });

  it('carries on in memory when IndexedDB is not there, instead of failing the page', async () => {
    const store = new IdbStore(undefined);
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    await store.delete('k');
    expect(await store.get('k')).toBeUndefined();
  });

  it('carries on in memory when IndexedDB refuses to open', async () => {
    const broken = { open: () => { throw new Error('denied'); } } as unknown as IDBFactory;
    const store = new IdbStore(broken);
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
  });
});

describe('the queue of events waiting to be reported', () => {
  const setup = (api = fakeApi()) => {
    const store = new MemoryStore();
    const queue = new EventQueue(store, () => new SdkApi(BASE, KEY, api.fn));
    return { store, queue, api };
  };
  const add = (queue: EventQueue, n = 1) => Promise.all(Array.from({ length: n }, (_, i) => queue.add({ type: 'received', deliveryId: `d${i}` })));

  it('gives every event an id of its own and a time, and keeps it', async () => {
    const { queue } = setup();
    const [a, b] = await add(queue, 2);
    expect(a?.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a?.clientEventId).not.toBe(b?.clientEventId);
    expect(a?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await queue.size()).toBe(2);
  });

  it('sends what is waiting with the app key, once, and then holds nothing', async () => {
    const { queue, api } = setup();
    await add(queue, 3);
    expect(await queue.flush()).toBe(3);
    expect(await queue.size()).toBe(0);
    const [call] = api.of('events');
    expect(call?.method).toBe('POST');
    expect(call?.headers['x-zapiack-app-key']).toBe(KEY);
    expect(call?.body.events).toHaveLength(3);
  });

  it('keeps events the network could not carry, and sends them later', async () => {
    let down = true;
    const { queue, api } = setup(fakeApi({ events: (c) => (down ? new Error('offline') : { body: { accepted: c.body.events.length, ignored: 0, rejected: [] } }) }));
    await add(queue, 2);
    expect(await queue.flush()).toBe(0);
    expect(await queue.size()).toBe(2);
    down = false;
    expect(await queue.flush()).toBe(2);
    expect(await queue.size()).toBe(0);
    expect(api.of('events')).toHaveLength(2);
  });

  it('keeps events through a busy or failing service: 429, 500 and 503', async () => {
    for (const status of [429, 500, 503, 408]) {
      const { queue } = setup(fakeApi({ events: () => ({ status }) }));
      await add(queue, 1);
      expect(await queue.flush()).toBe(0);
      expect(await queue.size()).toBe(1);
    }
  });

  it('drops events that were refused for good, rather than sending them forever', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { queue } = setup(fakeApi({ events: () => ({ status }) }));
      await add(queue, 2);
      expect(await queue.flush()).toBe(2);
      expect(await queue.size()).toBe(0);
    }
  });

  it('is done with events the service named as rejected: they will never be accepted', async () => {
    const { queue } = setup(fakeApi({ events: () => ({ body: { accepted: 0, ignored: 0, rejected: [{ index: 0, reason: 'bad' }] } }) }));
    await add(queue, 1);
    await queue.flush();
    expect(await queue.size()).toBe(0);
  });

  it('sends a long queue in batches of 100, and stops at the first failure without losing the rest', async () => {
    let calls = 0;
    const { queue } = setup(fakeApi({ events: (c) => (++calls === 2 ? new Error('offline') : { body: { accepted: c.body.events.length, ignored: 0, rejected: [] } }) }));
    await add(queue, 250);
    expect(await queue.flush()).toBe(100);
    expect(await queue.size()).toBe(150);
    expect(await queue.flush()).toBe(150);
    expect(await queue.size()).toBe(0);
  });

  it('runs one flush at a time, so two triggers do not send the same events twice', async () => {
    const { queue, api } = setup();
    await add(queue, 2);
    const [a, b] = await Promise.all([queue.flush(), queue.flush()]);
    expect(a).toBe(b);
    expect(api.of('events')).toHaveLength(1);
  });

  it('never grows without limit: past 500 the oldest are dropped', async () => {
    const { queue, store } = setup();
    for (let i = 0; i < 520; i++) await queue.add({ type: 'received', deliveryId: `d${i}`, at: 1_800_000_000_000 + i });
    const keys = await store.keys('queue:');
    expect(keys).toHaveLength(500);
    expect((await store.get<{ deliveryId: string }>(keys[0]!))?.deliveryId).toBe('d20');
    expect((await store.get<{ deliveryId: string }>(keys[499]!))?.deliveryId).toBe('d519');
  });

  it('loses nothing when many events are added at the same moment, as the page and the service worker can', async () => {
    const { queue } = setup();
    await Promise.all(Array.from({ length: 50 }, (_, i) => queue.add({ type: 'screen', deliveryId: 'd1', sessionId: 's1', name: `/p${i}` })));
    expect(await queue.size()).toBe(50);
  });

  it('shares one queue between two users of the same storage, with nothing lost or sent twice', async () => {
    const factory = new IDBFactory();
    const api = fakeApi();
    const page = new EventQueue(new IdbStore(factory), () => new SdkApi(BASE, KEY, api.fn));
    const worker = new EventQueue(new IdbStore(factory), () => new SdkApi(BASE, KEY, api.fn));
    await Promise.all([page.add({ type: 'screen', deliveryId: 'd1', sessionId: 's1', name: '/a' }), worker.add({ type: 'received', deliveryId: 'd1' })]);
    expect(await page.size()).toBe(2);
    expect(await worker.size()).toBe(2);
    await page.flush();
    expect(await worker.size()).toBe(0);
  });

  it('sends events in the order they happened', async () => {
    const { queue, api } = setup();
    await queue.add({ type: 'screen', deliveryId: 'd1', sessionId: 's', name: '/second', at: 2_000 });
    await queue.add({ type: 'screen', deliveryId: 'd1', sessionId: 's', name: '/first', at: 1_000 });
    await queue.flush();
    expect(api.of('events')[0]?.body.events.map((e: { name: string }) => e.name)).toEqual(['/first', '/second']);
  });

  it('does nothing, and keeps everything, before the SDK has been set up', async () => {
    const store = new MemoryStore();
    const queue = new EventQueue(store, () => undefined);
    await queue.add({ type: 'received', deliveryId: 'd1' });
    expect(await queue.flush()).toBe(0);
    expect(await queue.size()).toBe(1);
  });
});
