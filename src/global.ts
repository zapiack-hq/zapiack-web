import { ZapiackPush, ZapiackPushClient, ZapiackPushError } from './index';

/** For a plain `<script>` tag: `Zapiack.Push.init({ appKey: 'pk_...' })`. */
const root = globalThis as unknown as { Zapiack?: Record<string, unknown> };
root.Zapiack = { ...(root.Zapiack ?? {}), Push: ZapiackPush, PushClient: ZapiackPushClient, PushError: ZapiackPushError };
