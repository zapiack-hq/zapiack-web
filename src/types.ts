/** What every push carries so a tap can be reported and followed. */
export interface PushBlock {
  /** Message id. */
  m: string;
  /** Delivery id. */
  d: string;
  /** The link to open. */
  l?: string;
  /** A picture. */
  i?: string;
  /** The event recorded when the notification itself is tapped. */
  e?: string;
  /** How to follow a tap: minutes to follow for, and whether to follow screens. */
  t?: { w?: number; s?: boolean };
  a?: Array<{ id: string; title: string; event?: string; link?: string }>;
}

export type EventType = 'clicked' | 'action' | 'screen' | 'custom' | 'received';

export interface SdkEvent {
  clientEventId: string;
  type: EventType;
  deliveryId: string;
  sessionId?: string;
  name?: string;
  actionId?: string;
  properties?: Record<string, unknown>;
  previousScreen?: string;
  at: string;
}

/** The window after a tap in which screens and events are credited to the push. */
export interface ActiveSession {
  sessionId: string;
  deliveryId: string;
  messageId: string;
  startedAt: number;
  windowMinutes: number;
  screens: boolean;
}

export interface ClickInfo {
  messageId: string;
  deliveryId: string;
  sessionId: string;
  /** The button that was tapped, when it was a button. */
  actionId?: string;
  /** The event name set on the notification or the button. */
  event?: string;
  link?: string;
  at: number;
}

export interface StoredConfig {
  appKey: string;
  baseUrl: string;
  vapidPublicKey?: string | null;
}

export type Tags = Record<string, string | number | boolean>;
export type Permission = 'granted' | 'denied' | 'default';

export const DEFAULT_BASE_URL = 'https://api.zapiack.com/v1';
export const DEFAULT_WINDOW_MINUTES = 30;
export const SESSION_KEY = 'session';
export const CONFIG_KEY = 'config';
export const INSTALLATION_KEY = 'installationId';
export const USER_KEY = 'user';
export const TAGS_KEY = 'tags';
export const PENDING_CLICK_KEY = 'pendingClick';
