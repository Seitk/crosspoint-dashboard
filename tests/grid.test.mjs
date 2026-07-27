import assert from "node:assert/strict";
import test from "node:test";

import {
  CANVAS,
  canPlace,
  cellRect,
  clampPlacement,
  defaultSpan,
  dragPlacement,
  firstFreePlacement,
  inferGrid,
  isValidGrid,
  layoutSpace,
  migrateSpacesState,
  pointToCell,
  refitToGrid,
  resizePlacement,
  snapToGrid,
  validate,
} from "../app/dashboard/grid.js";

/** Every grid shape a user can plausibly dial in from the builder controls. */
const SHAPES = [
  { cols: 1, rows: 1 }, { cols: 2, rows: 2 }, { cols: 3, rows: 2 },
  { cols: 4, rows: 3 }, { cols: 2, rows: 4 }, { cols: 6, rows: 4 },
];

test("layoutSpace: filling every cell never overlaps, for any grid shape", () => {
  for (const shape of SHAPES) {
    const grid = { ...shape, margin: 16, gutter: 12 };
    const widgets = [];
    for (let row = 0; row < shape.rows; row++) {
      for (let col = 0; col < shape.cols; col++) {
        widgets.push({ id: `w${col}-${row}`, type: "metric", col, row, colSpan: 1, rowSpan: 1 });
      }
    }
    const dash = layoutSpace({ grid, widgets });
    assert.equal(dash.widgets.length, shape.cols * shape.rows, `${shape.cols}x${shape.rows} count`);
    const v = validate(dash.widgets);
    assert.ok(v.ok, `${shape.cols}x${shape.rows} must be clean: ${JSON.stringify(v)}`);
    for (const w of dash.widgets) {
      assert.ok(w.w > 0 && w.h > 0, "positive size");
      assert.equal(w.col, undefined, "grid fields stripped from pixel output");
    }
  }
});

test("layoutSpace: spanning tiles still produce disjoint rects", () => {
  const dash = layoutSpace({
    grid: { cols: 3, rows: 3, margin: 16, gutter: 12 },
    widgets: [
      { id: "wide", type: "list", col: 0, row: 0, colSpan: 3, rowSpan: 1 },
      { id: "tall", type: "text", col: 0, row: 1, colSpan: 1, rowSpan: 2 },
      { id: "block", type: "metric", col: 1, row: 1, colSpan: 2, rowSpan: 2 },
    ],
  });
  assert.ok(validate(dash.widgets).ok, "spans must not intersect");
});

test("layoutSpace: two widgets claiming a cell throws", () => {
  assert.throws(
    () =>
      layoutSpace({
        grid: { cols: 2, rows: 1 },
        widgets: [
          { id: "a", col: 0, row: 0 },
          { id: "b", col: 0, row: 0 },
        ],
      }),
    /overlaps/,
  );
});

test("layoutSpace: a span past the grid edge throws", () => {
  assert.throws(
    () => layoutSpace({ grid: { cols: 2, rows: 1 }, widgets: [{ id: "a", col: 1, row: 0, colSpan: 2 }] }),
    /outside/,
  );
});

test("cellRect: tiles stay inside the canvas and respect the margin", () => {
  const grid = { cols: 3, rows: 2, margin: 16, gutter: 12 };
  const last = cellRect({ col: 2, row: 1, colSpan: 1, rowSpan: 1 }, grid);
  assert.ok(last.x >= grid.margin && last.y >= grid.margin, "inside top-left margin");
  assert.ok(last.x + last.w <= CANVAS.width - grid.margin + 1, "inside right margin");
  assert.ok(last.y + last.h <= CANVAS.height - grid.margin + 1, "inside bottom margin");
});

