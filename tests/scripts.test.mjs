import assert from "node:assert/strict";
import test from "node:test";

import {
  applyScriptResult,
  coerceResult,
  runScript,
} from "../app/dashboard/scripts-core.js";
import { gridToPixels, validate } from "../skills/crosspoint-dashboard/scripts/layout.mjs";

test("metric: scalar becomes value", () => {
  assert.deepEqual(coerceResult("metric", "229.35"), { value: "229.35" });
  assert.deepEqual(coerceResult("metric", 42), { value: "42" });
});

test("metric: object maps value/delta/label, stringified", () => {
  assert.deepEqual(coerceResult("metric", { value: 1, delta: "+2%", label: "AAPL" }), {
    value: "1",
    delta: "+2%",
    label: "AAPL",
  });
});

test("metric: object omits absent keys (no clobber)", () => {
  assert.deepEqual(coerceResult("metric", { value: 5 }), { value: "5" });
});

test("list: array becomes items", () => {
  assert.deepEqual(coerceResult("list", ["a", 1, true]), { items: ["a", "1", "true"] });
});

test("list: object maps title/items", () => {
  assert.deepEqual(coerceResult("list", { title: "TODO", items: ["x", "y"] }), {
    title: "TODO",
    items: ["x", "y"],
  });
});

test("text: scalar becomes text", () => {
  assert.deepEqual(coerceResult("text", 123), { text: "123" });
});

test("unknown shapes coerce safely (no throw)", () => {
  assert.deepEqual(coerceResult("list", "not-an-array"), {});
  assert.deepEqual(coerceResult("metric", null), { value: "null" });
});

// --- runScript: executing a widget's data script -------------------------------

test("runScript: returns the script's value", async () => {
  const noopFetch = async () => ({});
  assert.deepEqual(await runScript("return { value: '42' };", noopFetch), { value: "42" });
});

test("runScript: the script can use the injected fetch", async () => {
  const stubFetch = async (url) => ({ json: async () => ({ price: 229.35, url }) });
  const result = await runScript(
    "const j = await (await fetch('https://api/quote')).json(); return { value: '$' + j.price };",
    stubFetch,
  );
  assert.deepEqual(result, { value: "$229.35" });
});

test("runScript: fetch receives the url + init the script passes", async () => {
  const calls = [];
  const stubFetch = async (url, init) => {
    calls.push({ url, init });
    return { json: async () => ({ ok: true }) };
  };
  await runScript("await fetch('https://api/x', { method: 'POST' }); return 1;", stubFetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api/x");
  assert.equal(calls[0].init.method, "POST");
});

test("runScript: a throwing script rejects (so callers can show the error)", async () => {
  await assert.rejects(runScript("throw new Error('boom');", async () => {}), /boom/);
});

test("runScript: a fetch failure surfaces as a rejection", async () => {
  const failing = async () => {
    throw new Error("network down");
  };
  await assert.rejects(runScript("await fetch('u'); return 1;", failing), /network down/);
});

// --- applyScriptResult: merging a result into a widget -------------------------

test("applyScriptResult: metric keeps id/geometry/label, updates value+delta", () => {
  const widget = {
    id: "aapl",
    type: "metric",
    x: 16,
    y: 16,
    w: 372,
    h: 200,
    label: "AAPL",
    value: "-",
  };
  const out = applyScriptResult(widget, { value: 229.35, delta: "+1.2%" });
  assert.equal(out.id, "aapl");
  assert.equal(out.x, 16);
  assert.equal(out.h, 200);
  assert.equal(out.label, "AAPL"); // untouched
  assert.equal(out.value, "229.35"); // updated + stringified
  assert.equal(out.delta, "+1.2%");
});

test("applyScriptResult: list from an array, text from a scalar", () => {
  const list = applyScriptResult({ id: "l", type: "list", title: "TODO", items: [] }, ["a", "b"]);
  assert.deepEqual(list.items, ["a", "b"]);
  assert.equal(list.title, "TODO"); // preserved

  const text = applyScriptResult({ id: "t", type: "text", text: "" }, 12);
  assert.equal(text.text, "12");
});

test("applyScriptResult: does not mutate the input widget", () => {
  const widget = { id: "m", type: "metric", value: "-" };
  const out = applyScriptResult(widget, { value: 5 });
  assert.equal(widget.value, "-"); // original untouched
  assert.equal(out.value, "5");
  assert.notEqual(out, widget);
});

// --- end to end: build a widget that fetches its own data ----------------------

test("build a widget with a script: fetch -> coerce -> updated widget", async () => {
  const widget = {
    id: "todo",
    type: "list",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    title: "TODO",
    items: [],
    script: "const r = await fetch('u'); return (await r.json()).map((t) => t.title);",
  };
  const stubFetch = async () => ({ json: async () => [{ title: "ship" }, { title: "test" }] });

  const result = await runScript(widget.script, stubFetch);
  const updated = applyScriptResult(widget, result);

  assert.deepEqual(updated.items, ["ship", "test"]);
  assert.equal(updated.title, "TODO"); // preserved
  assert.equal(updated.id, "todo");
  assert.equal(updated.script, widget.script); // script kept for the next refresh
});

// --- building script-bearing widgets on the non-overlap grid -------------------

test("grid layout preserves scripts and keeps widgets non-overlapping", () => {
  const dash = gridToPixels({
    cols: 2,
    rows: 1,
    widgets: [
      { id: "a", type: "metric", label: "A", value: "-", script: "return {value:'1'};", col: 0, row: 0 },
      { id: "b", type: "list", title: "B", items: [], script: "return ['x'];", col: 1, row: 0 },
    ],
  });
  assert.ok(validate(dash.widgets).ok, "no overlaps / in bounds");
  const a = dash.widgets.find((w) => w.id === "a");
  const b = dash.widgets.find((w) => w.id === "b");
  assert.equal(a.script, "return {value:'1'};"); // script survived layout
  assert.equal(b.script, "return ['x'];");
  assert.equal(a.col, undefined); // grid fields stripped
  assert.ok(a.w > 0 && a.h > 0); // pixel rect assigned
});
