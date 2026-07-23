# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CrossPoint Web is a local web companion for the **CrossPoint Reader** firmware running on the
**XTEINK X3** e-reader. The UI (in Traditional Chinese / Cantonese) reads live device status and
uploads custom files to the device's SD card over the LAN. It is built on the `vinext` starter —
a Next.js App Router app that compiles to a **Cloudflare Worker** rather than a Node server.

## Commands

- `npm run dev` — local dev server (Vite + vinext + Miniflare). Wrangler/Miniflare state stays under `.wrangler/`.
- `npm run build` — produces the Worker bundle in `dist/` (this is the deploy artifact).
- `npm test` — runs `build` then `node --test tests/rendered-html.test.mjs`, which imports the built worker from `dist/server/index.js` and asserts on server-rendered HTML. There is no unit-test runner; a test = build + fetch the rendered page.
- `npm run lint` — ESLint (flat config, extends `next/core-web-vitals`, `next/typescript`); `dist` and `.next` are ignored.
- `npm run db:generate` — regenerate Drizzle migrations into `drizzle/` after editing `db/schema.ts`.

Run a single test with node's filter: `node --test --test-name-pattern="server-renders" tests/rendered-html.test.mjs` (build first).

Node `>=22.13.0` is required.

## Architecture

**Runtime.** `worker/index.ts` is the Cloudflare Worker entry. It intercepts `/_vinext/image` for
image optimization (via the `IMAGES` binding) and delegates everything else to vinext's
`app-router-entry` handler. `vite.config.ts` wires vinext + the Cloudflare plugin + the local
`build/sites-vite-plugin.ts`. There is intentionally **no `wrangler.jsonc`**; bindings are declared
in `.openai/hosting.json` and simulated locally by `vite.config.ts`.

**Device proxy (dev only).** The browser never talks to the X3 directly. `app/page.tsx` fetches
`/x3/api/status` and `POST /x3/upload`, passing the target device IP in an `x-crosspoint-ip` header.
`vite.config.ts`'s `server.proxy` strips `/x3`, validates the header as a private IPv4, and forwards
to `http://<ip>` (default `192.168.1.238`), removing the header before it reaches the device. **This
proxy exists only under `npm run dev`** — the production Worker has no `/x3` route, so device
communication currently only works locally.

**Optional D1 + Drizzle.** `.openai/hosting.json` declares which bindings exist (`d1`, `r2`);
both are `null` by default, so `vite.config.ts` skips creating them. `db/schema.ts` is intentionally
empty and `db/index.ts`'s `getDb()` throws unless the `DB` binding is set. `examples/d1/` is a
copy-in-when-needed reference (schema + `app/api/notes/route.ts`) showing the full pattern, including
the "run `db:generate` then deploy so the platform applies the SQL" error handling. On build,
`build/sites-vite-plugin.ts` copies `.openai/hosting.json` and `drizzle/` into `dist/.openai/`.

**ChatGPT sign-in (SIWC).** `app/chatgpt-auth.ts` reads identity from request headers injected by the
hosting platform (`oai-authenticated-user-email`, `oai-authenticated-user-full-name*`). Use
`getChatGPTUser()` for optional UI and `requireChatGPTUser(returnTo)` to gate a page. The paths
`/signin-with-chatgpt`, `/signout-with-chatgpt`, and `/callback` are **reserved by Dispatch — do not
implement app routes for them.** Pages depending on per-request identity must set
`export const dynamic = "force-dynamic"`. SIWC proves identity, not workspace membership — enforce
access separately. See README.md for the header contract.

## Conventions

- Path alias `@/*` maps to the repo root (`tsconfig.json`).
- UI copy is Traditional Chinese (Cantonese); `<html lang="zh-HK">`. Match existing tone when editing `app/page.tsx`.
- Styling is a single hand-written `app/globals.css` (Tailwind v4 via PostCSS is available but the current page uses semantic class names, not utility classes).
- To keep secrets out of the repo: application env belongs in ignored `.env*` files, not in `hosting.json` (which holds only non-secret binding names).

## X3 Push Dashboard (the main feature)

The app at **`/dashboard`** (`app/dashboard/`) builds a multi-page "push dashboard" shown on
the X3 e-ink screen:

- **Model** (`types.ts`): a dashboard is `Space[]`; each space has `Widget[]` (metric/list/text)
  on a **792×528** 1-bit canvas. Widgets carry an optional `script`. `render.ts` draws to a
  canvas → thresholds to 1-bit → packs to a framebuffer (`monochrome.js`) or PNG.
- **Data scripts** (`scripts.ts` + `scripts-core.js`): a widget's `script` is an async JS body
  that fetches from an API (through the `app/api/proxy` route, which dodges browser CORS) and
  returns what to show; the result is coerced into the widget's fields. The pure logic
  (`coerceResult`/`runScript`/`applyScriptResult`) is in `scripts-core.js` so `node --test` covers it.
- **Push**: the builder rasterizes each space to a packed 1-bpp frame and POSTs it as
  `multipart/form-data` to `/x3/frame?space=&count=&show=` (via the dev `/x3` proxy).
- **Firmware**: the on-device `DashboardActivity` drop-in lives in `firmware/crosspoint-dashboard/`.
  Build it by cloning the external `crosspoint-reader` fork into `firmware/crosspoint-reader/`
  (git-ignored) and applying the drop-in + `menu-patch.md`. It stores spaces on SD, cycles them
  with the side buttons, has a built-in System page (Wi-Fi/IP/battery/time), and persists +
  auto-launches after sleep.
- **Skill**: `skills/crosspoint-dashboard/` — a grid-layout helper + validator that guarantees
  widgets never overlap.

Pure logic is unit-tested under `tests/` — run
`node --test tests/frame.test.mjs tests/scripts.test.mjs tests/layout.test.mjs`.
