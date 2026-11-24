import { ZapiackPushClient } from './client';

/** The push client. `await ZapiackPush.init({ appKey: 'pk_...' })` once, on every page. */
export const ZapiackPush = new ZapiackPushClient();

export { ZapiackPushClient, ZapiackPushError, browserEnv } from './client';
export type { BrowserEnv, ClickHandler, InitOptions } from './client';
export { EventQueue } from './queue';
export { SessionTracker } from './session';
export { IdbStore, MemoryStore } from './storage';
export type { KeyValueStore } from './storage';
export { registerHandlers } from './sw-handlers';
export type { SwScope } from './sw-handlers';
export type { ActiveSession, ClickInfo, Permission, PushBlock, SdkEvent, Tags } from './types';

/**
 * Live messages over one WebSocket. `new ZapiackRealtime({ getToken })` where `getToken` asks your server for a token minted with your API key.
 * It is separate from push: use either, or both.
 */
export { ZapiackRealtime, ZapiackRealtimeError, browserRealtimeEnv, DEFAULT_REALTIME_URL } from './realtime';
export type { PresenceMember, PublishOptions, PublishResult, RealtimeEnv, RealtimeMessage, RealtimeOptions, RealtimeState, SocketLike } from './realtime';
