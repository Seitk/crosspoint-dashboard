# CrossPoint Dashboard

Turn an **Xteink X3** e-reader — running the open-source
[CrossPoint Reader](https://github.com/crosspoint-reader/crosspoint-reader) firmware — into a
low-power, always-on **push dashboard**. Compose pages of metrics, lists, and notes in a web
builder (each widget can run a small script to fetch live data from any API) and push them to the
device over your LAN. The e-ink panel holds the image with almost no power draw.

## How it works

```
┌─ YOUR COMPUTER ──────────────────────────────────────────────
│
│  browser → /dashboard builder  (Next.js, runs on Cloudflare Workers)
│              • Spaces (pages): metric / list / text widgets
│              • each widget can carry an async JS "data script"
│
│  data script  ──fetch()──▶  /api/proxy  ──▶  any HTTP API
│                             (server-side; bypasses browser CORS)
│
│  each space  ──render──▶  1-bit 792×528 framebuffer  (~52 KB)
│
└──────────────────────────────────────────────────────────────
                      │
    POST /frame?space=i&count=n&show=1   (multipart, over Wi-Fi)
                      ▼
┌─ XTEINK X3 · CrossPoint firmware fork ───────────────────────
│
│  DashboardActivity  (HTTP server on port 80)
│    • saves each frame to SD  (one file per space)
│    • blits the current space to the e-ink panel  (device does no layout)
│    • side ▲/▼ buttons flip between spaces  +  a live "System" page
│    • persists last frame · auto-launches into the dashboard on wake
│
└──────────────────────────────────────────────────────────────
```

The device is a **pure display** — all layout and rendering happen off-device, so adding a new
metric never means reflashing. You change the builder and push a new frame.

## Features

- **Spaces** — multiple pages of dashboard, cycled with the X3's side buttons (with a transient
  page indicator), plus a built-in live **System** page.
- **Widgets** — metric (label + big value + delta), list / TODO, and free text, placed on a
  non-overlapping grid.
- **Data scripts** — per-widget async JavaScript that fetches from any API (through a built-in
  CORS-dodging proxy) and returns what to show; refresh on demand or on an interval, with optional
  auto-push so the X3 updates itself.
- **System page** — Wi-Fi / SSID, IP, battery bar, and RTC time, rendered live on the device.
- **Resilient** — the last frame per space is saved to SD and restored instantly on wake/reboot,
  and the device can auto-launch straight into the dashboard.

## Quick start (web builder)

```bash
npm install
npm run dev          # then open http://localhost:3000/dashboard
```

Build a dashboard, set your X3's **Device IP** (shown on the device's System page), and **Push**.
Keep `npm run dev` running — it proxies the push to the device on your LAN.

## The firmware

The on-device piece is a drop-in `Activity` for a **CrossPoint Reader 1.4.1 fork**, kept in
[`firmware/crosspoint-dashboard/`](firmware/crosspoint-dashboard/):

```bash
git clone --recursive https://github.com/crosspoint-reader/crosspoint-reader
cd crosspoint-reader && git checkout 1.4.1
cp <this-repo>/firmware/crosspoint-dashboard/DashboardActivity.{h,cpp} src/activities/network/
# apply firmware/crosspoint-dashboard/menu-patch.md, then build:
pio run                          # -> .pio/build/default/firmware.bin
```

Flash `firmware.bin` over USB (`pio run -t upload`) or by dropping it on the SD card
(Settings → Check for updates). The folder's `README.md` has the full wire contract, the
Home-menu / auto-launch patch, and X3-specific caveats.

## Repo layout

| Path | What |
|---|---|
| `app/dashboard/` | the builder — model, canvas renderer, 1-bit packing, spaces, data scripts |
| `app/api/proxy/` | server-side fetch proxy so scripts can reach any API |
| `firmware/crosspoint-dashboard/` | the on-device `DashboardActivity` drop-in + patch notes |
| `skills/crosspoint-dashboard/` | grid-layout helper + validator (guarantees no overlap) |
| `tests/` | unit tests: frame packing, script coercion/execution, grid layout |

`CLAUDE.md` documents the architecture in more detail.

## Tests

```bash
node --test tests/frame.test.mjs tests/scripts.test.mjs tests/layout.test.mjs
npm run lint
```

## Stack

Next.js App Router compiled to a Cloudflare Worker via
[vinext](https://github.com/cloudflare/vinext); the X3 firmware is ESP32-C3 C++ (PlatformIO). The
display is 792×528 1-bit e-ink.
