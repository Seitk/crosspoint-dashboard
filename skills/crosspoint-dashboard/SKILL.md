---
name: crosspoint-dashboard
description: >-
  Build or edit a CrossPoint X3 e-ink dashboard in this repo (crosspoint-web) —
  compose metric/list/text widgets, wire per-widget data scripts that fetch from
  an API, lay everything out so tiles NEVER overlap, and push a frame to the
  device. Use this whenever the user wants to add, arrange, rearrange, or resize
  dashboard widgets/tiles, build a new dashboard screen for the X3, fix
  overlapping or misaligned tiles, or turn an API into an on-device display —
  even if they don't say the word "dashboard". Placement must go through the grid
  helper here; hand-picking pixel x/y/w/h is what causes overlaps.
---

# CrossPoint X3 dashboard builder

The X3 shows a full-screen **792×528, 1-bit** image. A "dashboard" is a set of
widgets composed in the web builder (`app/dashboard/`), rasterized to a 1-bit
frame, and pushed to the device. The device just blits the pixels — it does **no
layout and no collision handling**, so if two widgets share pixels they draw on
top of each other. That is the one failure mode this skill exists to prevent.

**The rule: never hand-place widget pixels. Place widgets on a grid, compute the
pixels with `scripts/layout.mjs`, and validate before pushing.** The grid makes
overlap structurally impossible (disjoint cells) and lets you think in tiles.

## The model (see `app/dashboard/types.ts`)

A space is `{ id, name, grid: { cols, rows, margin, gutter }, widgets: Widget[] }`.
Every widget has `id`, a **grid placement** `col, row, colSpan, rowSpan`, an optional
`script`, and type-specific fields. Pixel rects are **derived** from the grid by
`app/dashboard/grid.js` at draw/push time and are never stored — which is what makes
overlap impossible to express. That module is shared: the builder UI and this CLI both
import it, so they cannot drift.

Type-specific fields:

- **metric** — `label`, `value`, `delta?` (a KPI tile: label, big number, small delta line)
- **list** — `title`, `items: string[]` (a titled list, e.g. a TODO)
- **text** — `text` (newlines allowed), `size?`, `align?: "left" | "center"`

Rendering (how tiles look) lives in `app/dashboard/render.ts`; you rarely need to
touch it. Coordinates are device pixels with `(0,0)` at the top-left.

## Data scripts (see `app/dashboard/scripts.ts`)

Any widget can carry a `script`: the body of an `async (fetch) => …` function that
fetches from an API and **returns what to display**. On Refresh the result is
coerced into the widget's fields (`scripts-core.js`):

- metric ← a string/number (→ `value`) or `{ value, delta, label }`
- list ← an array (→ `items`) or `{ title, items }`
- text ← a string

`fetch` inside a script is proxied through `app/api/proxy` so it works for **any**
API (no browser CORS limits), including local ones. Example scripts:

```js
// metric: a stock quote
const r = await fetch('https://api.example.com/quote?sym=AAPL');
const j = await r.json();
return { value: '$' + j.price, delta: j.pct + '%' };
```
```js
// list: latest items
const r = await fetch('https://api.me/todos');
return (await r.json()).slice(0, 6).map(t => t.title);
```

## Building a dashboard — the workflow

1. **Sketch a grid.** Pick `cols`/`rows` for the whole 792×528 screen (2×2 and 2×3
   are good starting points — e-ink text needs to be large and legible, so favor a
   few big tiles over many small ones). Assign each widget a `col`, `row`, and
   optional `colSpan`/`rowSpan`.

2. **Write a grid spec** (JSON). Widget fields are the normal widget fields plus
   grid placement. Example (`/tmp/spec.json`):

   ```json
   {
     "cols": 2,
     "rows": 2,
     "margin": 16,
     "gutter": 12,
     "widgets": [
       { "id": "aapl", "type": "metric", "label": "AAPL", "value": "—",
         "col": 0, "row": 0,
         "script": "const r=await fetch('https://api.example.com/quote?sym=AAPL');const j=await r.json();return {value:'$'+j.price, delta:j.pct+'%'};" },
       { "id": "claude", "type": "metric", "label": "Claude usage", "value": "—",
         "col": 1, "row": 0 },
       { "id": "todo", "type": "list", "title": "TODO", "items": ["…"],
         "col": 0, "row": 1, "colSpan": 2 }
     ]
   }
   ```

3. **Compute pixels + auto-validate:**

   ```bash
   node skills/crosspoint-dashboard/scripts/layout.mjs /tmp/spec.json > /tmp/dashboard.json
   ```

   `layout.mjs` turns each cell into a non-overlapping pixel rect and **refuses to
   emit** a layout where two widgets share a cell or run off the grid. The output
   is a ready-to-use Dashboard config.

4. **Load it into the builder.** Generate an importable config and open it with the
   builder's **IMPORT JSON** button (Push card):

   ```bash
   node skills/crosspoint-dashboard/scripts/layout.mjs --spaces /tmp/spec.json > /tmp/spaces.json
   ```

   `--spaces` keeps the **grid coordinates**, so the imported layout stays editable
   in the builder's cell picker. **EXPORT JSON** does the reverse (round-trips the
   whole set of spaces to a file you can commit).

   > Do **not** try to inject `localStorage["crosspoint-dashboard"]` — that legacy
   > key is only read when no builder state exists yet, so on any browser that has
   > opened `/dashboard` it is silently ignored.

   (Or just edit in the builder UI — the cell picker can't produce an overlap.)

5. **Push to the X3.** In the builder set the **Device IP** (shown on the device's
   Dashboard status bar) and click **PUSH TO X3**, or enable **Auto-refresh + push**
   for a live, self-updating dashboard. (Requires `npm run dev` running and both on
   the same Wi-Fi.)

6. **Validate any hand-edited config** before trusting it:

   ```bash
   node skills/crosspoint-dashboard/scripts/layout.mjs --validate /tmp/dashboard.json
   ```

   Exits 0 and prints `OK …` when clean; exits 1 and lists the offending widget
   ids when tiles overlap or fall out of bounds. Run this whenever you place
   pixels by hand instead of through the grid.

## Why the grid guarantees no overlap

Grid cells are disjoint by construction, and `gridToPixels()` tracks cell
occupancy — two widgets can never claim the same cell (it throws). Between tiles
there's always a `gutter` of empty pixels, so independent rounding of each rect
can't cause a 1-px overlap either. `findOverlaps()` (a plain rectangle-intersection
check) is the independent proof, and `validate()` also flags anything outside the
792×528 canvas. Sanity-check the helper itself any time:

```bash
node skills/crosspoint-dashboard/scripts/layout.mjs --selftest
```

## Notes

- Design for **legibility on e-ink**: large values, few tiles, high contrast (it's
  pure black/white). A metric's `value` renders big; keep it short.
- Keep the device treated as a **plugged-in/docked** display if auto-refreshing —
  always-on Wi-Fi is heavy on battery.
- `layout.mjs` has no dependencies (Node ≥ 18, ESM). It's a library (`import
  { gridToPixels, validate } from ".../layout.mjs"`) and a CLI.
