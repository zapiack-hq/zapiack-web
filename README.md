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

## Good to know

- Events are kept on the device and sent when the network allows, so a closed tab or a stopped service worker loses nothing.
- Only web pages open from a notification: anything else in a link is ignored.
- Pictures set on a push are shown where the browser supports them; buttons only where it shows them (Chrome and Edge do).
- Web push needs a secure page (https, or localhost while you build).

## License

MIT
