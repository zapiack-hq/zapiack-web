import { EventQueue } from './queue';
import { KeyValueStore } from './storage';
import { ActiveSession, SESSION_KEY } from './types';

export interface TrackerEnv {
  now: () => number;
  pathname: () => string;
  history?: { pushState: (...args: any[]) => void; replaceState: (...args: any[]) => void };
  listen: (type: 'popstate' | 'hashchange', listener: () => void) => () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

/**
 * Follows what happens after a tap: the screens visited and the events the app reports, for as long as the push asked, and only
 * while the tap that opened the window is still the latest one.
 */
export class SessionTracker {
  private session?: ActiveSession;
  private lastScreen?: string;
  private stopListening: Array<() => void> = [];
  private timer?: unknown;

  constructor(
    private readonly store: KeyValueStore,
    private readonly queue: EventQueue,
    private readonly env: TrackerEnv,
  ) {}

  private expired(session: ActiveSession): boolean {
    return this.env.now() > session.startedAt + session.windowMinutes * 60_000;
  }

  /** The session a tap opened, if its window is still open. */
  async current(): Promise<ActiveSession | undefined> {
    const session = await this.store.get<ActiveSession>(SESSION_KEY);
    if (!session || this.expired(session)) return undefined;
    return session;
  }

  /** Picks up the session the service worker left behind. Starts following screens if the push asked for that. */
  async resume(): Promise<ActiveSession | undefined> {
    const session = await this.current();
    this.stop();
    this.session = session;
    if (session?.screens) this.followScreens(session);
    return session;
  }

  /** Reports an event of the app's own, credited to the push that was tapped. False when there is no open window to credit. */
  async track(name: string, properties?: Record<string, unknown>): Promise<boolean> {
    const session = await this.current();
    if (!session) return false;
    await this.queue.add({ type: 'custom', deliveryId: session.deliveryId, sessionId: session.sessionId, name, ...(properties ? { properties } : {}), at: this.env.now() });
    return true;
  }

  private followScreens(session: ActiveSession): void {
    const report = async () => {
      const live = await this.current();
      if (!live || live.sessionId !== session.sessionId) return this.stop();
      const screen = this.env.pathname();
      if (screen === this.lastScreen) return;
      const previous = this.lastScreen;
      this.lastScreen = screen;
      await this.queue.add({ type: 'screen', deliveryId: session.deliveryId, sessionId: session.sessionId, name: screen, ...(previous ? { previousScreen: previous } : {}), at: this.env.now() });
    };

    void report();

    const history = this.env.history;
    if (history) {
      const { pushState, replaceState } = history;
      history.pushState = (...args: unknown[]) => {
        pushState.apply(history, args);
        void report();
      };
      history.replaceState = (...args: unknown[]) => {
        replaceState.apply(history, args);
        void report();
      };
      this.stopListening.push(() => {
        history.pushState = pushState;
        history.replaceState = replaceState;
      });
    }
    this.stopListening.push(this.env.listen('popstate', () => void report()), this.env.listen('hashchange', () => void report()));

    // Following ends when the window does, without waiting for another navigation to find out.
    const remaining = session.startedAt + session.windowMinutes * 60_000 - this.env.now();
    this.timer = this.env.setTimeout(() => this.stop(), Math.max(0, remaining));
  }

  stop(): void {
    for (const stop of this.stopListening) stop();
    this.stopListening = [];
    if (this.timer !== undefined) this.env.clearTimeout(this.timer);
    this.timer = undefined;
    this.lastScreen = undefined;
  }
}
