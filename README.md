# @zapiack/web

The one Zapiack package for websites. Push notifications are in it today, and new Zapiack products arrive in the same package.

## Push

Registers the browser, shows pushes, reports taps, and follows what the visitor does
next, so you can see which pushes bring people back and what they do when they arrive.

```bash
npm install @zapiack/web
```

Or with a script tag:

```html
<script src="https://cdn.jsdelivr.net/npm/@zapiack/web/dist/zapiack.global.js"></script>
<script>Zapiack.Push.init({ appKey: 'pk_...' });</script>
```

## Set up

**1. Host the service worker** at the root of your site, so it can control every page. Copy `node_modules/@zapiack/web/dist/zapiack-sw.js`
to `/zapiack-sw.js`, or serve it from there.

**2. Set up push for your project** in the dashboard (**Push**, then **Set up push**) with the web platform turned on, and enter your
site's address. You get a public key that starts with `pk_`. It is safe to put in your page.

**3. Start it on every page:**

```ts
import { ZapiackPush } from '@zapiack/web';

await ZapiackPush.init({ appKey: 'pk_...' });
```

**4. Ask for permission from a click**, not on page load:

```ts
button.addEventListener('click', async () => {
  const answer = await ZapiackPush.requestPermission(); // 'granted' | 'denied' | 'default'
});
```

When the visitor agrees, the browser is subscribed and registered. After that it registers itself again on every page load.

## Link a browser to your user

```ts
await ZapiackPush.login('user_123');   // the id your server uses for them
await ZapiackPush.logout();            // on sign-out

await ZapiackPush.addTags({ plan: 'pro' });
await ZapiackPush.removeTags(['plan']);
```

Then your server can send to `{ externalUserIds: ['user_123'] }` or `{ tags: { plan: 'pro' } }`.

## Know when a notification was tapped

```ts
ZapiackPush.onClick((click) => {
  // click.link, click.event, click.actionId (the button, if one was tapped)
});
```

The link opens by itself. This is for your own routing or for showing something in the page. If the tap opened a new page, the
handler still runs once the page has loaded.

## See what happens after a tap

A push can ask to follow the visitor for a while after they tap it. While that window is open:

```ts
await ZapiackPush.track('purchase_completed', { orderId: 'ord_789' });
```

reports the event, credited to the push, and when your server named it as the push's goal it counts as a conversion. If the push
asked for screens, page changes are reported too, with no code from you. `track` does nothing, and returns `false`, when the
visitor did not arrive from a push or the window has passed.

## Other

```ts
ZapiackPush.isSupported();      // false in browsers that cannot receive web push
ZapiackPush.permission();       // 'granted' | 'denied' | 'default'
await ZapiackPush.installationId();
await ZapiackPush.unsubscribe();
```

`init` options: `serviceWorkerPath` (default `/zapiack-sw.js`), `serviceWorkerScope`, `autoRegister` (default `true`), `appVersion`.

## Realtime

Live messages over one WebSocket: chat, live updates, presence, and signalling for calls. It is separate from push; use either or both.

Your app never holds an API key. Your **server** asks Zapiack for a short-lived token for the signed-in user (the key needs the **Realtime** scope, or no scope limits), and hands it to the app:

```bash
curl -X POST https://api.zapiack.com/v1/realtime/tokens \
  -H "Authorization: Bearer $ZAPIACK_API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"user_42","capabilities":{"chat:*":["subscribe","publish","presence"]}}'
# → { "token": "eyJ…", "expiresAt": "…", "url": "wss://rt.zapiack.com/?token=eyJ…" }
```

`capabilities` says what that user may do on which channels (`*` matches anything): `subscribe`, `publish`, `presence`, `history`, `signal`. Tokens last an hour unless you ask for less (`ttlSeconds`, at most a day).

In the page or app:

