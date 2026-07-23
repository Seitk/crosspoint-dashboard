// Pure: coerce a data-script's return value into display-field updates for a
// widget type. Framework-free so `node --test` can exercise it directly.
//
// Conventions per widget type:
//   metric: string/number -> value; or { value, delta, label }
//   list:   array -> items; or { title, items }
//   text:   string/number -> text

/**
 * @param {"metric"|"list"|"text"} type
 * @param {unknown} result
 * @returns {Record<string, unknown>} partial field updates for the widget
 */
export function coerceResult(type, result) {
  if (type === "metric") {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const out = {};
      if (result.value != null) out.value = String(result.value);
      if (result.delta != null) out.delta = String(result.delta);
      if (result.label != null) out.label = String(result.label);
      return out;
    }
    return { value: String(result) };
  }

  if (type === "list") {
    if (Array.isArray(result)) return { items: result.map(String) };
    if (result && typeof result === "object") {
      const out = {};
      if (result.title != null) out.title = String(result.title);
      if (Array.isArray(result.items)) out.items = result.items.map(String);
      return out;
    }
    return {};
  }

  if (type === "text") {
    return { text: String(result) };
  }

  return {};
}

// Async-function constructor — runs a script body with `fetch` in scope. Both
// browsers and node provide async functions, so this stays testable off-browser.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * Run a widget data-script (the body of an async function) with an injected
 * fetch. Returns whatever the script returns; rejects if the script throws.
 * @param {string} script
 * @param {(url: any, init?: any) => Promise<any>} fetchImpl
 * @returns {Promise<unknown>}
 */
export async function runScript(script, fetchImpl) {
  const fn = new AsyncFunction("fetch", script);
  return fn(fetchImpl);
}

/**
 * Merge a script's result into a widget's display fields (non-destructive: id,
 * geometry, and untouched fields are preserved).
 * @param {{ type: "metric"|"list"|"text" }} widget
 * @param {unknown} result
 */
export function applyScriptResult(widget, result) {
  return { ...widget, ...coerceResult(widget.type, result) };
}
