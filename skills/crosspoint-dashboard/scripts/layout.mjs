// CLI front-end for the dashboard grid.
//
// The layout math itself lives in `app/dashboard/grid.js` — the same module the
// builder UI imports — so the CLI and the app can never disagree about where a
// tile lands. This file is only argument parsing and I/O.
//
// Usage:
//   node layout.mjs <grid-spec.json>            # -> a Dashboard config (pixel rects)
//   node layout.mjs --spaces <grid-spec.json>   # -> a builder-importable spaces file
//   node layout.mjs --validate <dash.json>      # -> validates pixel rects, exit 1 if bad
//   node layout.mjs --selftest                  # -> internal assertions

export {
  CANVAS,
  DEFAULT_GRID,
  canPlace,
  cellRect,
  findOutOfBounds,
  findOverlaps,
  gridToPixels,
  layoutSpace,
  migrateSpacesState,
  refitToGrid,
  validate,
} from "../../../app/dashboard/grid.js";

import {
  CANVAS,
  DEFAULT_GRID,
  findOutOfBounds,
  gridToPixels,
  layoutSpace,
  validate,
} from "../../../app/dashboard/grid.js";

async function readJson(path) {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Wrap a grid spec as builder state (schema v2), which `/dashboard` can load via
 * its "Import JSON" button. Widgets keep their grid coords — the builder derives
 * pixels itself, so an imported layout stays editable in the cell picker.
 */
function toSpacesState(spec) {
  const grid = {
    cols: spec.cols,
    rows: spec.rows,
    margin: spec.margin ?? DEFAULT_GRID.margin,
    gutter: spec.gutter ?? DEFAULT_GRID.gutter,
  };
  const widgets = (spec.widgets ?? []).map((w) => ({
    colSpan: 1,
    rowSpan: 1,
    ...w,
  }));
  // Fail loudly here rather than handing the builder a broken layout.
  layoutSpace({ grid, widgets });
  return {
    version: 2,
    activeIndex: 0,
    spaces: [{ id: spec.id ?? "s1", name: spec.name ?? "Space 1", grid, widgets }],
  };
}

function selftest() {
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

  const bad = validate([
    { id: "x", x: 0, y: 0, w: 100, h: 100 },
    { id: "y", x: 50, y: 50, w: 100, h: 100 },
  ]);
  console.assert(!bad.ok && bad.overlaps.length === 1, "selftest: overlap detected", bad);

  let threw = false;
  try {
    gridToPixels({ cols: 1, rows: 1, widgets: [{ id: "a", col: 0, row: 0 }, { id: "b", col: 0, row: 0 }] });
  } catch {
    threw = true;
  }
  console.assert(threw, "selftest: cell collision must throw");

  const state = toSpacesState({ cols: 2, rows: 1, widgets: [{ id: "a", type: "metric", col: 0, row: 0 }] });
  console.assert(state.version === 2 && state.spaces[0].widgets[0].col === 0, "selftest: spaces export");

  console.log("selftest OK");
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--selftest") return selftest();

  if (args[0] === "--validate") {
    const dash = await readJson(args[1]);
    const widgets = Array.isArray(dash) ? dash : dash.widgets;
    const canvas = dash.width ? { width: dash.width, height: dash.height } : CANVAS;
    const v = validate(widgets, canvas);
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

  if (args[0] === "--spaces") {
    if (!args[1]) {
      console.error("usage: node layout.mjs --spaces <grid-spec.json>");
      process.exit(2);
    }
    console.log(JSON.stringify(toSpacesState(await readJson(args[1])), null, 2));
    return;
  }

  if (!args[0]) {
    console.error(
      "usage: node layout.mjs <grid-spec.json> | --spaces <grid-spec.json> | " +
        "--validate <dash.json> | --selftest",
    );
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

// Referenced so the re-export list above stays honest if the module is trimmed.
void findOutOfBounds;
