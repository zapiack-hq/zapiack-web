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
