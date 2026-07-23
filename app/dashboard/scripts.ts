// Browser-side runner for per-widget data scripts. A script is the body of an
// async function that receives a proxied `fetch` and returns what to display.
//
// The framework-free implementations (runScript, applyScriptResult, coerceResult)
// live in scripts-core.js so they're unit-testable in node; this module adds the
// browser-only proxied fetch and thin typed wrappers.

import type { Widget } from "./types";
import {
  applyScriptResult as applyScriptResultCore,
  runScript as runScriptCore,
} from "./scripts-core.js";

/**
 * The fetch() handed to scripts. Routes through the server proxy (/api/proxy) so
 * scripts can hit APIs that block browser CORS. Behaves like a normal fetch:
 * returns the upstream Response (status + body), so `await res.json()` works.
 */
export async function proxiedFetch(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = init.headers
    ? Object.fromEntries(new Headers(init.headers))
    : ({} as Record<string, string>);
  let body: string | undefined;
  if (init.body != null) body = typeof init.body === "string" ? init.body : String(init.body);

  return fetch("/api/proxy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: typeof url === "string" ? url : url.toString(),
      method: init.method ?? "GET",
      headers,
      body,
    }),
  });
}

/** Run a widget's data script; defaults to the CORS-proxying fetch. */
export function runScript(
  script: string,
  fetchImpl: typeof proxiedFetch = proxiedFetch,
): Promise<unknown> {
  return runScriptCore(script, fetchImpl);
}

/** Merge a script result into a widget's display fields. */
export function applyScriptResult(widget: Widget, result: unknown): Widget {
  return applyScriptResultCore(widget, result) as Widget;
}
