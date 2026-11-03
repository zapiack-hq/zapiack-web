import { SdkApi } from './api';
import { uuid } from './ids';
import { KeyValueStore } from './storage';
import { SdkEvent } from './types';

/** The most events kept while the network is away. The oldest are dropped first. */
const MAX_QUEUED = 500;
const BATCH = 100;
const PREFIX = 'queue:';

/** Breaks ties between events made in the same millisecond, so they keep the order they were made in. */
let sequence = 0;

export type NewEvent = Omit<SdkEvent, 'clientEventId' | 'at'> & { at?: number };

/**
 * Events waiting to be reported, kept on disk so a closed tab or a stopped service worker loses nothing.
 *
 * Each event is stored under a key of its own, so adding one never reads or rewrites the others: the page and the service worker
 * can both add events at the same moment and none is lost. An event is removed once Zapiack has answered about it, whether it was
 * accepted, repeated or refused. Only one the network failed to carry is kept, and it is safe to send twice because each
 * carries its own id.
 */
export class EventQueue {
  private flushing?: Promise<number>;

  constructor(
    private readonly store: KeyValueStore,
    private readonly api: () => SdkApi | undefined,
  ) {}

  async size(): Promise<number> {
    return (await this.store.keys(PREFIX)).length;
  }

  async add(event: NewEvent): Promise<SdkEvent> {
    const at = event.at ?? Date.now();
    const full: SdkEvent = { ...event, clientEventId: uuid(), at: new Date(at).toISOString() };
    // Ordered by when it happened, then by the order it was made in, so that is the order events are sent in.
    sequence = (sequence + 1) % 1_000_000;
    await this.store.set(`${PREFIX}${String(at).padStart(15, '0')}:${String(sequence).padStart(6, '0')}:${full.clientEventId}`, full);

    const keys = await this.store.keys(PREFIX);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_QUEUED))) await this.store.delete(key);
    return full;
  }

  /** Sends what is waiting. Resolves to how many events Zapiack answered about; stops at the first failure to reach it. */
  flush(): Promise<number> {
    this.flushing ??= this.run().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async run(): Promise<number> {
    const api = this.api();
    if (!api) return 0;
    let answered = 0;

    for (;;) {
      const keys = (await this.store.keys(PREFIX)).slice(0, BATCH);
      if (keys.length === 0) return answered;

      const loaded = await Promise.all(keys.map(async (key) => ({ key, event: await this.store.get<SdkEvent>(key) })));
      const pending = loaded.filter((l): l is { key: string; event: SdkEvent } => l.event !== undefined);
      // Another flush (the page's or the service worker's) already sent and removed these.
      if (pending.length === 0) {
        for (const { key } of loaded) await this.store.delete(key);
        continue;
      }

      const outcome = await api.sendEvents(pending.map((p) => p.event));
      if (!outcome.ok && outcome.retry) return answered;

      // Answered, one way or the other (even refused for good): these events are done with.
      for (const { key } of loaded) await this.store.delete(key);
      answered += pending.length;
    }
  }
}
