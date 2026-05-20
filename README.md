# WatchDog
⚠️Entire project needs to be tested before usage.needs fixes
A Chrome extension (Manifest V3) that monitors any element on any webpage for changes and alerts you via system notifications.

## Features

- **Element picker** — click any element on a page to generate a stable CSS selector
- **Flexible conditions** — any change, price drops/rises, text contains, becomes available
- **Smart fetching** — static HTML first, offscreen document fallback for JS-rendered pages
- **Reliable scheduling** — single master alarm with per-tracker `nextCheckAt` timestamps
- **MV3 recovery** — watchdog timestamp pattern for stale checks, cold-start missed alarm recovery
- **Rate limiting** — per-domain courtesy throttle and exponential backoff on errors

## Installation

1. Clone or download this folder
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `watchdog` directory

Requires Chrome 120+.

## Usage

1. Click the WatchDog icon → **+ Add Tracker**, or right-click any page → **WatchDog: Pick element to track**
2. Click **Pick element** — the popup closes; click an element on the page
3. Re-open the popup to complete the form and save
4. WatchDog checks on your chosen interval and sends notifications when conditions are met

**Check now** works on paused or errored trackers for manual verification without resuming scheduled checks.

Open **Options** (right-click extension icon → Options) for full tracker history, export/import, settings, and debug logs.

## Architecture

- `background.js` — service worker: master alarm, fetch pipeline, message router, startup recovery
- `content.js` — element picker (injected on demand only)
- `offscreen/` — JS-rendered page fallback (one document at a time, serialized)
- `utils/` — storage, normalizer, fetchers, semaphore, logger, selector generation

## Known Limitations

1. **JS-rendered SPAs** — React/Vue/Next.js pages may not expose values in static HTML. The offscreen fallback helps for many sites but is blocked by `X-Frame-Options` / CSP on frame-busting sites.

2. **Login-gated pages** — Cookie forwarding works only if you are already logged in on the same Chrome profile. Does not handle 2FA or session expiry.

3. **Bot detection** — Cloudflare, Akamai, PerimeterX may return CAPTCHA or 403. WatchDog cannot bypass these.

4. **Terms of Service** — Automated fetching may violate some sites' ToS. Users are responsible for compliance.

5. **Shadow DOM** — Closed shadow roots are not accessible. Open shadow hosts are tracked with a composite selector; reliability may vary.

6. **iframes** — Cross-origin iframes cannot be accessed (Same-Origin Policy).

## License

MIT
