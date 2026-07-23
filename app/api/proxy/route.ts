export const dynamic = "force-dynamic";

// Server-side forward proxy so dashboard data-scripts can fetch APIs that block
// browser CORS. The script's fetch() posts a JSON envelope here; we fetch the
// target from the worker (no CORS) and pass the response straight back.
//
// NOTE: this is an OPEN forward proxy — fine for a personal, local dev tool.
// Do not deploy this app publicly without restricting allowed targets.

type ProxyEnvelope = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export async function POST(request: Request): Promise<Response> {
  let envelope: ProxyEnvelope;
  try {
    envelope = (await request.json()) as ProxyEnvelope;
  } catch {
    return Response.json({ error: "invalid JSON envelope" }, { status: 400 });
  }

  const { url, method = "GET", headers = {}, body } = envelope;
  if (!url) return Response.json({ error: "missing url" }, { status: 400 });

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Response.json({ error: "invalid url" }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Response.json({ error: "only http/https URLs are allowed" }, { status: 400 });
  }

  const upstreamMethod = method.toUpperCase();
  const sendsBody = upstreamMethod !== "GET" && upstreamMethod !== "HEAD";

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: upstreamMethod,
      headers,
      body: sendsBody ? body : undefined,
    });
  } catch (err) {
    return Response.json(
      { error: `upstream fetch failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 },
    );
  }

  // Buffer the (small, API-sized) response and pass status + content-type back.
  const buf = await upstream.arrayBuffer();
  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  return new Response(buf, { status: upstream.status, headers: responseHeaders });
}