```ts
import { ZapiackRealtime } from '@zapiack/web';

const rt = new ZapiackRealtime({
  // Ask YOUR server for a token. Called on every connect, so an expired token is replaced.
  getToken: () => fetch('/api/realtime-token').then((r) => r.text()),
});
await rt.connect();

const stop = rt.subscribe('chat:room-1', (m) => console.log(m.from, m.data));
await rt.publish('chat:room-1', { text: 'hi' }, { persist: true }); // resolves when the server confirms

const here = rt.presence('chat:room-1');
here.enter({ name: 'Ann' });
here.onChange(({ action, member }) => console.log(action, member.user));
rt.signal('call-7', otherConnectionId, 'offer', { sdp }); // to one connection
rt.onError((e) => console.warn(e.code, e.message));
```

- **Reconnects by itself** with a growing, jittered pause, fetches a fresh token each time, re-joins every channel and replays what it missed since the last message it saw (publish with `persist` to make a message replayable). Messages already seen are not repeated.
- **Sends made while offline** wait (up to 100) and go out in order once the line is back.
- A message that cannot be replayed because the client was away longer than the project's retention is reported as an error with code 410: reload that channel's history over REST.
- The project can refuse a client for good (Realtime switched off, or the connection was removed in the dashboard). Then `connect` fails with code 403 and it does not retry.

## Voice & Video

Audio, video and screen sharing in a room: a 1:1 call, a group, or a live room with a stage and an audience. It is its own import, so apps that only use push or messaging do not download the media code.

```bash
npm i mediasoup-client   # only apps that use calls need it
```

Your **server** creates the room and mints a token for each person (the key needs the **Calls** scope):

```bash
curl -X POST https://api.zapiack.com/v1/calls/rooms -H "Authorization: Bearer $ZAPIACK_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Team standup","mode":"group"}'
curl -X POST https://api.zapiack.com/v1/calls/tokens -H "Authorization: Bearer $ZAPIACK_API_KEY" -H "Content-Type: application/json" \
  -d '{"roomId":"<the room id from above>","identity":"ada","role":"speaker"}'
```

In the page:

```ts
import { ZapiackCall } from '@zapiack/web/calls';

const call = new ZapiackCall({ getToken: () => fetch('/api/call-token').then((r) => r.text()) });
call.on('track', ({ identity, source, stream }) => {
  // source is 'audio', 'video' or 'screen'
  const el = document.createElement(source === 'audio' ? 'audio' : 'video');
  el.autoplay = true; el.playsInline = true; el.srcObject = stream;
  document.body.append(el);
});
call.on('trackEnded', ({ identity, source }) => removeElement(identity, source));
call.on('error', (e) => console.warn(e.reason, e.message));

await call.join();
await call.enableMicrophone();
await call.enableCamera();
await call.shareScreen();          // asks which screen or window
await call.setMuted('audio', true); // the others are told
await call.leave();                // stops the camera and microphone
```

- What a person may send comes from their token. A **listener** can only receive: `enableMicrophone()` rejects with reason `forbidden`.
- It **reconnects by itself** when the network drops, takes the person's place in the room again and picks up what changed. If they were away too long the call ends and `ended` fires.
- Room events can occasionally be missed, so the call **re-asks the server who is in the room every 30 seconds** and catches up (`new ZapiackCall({ getToken, resyncMs: 30000 })`; `0` turns it off).
- `call.stats()` returns bytes, packets, loss and jitter for each track being received, for a quality indicator.
- `call.members`, `call.sending`, `call.role` and `call.state` say who is here, what you are sending, what you may do and where the call is.
- A script tag works too: `dist/zapiack-calls.global.js` exposes `ZapiackCallsBundle.ZapiackCall`.

## Good to know

- Events are kept on the device and sent when the network allows, so a closed tab or a stopped service worker loses nothing.
- Only web pages open from a notification: anything else in a link is ignored.
- Pictures set on a push are shown where the browser supports them; buttons only where it shows them (Chrome and Edge do).
- Web push needs a secure page (https, or localhost while you build).

## License

MIT
