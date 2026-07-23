import assert from "node:assert/strict";
import test from "node:test";

import {
  findOutOfBounds,
  findOverlaps,
  gridToPixels,
  validate,
} from "../skills/crosspoint-dashboard/scripts/layout.mjs";

test("gridToPixels: a 2x2 grid yields non-overlapping, in-bounds rects", () => {
  const dash = gridToPixels({
    cols: 2,
    rows: 2,
    widgets: [
      { id: "a", col: 0, row: 0 },
      { id: "b", col: 1, row: 0 },
      { id: "c", col: 0, row: 1, colSpan: 2 },
    ],
  });
  assert.equal(dash.width, 792);
  assert.equal(dash.height, 528);
  assert.deepEqual(validate(dash.widgets), { ok: true, overlaps: [], outOfBounds: [] });
  for (const w of dash.widgets) {
    assert.ok(w.w > 0 && w.h > 0, "positive size");
    assert.equal(w.col, undefined, "grid fields stripped");
  }
});

test("gridToPixels: two widgets in the same cell throws", () => {
  assert.throws(
    () =>
      gridToPixels({
        cols: 1,
        rows: 1,
        widgets: [
          { id: "a", col: 0, row: 0 },
          { id: "b", col: 0, row: 0 },
        ],
      }),
    /overlaps/,
  );
});

test("gridToPixels: a span past the grid edge throws", () => {
  assert.throws(
    () => gridToPixels({ cols: 2, rows: 1, widgets: [{ id: "a", col: 1, row: 0, colSpan: 2 }] }),
    /outside/,
  );
});

test("findOverlaps: intersecting rects are reported as a pair", () => {
  const o = findOverlaps([
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 50, y: 50, w: 100, h: 100 },
  ]);
  assert.deepEqual(o, [{ a: "a", b: "b" }]);
});

test("findOverlaps: rects touching at an edge do NOT overlap", () => {
  const o = findOverlaps([
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 100, y: 0, w: 100, h: 100 },
  ]);
  assert.equal(o.length, 0);
});

test("findOutOfBounds: flags rects that leave the 792x528 canvas", () => {
  assert.deepEqual(findOutOfBounds([{ id: "a", x: 700, y: 0, w: 200, h: 100 }]), ["a"]);
  assert.deepEqual(findOutOfBounds([{ id: "a", x: 0, y: 0, w: 100, h: 100 }]), []);
});
