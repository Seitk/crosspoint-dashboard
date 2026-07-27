import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_FONT,
  anchorX,
  fieldAt,
  fieldLayout,
  fieldsOf,
  migrateWidgetStyle,
} from "../app/dashboard/fields.js";
import { cellRect } from "../app/dashboard/grid.js";

const GRID = { cols: 12, rows: 6, margin: 16, gutter: 12 };

/** Pixel rect for a tile of the given span on the default grid. */
const tile = (colSpan, rowSpan) =>
  cellRect({ col: 0, row: 0, colSpan, rowSpan }, GRID);

const metric = (over = {}) => ({
  id: "m",
  type: "metric",
  label: "AAPL",
  value: "229.35",
  delta: "+1.24%",
  ...over,
});

test("fieldsOf lists each type's fields in draw order", () => {
  assert.deepEqual(fieldsOf("metric"), ["label", "value", "delta"]);
  assert.deepEqual(fieldsOf("list"), ["title", "items"]);
  assert.deepEqual(fieldsOf("text"), ["text"]);
  assert.deepEqual(fieldsOf("nope"), []);
});

test("a roomy tile keeps the sizes the renderer used to hardcode", () => {
  // 6x3 is the starter quadrant — it must look exactly as it always did.
  const fields = fieldLayout(metric(), tile(6, 3));
  assert.deepEqual(
    fields.map((f) => [f.key, f.size]),
    [["label", 20], ["value", 60], ["delta", 22]],
  );
  assert.ok(fields.every((f) => f.auto), "no explicit sizes set");
});

test("every field box stays inside its tile, at any span on the grid", () => {
  for (let colSpan = 1; colSpan <= 12; colSpan++) {
    for (let rowSpan = 1; rowSpan <= 6; rowSpan++) {
      const rect = tile(colSpan, rowSpan);
      for (const w of [metric(), { id: "l", type: "list", title: "T", items: ["a", "b"] }, { id: "t", type: "text", text: "hi" }]) {
        for (const f of fieldLayout(w, rect)) {
          assert.ok(f.x >= rect.x, `${w.type}.${f.key} left edge @${colSpan}x${rowSpan}`);
          assert.ok(f.y >= rect.y, `${w.type}.${f.key} top edge @${colSpan}x${rowSpan}`);
          assert.ok(f.x + f.w <= rect.x + rect.w, `${w.type}.${f.key} right edge @${colSpan}x${rowSpan}`);
          assert.ok(f.y + f.h <= rect.y + rect.h, `${w.type}.${f.key} bottom edge @${colSpan}x${rowSpan}`);
          // The whole point: one line of text must fit in its own box.
          assert.ok(f.size <= f.h, `${w.type}.${f.key} font ${f.size} > box ${f.h} @${colSpan}x${rowSpan}`);
          assert.ok(f.size >= MIN_FONT, `${w.type}.${f.key} font floor @${colSpan}x${rowSpan}`);
        }
      }
    }
  }
});

test("field boxes never overlap each other", () => {
  for (let rowSpan = 1; rowSpan <= 6; rowSpan++) {
    const fields = fieldLayout(metric(), tile(6, rowSpan));
    for (let i = 0; i < fields.length - 1; i++) {
      const a = fields[i];
      const b = fields[i + 1];
      assert.ok(a.y + a.h <= b.y, `boxes ${a.key}/${b.key} overlap at rowSpan ${rowSpan}`);
    }
  }
});

test("a one-row metric shrinks its value instead of spilling out of the tile", () => {
  const rect = tile(4, 1);
  const value = fieldLayout(metric(), rect).find((f) => f.key === "value");
  assert.ok(value.size < 60, "60px cannot fit a one-row tile");
  assert.ok(value.y + value.h <= rect.y + rect.h, "stays inside the tile");
  // Before this module the value was drawn at y+44 with a 60px font, reaching
  // y+104 on a ~73px tall tile — 31px into the neighbouring tile.
  assert.ok(value.size <= value.h);
});

