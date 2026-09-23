/** Route-matching fetch stub for contract tests against recorded fixtures. */
export type StubRequest = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export type StubRoute = {
  match: (url: URL, req: StubRequest) => boolean;
  respond: (req: StubRequest) => Response | Promise<Response>;
};

export type SeenRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export function stubFetch(routes: StubRoute[]) {
  const seen: SeenRequest[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const text = request.body ? await request.text() : "";
    let body: unknown = text || undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // keep text
    }
    const req: StubRequest = {
      url: new URL(request.url),
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    };
    seen.push({ url: request.url, method: req.method, headers: req.headers, body });
    const route = routes.find((r) => r.match(req.url, req));
    if (!route) return new Response("not found", { status: 404 });
    return route.respond(req);
  };
  return { fetch, seen };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const noContent = () => new Response(null, { status: 204 });
