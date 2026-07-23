// Grid layout + overlap validator for CrossPoint X3 dashboards.
//
// Why a grid: the X3 renders whatever pixel rectangles you give it, with no
// collision handling — two widgets with overlapping x/y/w/h will draw on top of
// each other. Placing widgets on a grid (col/row/colSpan/rowSpan) makes overlap
// structurally impossible (disjoint cells) and lets a human think in tiles, not
// pixels. gridToPixels() computes the pixel rects; validate() is the safety net
// that proves the result is clean before you push it to the device.
//
// Usage as a library:
//   import { gridToPixels, validate } from "./layout.mjs";
// Usage as a CLI:
//   node layout.mjs <grid-spec.json>        # -> prints a Dashboard config (stdout)
//   node layout.mjs --validate <dash.json>  # -> validates pixel widgets, exit 1 if bad
//   node layout.mjs --selftest              # -> runs internal assertions

export const CANVAS = { width: 792, height: 528 }; // X3, portrait; verified in firmware

const DEFAULTS = { margin: 16, gutter: 12 };

/**
 * Compute non-overlapping pixel rects from a grid spec.
 *
 * spec = {
 *   cols, rows,                       // grid dimensions (required)
 *   margin?, gutter?,                 // px around the edge / between cells
 *   canvas? = CANVAS,
 *   widgets: [{ ...widgetFields, col, row, colSpan?=1, rowSpan?=1 }]
 * }
 *
 * Returns a Dashboard: { width, height, widgets: [{ ...widgetFields, x, y, w, h }] }
 * with the grid fields (col/row/colSpan/rowSpan) stripped. Throws if two widgets
 * claim the same cell or a widget runs past the grid edge — i.e. it refuses to
 * emit an overlapping or out-of-bounds layout.
 */
export function gridToPixels(spec) {
  const canvas = spec.canvas ?? CANVAS;
  const margin = spec.margin ?? DEFAULTS.margin;
  const gutter = spec.gutter ?? DEFAULTS.gutter;
  const { cols, rows, widgets } = spec;
  if (!(cols > 0) || !(rows > 0)) throw new Error("grid spec needs positive cols and rows");

  const cellW = (canvas.width - 2 * margin - (cols - 1) * gutter) / cols;
  const cellH = (canvas.height - 2 * margin - (rows - 1) * gutter) / rows;
  if (cellW <= 0 || cellH <= 0) {
    throw new Error(`grid too dense for the canvas (cellW=${cellW}, cellH=${cellH})`);
  }

  const occupied = new Set(); // "col,row" cells already claimed
  const out = [];
  for (const wdg of widgets) {
    const { col, row, colSpan = 1, rowSpan = 1, ...fields } = wdg;
    if (col < 0 || row < 0 || col + colSpan > cols || row + rowSpan > rows) {
      throw new Error(
        `widget ${wdg.id ?? "?"} at (col ${col}, row ${row}, span ${colSpan}x${rowSpan}) ` +
          `runs outside the ${cols}x${rows} grid`,
      );
    }
    for (let c = col; c < col + colSpan; c++) {
      for (let r = row; r < row + rowSpan; r++) {
        const key = `${c},${r}`;
        if (occupied.has(key)) {
          throw new Error(`widget ${wdg.id ?? "?"} overlaps another at cell (${c}, ${r})`);
        }
        occupied.add(key);
      }
    }
    out.push({
      ...fields,
      x: Math.round(margin + col * (cellW + gutter)),
      y: Math.round(margin + row * (cellH + gutter)),
      w: Math.round(colSpan * cellW + (colSpan - 1) * gutter),
      h: Math.round(rowSpan * cellH + (rowSpan - 1) * gutter),
    });
  }
  return { width: canvas.width, height: canvas.height, widgets: out };
}

/** Pixel-rect overlaps. Returns [{ a, b }] for every overlapping pair (by id or index). */
export function findOverlaps(widgets) {
  const pairs = [];
  const id = (w, i) => w.id ?? `#${i}`;
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      const a = widgets[i];
      const b = widgets[j];
      const overlap =
        a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      if (overlap) pairs.push({ a: id(a, i), b: id(b, j) });
    }
  }
  return pairs;
}

/** Widget ids whose rect falls outside the canvas. */
export function findOutOfBounds(widgets, canvas = CANVAS) {
  const bad = [];
  widgets.forEach((w, i) => {
    if (w.x < 0 || w.y < 0 || w.x + w.w > canvas.width || w.y + w.h > canvas.height) {
      bad.push(w.id ?? `#${i}`);
    }
  });
  return bad;
}

/** Combined check. { ok, overlaps, outOfBounds }. Use before pushing. */
export function validate(widgets, canvas = CANVAS) {
  const overlaps = findOverlaps(widgets);
  const outOfBounds = findOutOfBounds(widgets, canvas);
  return { ok: overlaps.length === 0 && outOfBounds.length === 0, overlaps, outOfBounds };
}

// ---- CLI ------------------------------------------------------------------

async function readJson(path) {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8"));
}

function selftest() {
  // Two full-height columns side by side: must not overlap.
  const dash = gridToPixels({
    cols: 2,
    rows: 2,
    widgets: [
      { id: "a", type: "metric", col: 0, row: 0 },
      { id: "b", type: "metric", col: 1, row: 0 },
      { id: "c", type: "list", col: 0, row: 1, colSpan: 2 },
    ],
  });
  const v = validate(dash.widgets);
  console.assert(v.ok, "selftest: grid layout must be overlap-free", v);
  console.assert(dash.widgets.every((w) => w.w > 0 && w.h > 0), "selftest: positive sizes");

  // A hand-made overlap must be caught.
  const bad = validate([
    { id: "x", x: 0, y: 0, w: 100, h: 100 },
    { id: "y", x: 50, y: 50, w: 100, h: 100 },
  ]);
  console.assert(!bad.ok && bad.overlaps.length === 1, "selftest: overlap detected", bad);

  // Cell collision must throw.
  let threw = false;
  try {
    gridToPixels({ cols: 1, rows: 1, widgets: [{ id: "a", col: 0, row: 0 }, { id: "b", col: 0, row: 0 }] });
  } catch {
    threw = true;
  }
  console.assert(threw, "selftest: cell collision must throw");

  console.log("selftest OK");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--selftest") return selftest();

  if (args[0] === "--validate") {
    const dash = await readJson(args[1]);
    const widgets = Array.isArray(dash) ? dash : dash.widgets;
    const v = validate(widgets, dash.width ? { width: dash.width, height: dash.height } : CANVAS);
    if (v.ok) {
      console.log(`OK — ${widgets.length} widgets, no overlaps, all in bounds.`);
    } else {
      console.error("INVALID layout:");
      if (v.overlaps.length) console.error("  overlaps:", JSON.stringify(v.overlaps));
      if (v.outOfBounds.length) console.error("  out of bounds:", JSON.stringify(v.outOfBounds));
      process.exit(1);
    }
    return;
  }

  if (!args[0]) {
    console.error("usage: node layout.mjs <grid-spec.json> | --validate <dash.json> | --selftest");
    process.exit(2);
  }

  const spec = await readJson(args[0]);
  const dash = gridToPixels(spec);
  const v = validate(dash.widgets, { width: dash.width, height: dash.height });
  if (!v.ok) {
    console.error("BUG: gridToPixels produced an invalid layout", v);
    process.exit(1);
  }
  console.log(JSON.stringify(dash, null, 2));
}

// Run as CLI only when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