test("an explicit size is honoured when it fits", () => {
  const w = metric({ style: { value: { size: 30 } } });
  const value = fieldLayout(w, tile(6, 3)).find((f) => f.key === "value");
  assert.equal(value.size, 30);
  assert.equal(value.auto, false);
});

test("an explicit size too big for the tile is clamped, not obeyed", () => {
  const rect = tile(4, 1);
  const w = metric({ style: { value: { size: 200 } } });
  const value = fieldLayout(w, rect).find((f) => f.key === "value");
  assert.ok(value.size < 200, "must not honour a spilling size");
  assert.ok(value.size <= value.h);
  assert.ok(value.y + value.h <= rect.y + rect.h);
});

test("an explicit size below the floor is raised to MIN_FONT", () => {
  const w = metric({ style: { value: { size: 1 } } });
  const value = fieldLayout(w, tile(6, 3)).find((f) => f.key === "value");
  assert.equal(value.size, MIN_FONT);
});

test("empty optional fields still get a box, so they remain clickable", () => {
  const fields = fieldLayout(metric({ delta: "" }), tile(6, 3));
  const delta = fields.find((f) => f.key === "delta");
  assert.ok(delta, "delta box exists even when empty");
  assert.equal(delta.text, "");
  assert.ok(delta.h > 0);
});

test("alignment resolves to the right anchor x", () => {
  const rect = tile(6, 3);
  const left = fieldLayout(metric(), rect).find((f) => f.key === "value");
  assert.equal(anchorX(left), left.x);

  const centred = fieldLayout(metric({ style: { value: { align: "center" } } }), rect)
    .find((f) => f.key === "value");
  assert.equal(anchorX(centred), centred.x + centred.w / 2);

  const right = fieldLayout(metric({ style: { value: { align: "right" } } }), rect)
    .find((f) => f.key === "value");
  assert.equal(anchorX(right), right.x + right.w);
});

test("list items report how many lines actually fit", () => {
  const tall = fieldLayout({ id: "l", type: "list", title: "T", items: ["a", "b", "c", "d", "e", "f"] }, tile(6, 6))
    .find((f) => f.key === "items");
  const short = fieldLayout({ id: "l", type: "list", title: "T", items: ["a", "b", "c", "d", "e", "f"] }, tile(6, 1))
    .find((f) => f.key === "items");
  assert.ok(tall.maxLines > short.maxLines, "a taller tile fits more lines");
  assert.ok(short.maxLines >= 1, "at least one line always fits");
  assert.ok(tall.maxLines * tall.lineHeight <= tall.h + tall.lineHeight);
});

test("fieldAt maps a point to the field under it", () => {
  const rect = tile(6, 3);
  const fields = fieldLayout(metric(), rect);
  for (const f of fields) {
    const hit = fieldAt(metric(), rect, { x: f.x + 2, y: f.y + 2 });
    assert.equal(hit?.key, f.key);
  }
  assert.equal(fieldAt(metric(), rect, { x: rect.x - 50, y: rect.y - 50 }), null);
});

test("migrateWidgetStyle folds a text widget's legacy size/align into style.text", () => {
  const migrated = migrateWidgetStyle({
    id: "t",
    type: "text",
    text: "HI",
    size: 40,
    align: "center",
  });
  assert.deepEqual(migrated.style.text, { size: 40, align: "center" });
  assert.equal(migrated.size, undefined, "legacy field removed");
  assert.equal(migrated.align, undefined, "legacy field removed");
  assert.equal(migrated.text, "HI", "content preserved");
});

test("migrateWidgetStyle leaves non-text widgets and already-migrated ones alone", () => {
  const m = metric();
  assert.equal(migrateWidgetStyle(m), m, "metric untouched");

  const already = { id: "t", type: "text", text: "HI", style: { text: { size: 12 } } };
  assert.equal(migrateWidgetStyle(already), already, "no legacy fields, no change");
});

test("migrateWidgetStyle does not let a legacy value clobber an explicit style", () => {
  const migrated = migrateWidgetStyle({
    id: "t",
    type: "text",
    text: "HI",
    size: 40,
    style: { text: { size: 12 } },
  });
  assert.equal(migrated.style.text.size, 12, "explicit style wins");
});