test("canPlace: an occupied cell is refused, a free one is allowed", () => {
  const widgets = [
    { id: "a", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: "b", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
  ];
  const grid = { cols: 2, rows: 2 };
  assert.equal(canPlace(widgets, grid, "a", { col: 1, row: 0, colSpan: 1, rowSpan: 1 }), false);
  assert.equal(canPlace(widgets, grid, "a", { col: 0, row: 1, colSpan: 1, rowSpan: 1 }), true);
  // A widget never blocks itself.
  assert.equal(canPlace(widgets, grid, "a", { col: 0, row: 0, colSpan: 1, rowSpan: 2 }), true);
  // Out of bounds is refused even when empty.
  assert.equal(canPlace(widgets, grid, "a", { col: 1, row: 1, colSpan: 2, rowSpan: 1 }), false);
});

test("clampPlacement: an out-of-range placement is pulled inside the grid", () => {
  const p = clampPlacement({ col: 9, row: 9, colSpan: 5, rowSpan: 5 }, { cols: 3, rows: 2 });
  assert.deepEqual(p, { col: 0, row: 0, colSpan: 3, rowSpan: 2 });
});

test("refitToGrid: shrinking the grid keeps every widget, in bounds and disjoint", () => {
  const widgets = [
    { id: "a", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: "b", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
    { id: "c", col: 2, row: 0, colSpan: 1, rowSpan: 1 },
    { id: "d", col: 3, row: 0, colSpan: 1, rowSpan: 1 },
  ];
  const grid = { cols: 2, rows: 2, margin: 16, gutter: 12 };
  const { widgets: fitted, moved } = refitToGrid(widgets, grid);

  assert.equal(fitted.length, 4, "no widget is dropped");
  assert.ok(moved.length > 0, "the ones that had to move are reported");
  // The refitted layout must actually render cleanly.
  assert.ok(validate(layoutSpace({ grid, widgets: fitted }).widgets).ok);
});

test("refitToGrid: an already-valid layout is left alone", () => {
  const widgets = [
    { id: "a", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: "b", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
  ];
  const { widgets: fitted, moved } = refitToGrid(widgets, { cols: 2, rows: 2 });
  assert.deepEqual(moved, []);
  assert.deepEqual(fitted, widgets);
});

test("snapToGrid: the default 2x2 pixel layout maps back to its own cells", () => {
  const grid = { cols: 2, rows: 2, margin: 16, gutter: 12 };
  assert.deepEqual(snapToGrid({ x: 16, y: 16, w: 372, h: 200 }, grid), { col: 0, row: 0, colSpan: 1, rowSpan: 1 });
  assert.deepEqual(snapToGrid({ x: 404, y: 16, w: 372, h: 200 }, grid), { col: 1, row: 0, colSpan: 1, rowSpan: 1 });
  assert.deepEqual(snapToGrid({ x: 16, y: 232, w: 372, h: 280 }, grid), { col: 0, row: 1, colSpan: 1, rowSpan: 1 });
  assert.deepEqual(snapToGrid({ x: 404, y: 232, w: 372, h: 280 }, grid), { col: 1, row: 1, colSpan: 1, rowSpan: 1 });
});

test("inferGrid: distinct pixel origins become columns and rows", () => {
  const grid = inferGrid([
    { x: 16, y: 16, w: 372, h: 200 },
    { x: 404, y: 16, w: 372, h: 200 },
    { x: 16, y: 232, w: 372, h: 280 },
  ]);
  assert.equal(grid.cols, 2);
  assert.equal(grid.rows, 2);
});

// ---- grid density -----------------------------------------------------------

test("the default 12x6 grid is drawable and every cell is disjoint", () => {
  const grid = { cols: 12, rows: 6, margin: 16, gutter: 12 };
  assert.equal(isValidGrid(grid), true);
  const widgets = [];
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 12; col++) {
      widgets.push({ id: `w${col}-${row}`, type: "metric", col, row, colSpan: 1, rowSpan: 1 });
    }
  }
  const dash = layoutSpace({ grid, widgets });
  assert.equal(dash.widgets.length, 72);
  assert.ok(validate(dash.widgets).ok, "72 cells must not overlap");
  assert.ok(dash.widgets.every((w) => w.w > 0 && w.h > 0), "every cell has pixels");
});

test("isValidGrid rejects a grid whose margin/gutter leave no room for a cell", () => {
  // 12 rows with a 48px gutter overruns the 528px canvas: cellH goes negative.
  assert.equal(isValidGrid({ cols: 12, rows: 12, margin: 16, gutter: 48 }), false);
  assert.equal(isValidGrid({ cols: 12, rows: 12, margin: 64, gutter: 48 }), false);
  assert.equal(isValidGrid({ cols: 12, rows: 12, margin: 64, gutter: 12 }), true);
});

test("defaultSpan scales a new widget with the grid", () => {
  assert.deepEqual(defaultSpan({ cols: 12, rows: 6 }), { colSpan: 4, rowSpan: 2 });
  assert.deepEqual(defaultSpan({ cols: 2, rows: 2 }), { colSpan: 1, rowSpan: 1 });
  assert.deepEqual(defaultSpan({ cols: 3, rows: 2 }), { colSpan: 1, rowSpan: 1 });
  assert.deepEqual(defaultSpan({ cols: 1, rows: 1 }), { colSpan: 1, rowSpan: 1 });
});

test("firstFreePlacement finds a free block and never returns an overlap", () => {
  const grid = { cols: 12, rows: 6, margin: 16, gutter: 12 };
  const widgets = [];
  // Fill the top-left 8x4 with 4x4 blocks, then ask for another 4x4.
  for (const [col, row] of [[0, 0], [4, 0]]) {
    widgets.push({ id: `w${col}`, col, row, colSpan: 4, rowSpan: 4 });
  }
  const spot = firstFreePlacement(widgets, grid, 4, 4);
  assert.deepEqual(spot, { col: 8, row: 0, colSpan: 4, rowSpan: 4 });
  assert.ok(canPlace(widgets, grid, "new", spot), "returned block is free");
});

test("firstFreePlacement returns null when the grid is completely full", () => {
  // The four starter quadrants cover every cell of the default 12x6 grid, so
  // adding a widget must be refused rather than placed on top of another.
  const grid = { cols: 12, rows: 6, margin: 16, gutter: 12 };
  const widgets = [
    { id: "a", col: 0, row: 0, colSpan: 6, rowSpan: 3 },
    { id: "b", col: 6, row: 0, colSpan: 6, rowSpan: 3 },
    { id: "c", col: 0, row: 3, colSpan: 6, rowSpan: 3 },
    { id: "d", col: 6, row: 3, colSpan: 6, rowSpan: 3 },
  ];
  assert.ok(layoutSpace({ grid, widgets }), "the four quadrants themselves are valid");
  assert.equal(firstFreePlacement(widgets, grid, 4, 2), null);
  assert.equal(firstFreePlacement(widgets, grid, 1, 1), null);
});

test("firstFreePlacement falls back to a single cell when no block fits", () => {
  const grid = { cols: 2, rows: 2, margin: 16, gutter: 12 };
  const widgets = [
    { id: "a", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: "b", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
    { id: "c", col: 0, row: 1, colSpan: 1, rowSpan: 1 },
  ];
  // A 2x2 block cannot fit, but cell (1,1) is still free.
  const spot = firstFreePlacement(widgets, grid, 2, 2);
  assert.deepEqual(spot, { col: 1, row: 1, colSpan: 1, rowSpan: 1 });
  assert.ok(canPlace(widgets, grid, "new", spot));
});

// ---- pointer gestures -------------------------------------------------------

const G32 = { cols: 3, rows: 2, margin: 16, gutter: 12 };

test("pointToCell: a point inside a cell resolves to that cell", () => {
  // Centre of each cell must map back to its own coordinates.
  for (let row = 0; row < G32.rows; row++) {
    for (let col = 0; col < G32.cols; col++) {
      const r = cellRect({ col, row, colSpan: 1, rowSpan: 1 }, G32);
      const centre = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      assert.deepEqual(pointToCell(centre, G32), { col, row }, `centre of ${col},${row}`);
    }
  }
});

test("pointToCell: points outside the canvas clamp to the edge cells", () => {
  assert.deepEqual(pointToCell({ x: -500, y: -500 }, G32), { col: 0, row: 0 });
  assert.deepEqual(pointToCell({ x: 99999, y: 99999 }, G32), { col: 2, row: 1 });
});

test("dragPlacement: dragging one cell to the right moves one column", () => {
  const w = { id: "a", col: 0, row: 0, colSpan: 1, rowSpan: 1 };
  const { cellW } = { cellW: cellRect({ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, G32).w };
  const stride = cellW + G32.gutter;
  assert.deepEqual(dragPlacement(w, stride, 0, G32), { col: 1, row: 0, colSpan: 1, rowSpan: 1 });
});

test("dragPlacement: a sub-half-cell nudge does not move the widget", () => {
  const w = { id: "a", col: 1, row: 0, colSpan: 1, rowSpan: 1 };
  assert.deepEqual(dragPlacement(w, 8, 6, G32), { col: 1, row: 0, colSpan: 1, rowSpan: 1 });
});

test("dragPlacement: a drag past the edge clamps, keeping the span in bounds", () => {
  const w = { id: "a", col: 0, row: 0, colSpan: 2, rowSpan: 1 };
  const far = dragPlacement(w, 100000, 100000, G32);
  // cols=3, colSpan=2 -> furthest legal col is 1; rows=2, rowSpan=1 -> row 1.
  assert.deepEqual(far, { col: 1, row: 1, colSpan: 2, rowSpan: 1 });
  assert.ok(canPlace([w], G32, "a", far), "clamped placement is legal");
});

test("dragPlacement: span is preserved across a move", () => {
  const w = { id: "a", col: 0, row: 0, colSpan: 3, rowSpan: 1 };
  const moved = dragPlacement(w, 0, 400, G32);
  assert.equal(moved.colSpan, 3);
  assert.equal(moved.rowSpan, 1);
  assert.equal(moved.col, 0, "a full-width tile cannot shift sideways");
});

test("resizePlacement: dragging the corner out one cell grows the span", () => {
  const w = { id: "a", col: 0, row: 0, colSpan: 1, rowSpan: 1 };
  const r = cellRect(w, G32);
  const grown = resizePlacement(w, r.w + G32.gutter, 0, G32);
  assert.deepEqual(grown, { col: 0, row: 0, colSpan: 2, rowSpan: 1 });
});

test("resizePlacement: shrinking below one cell floors at 1x1", () => {
  const w = { id: "a", col: 0, row: 0, colSpan: 2, rowSpan: 2 };
  assert.deepEqual(resizePlacement(w, -100000, -100000, G32), {
    col: 0,
    row: 0,
    colSpan: 1,
    rowSpan: 1,
  });
});

test("resizePlacement: growth is capped at the grid edge and never moves the origin", () => {
  const w = { id: "a", col: 1, row: 0, colSpan: 1, rowSpan: 1 };
  const big = resizePlacement(w, 100000, 100000, G32);
  assert.equal(big.col, 1, "origin fixed");
  assert.equal(big.row, 0, "origin fixed");
  assert.equal(big.colSpan, 2, "cols=3 from col 1 -> max span 2");
  assert.equal(big.rowSpan, 2, "rows=2 from row 0 -> max span 2");
  assert.ok(canPlace([w], G32, "a", big), "capped placement is legal");
});

test("gestures: an illegal drop is caught by canPlace, leaving the caller to revert", () => {
  const widgets = [
    { id: "a", col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: "b", col: 1, row: 0, colSpan: 1, rowSpan: 1 },
  ];
  const r = cellRect(widgets[0], G32);
  const onto = dragPlacement(widgets[0], r.w + G32.gutter, 0, G32); // straight onto "b"
  assert.deepEqual(onto, { col: 1, row: 0, colSpan: 1, rowSpan: 1 });
  assert.equal(canPlace(widgets, G32, "a", onto), false, "drop must be refused");
});

test("migrateSpacesState: v1 pixel state converts without losing widgets or scripts", () => {
  const v1 = {
    activeIndex: 0,
    spaces: [
      {
        id: "s1",
        name: "Space 1",
        widgets: [
          { id: "w1", type: "metric", x: 16, y: 16, w: 372, h: 200, label: "AAPL", value: "229.35", delta: "+1.24%", script: "return 1;" },
          { id: "w2", type: "metric", x: 404, y: 16, w: 372, h: 200, label: "Claude", value: "68%" },
          { id: "w3", type: "list", x: 16, y: 232, w: 372, h: 280, title: "TODO", items: ["a", "b"] },
          { id: "w4", type: "text", x: 404, y: 232, w: 372, h: 280, text: "HI", size: 40, align: "center" },
        ],
      },
    ],
  };

  const v2 = migrateSpacesState(structuredClone(v1));
  assert.equal(v2.version, 3, "migrates all the way to the current schema");
  const space = v2.spaces[0];
  assert.equal(space.widgets.length, 4, "widget count preserved");
  assert.ok(space.grid.cols >= 1 && space.grid.rows >= 1, "a grid was inferred");

  for (const w of space.widgets) {
    assert.equal(w.x, undefined, "pixel fields dropped");
    assert.equal(typeof w.col, "number");
    assert.equal(typeof w.row, "number");
  }
  // Display fields and scripts survive untouched.
  const w1 = space.widgets.find((w) => w.id === "w1");
  assert.equal(w1.label, "AAPL");
  assert.equal(w1.value, "229.35");
  assert.equal(w1.delta, "+1.24%");
  assert.equal(w1.script, "return 1;", "script carried across");
  assert.deepEqual(space.widgets.find((w) => w.id === "w3").items, ["a", "b"]);
  // v3 folds a text widget's top-level size/align into its per-field style map.
  const w4 = space.widgets.find((w) => w.id === "w4");
  assert.deepEqual(w4.style.text, { size: 40, align: "center" });
  assert.equal(w4.align, undefined, "legacy top-level align dropped");

  // And the migrated space must render cleanly.
  assert.ok(validate(layoutSpace(space).widgets).ok, "migrated layout is overlap-free");
});

test("migrateSpacesState: already-current state is returned untouched", () => {
  const current = {
    version: 3,
    activeIndex: 0,
    spaces: [{ id: "s1", name: "S", grid: { cols: 2, rows: 2, margin: 16, gutter: 12 }, widgets: [] }],
  };
  assert.deepEqual(migrateSpacesState(current), current);
});

test("migrateSpacesState: a v2 blob gains per-field styles without touching layout", () => {
  const v2 = {
    version: 2,
    activeIndex: 0,
    spaces: [
      {
        id: "s1",
        name: "S",
        grid: { cols: 2, rows: 2, margin: 16, gutter: 12 },
        widgets: [
          { id: "t", type: "text", col: 0, row: 0, colSpan: 1, rowSpan: 1, text: "HI", size: 40, align: "center" },
          { id: "m", type: "metric", col: 1, row: 0, colSpan: 1, rowSpan: 1, label: "L", value: "1" },
        ],
      },
    ],
  };
  const out = migrateSpacesState(structuredClone(v2));
  assert.equal(out.version, 3);

  const text = out.spaces[0].widgets.find((w) => w.id === "t");
  assert.deepEqual(text.style.text, { size: 40, align: "center" });
  assert.equal(text.size, undefined, "legacy top-level size dropped");
  assert.equal(text.align, undefined, "legacy top-level align dropped");
  // Grid placement is v2 already and must survive untouched.
  assert.deepEqual(
    { col: text.col, row: text.row, colSpan: text.colSpan, rowSpan: text.rowSpan },
    { col: 0, row: 0, colSpan: 1, rowSpan: 1 },
  );
  const metricW = out.spaces[0].widgets.find((w) => w.id === "m");
  assert.deepEqual(metricW, v2.spaces[0].widgets[1], "a metric is unaffected");
});

test("migrateSpacesState: overlapping v1 rects still yield a clean grid", () => {
  const v1 = {
    activeIndex: 0,
    spaces: [
      {
        id: "s1",
        name: "messy",
        widgets: [
          { id: "a", type: "metric", x: 16, y: 16, w: 400, h: 300, label: "A", value: "1" },
          { id: "b", type: "metric", x: 100, y: 100, w: 400, h: 300, label: "B", value: "2" },
        ],
      },
    ],
  };
  const space = migrateSpacesState(v1).spaces[0];
  assert.equal(space.widgets.length, 2, "both widgets kept");
  assert.ok(validate(layoutSpace(space).widgets).ok, "overlap resolved by refit");
});
