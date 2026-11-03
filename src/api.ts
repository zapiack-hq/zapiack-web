import { SdkEvent, Tags } from './types';

export interface RegisterBody {
  installationId: string;
  platform: 'web';
  token: unknown;
  externalUserId?: string | null;
  tags?: Tags;
  permission?: 'granted' | 'denied' | 'provisional';
  appVersion?: string;
}

export interface EventsResult {
  accepted: number;
  ignored: number;
  rejected: Array<{ index: number; reason: string }>;
}

export type SendOutcome =
  | { ok: true; result: EventsResult }
  /** The request did not get through, or the service was busy: keep the events and try again. */
  | { ok: false; retry: true }
  /** The request was refused for good: keep trying and it will be refused again. */
  | { ok: false; retry: false; status: number };

type FetchLike = typeof fetch;

export class SdkApi {
  constructor(
    private readonly baseUrl: string,
    private readonly appKey: string,
    private readonly fetchImpl: FetchLike = (...args) => globalThis.fetch(...args),
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/push/sdk/${path}`;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-zapiack-app-key': this.appKey };
  }

  /** The app's id and the public key this browser subscribes with. */
  async config(): Promise<{ appId: string; vapidPublicKey: string | null }> {
    const response = await this.fetchImpl(this.url('config'), { headers: this.headers() });
    if (!response.ok) throw new Error(`Zapiack could not be reached to set up push (${response.status})`);
    return (await response.json()) as { appId: string; vapidPublicKey: string | null };
  }

  async register(body: RegisterBody): Promise<{ deviceId: string; installationId: string }> {
    const response = await this.fetchImpl(this.url('devices'), { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`The device could not be registered (${response.status})`);
    return (await response.json()) as { deviceId: string; installationId: string };
  }

  /** Reports events. `keepalive` lets the request finish even while the page is closing or the service worker is stopping. */
  async sendEvents(events: SdkEvent[]): Promise<SendOutcome> {
    try {
      const response = await this.fetchImpl(this.url('events'), { method: 'POST', headers: this.headers(), body: JSON.stringify({ events }), keepalive: true });
      if (response.ok) return { ok: true, result: (await response.json()) as EventsResult };
      // Busy or down: try again. Anything else (a wrong key, a bad request) will not improve by repeating it.
      if (response.status === 429 || response.status >= 500 || response.status === 408) return { ok: false, retry: true };
      return { ok: false, retry: false, status: response.status };
    } catch {
      return { ok: false, retry: true };
    }
  }
}
