/** Route-matching fetch stub for contract tests against recorded fixtures. */
export type StubRoute = {
  match: (url: URL, init: RequestInit | undefined) => boolean;
  respond: () => Response | Promise<Response>;
};

export type SeenRequest = { url: string; method: string; headers: Record<string, string> };

export function stubFetch(routes: StubRoute[]) {
  const seen: SeenRequest[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    seen.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
    });
    const route = routes.find((r) => r.match(url, init));
    if (!route) return new Response("not found", { status: 404 });
    return route.respond();
  };
  return { fetch, seen };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
