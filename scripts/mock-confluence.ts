/**
 * A small fake Confluence Data Center (REST API) for local work without a real
 * instance: team pages and runbooks in storage format.
 *
 *   bun run mock:confluence            # http://localhost:8090
 *   bun run mock:confluence --port 9001
 *
 * In Settings > Confluence use base URL http://localhost:8090 and any token.
 * CQL support is minimal: `title ~ "x"`, `text ~ "x"` and `space = "KEY"` are
 * honoured; anything else matches every page.
 */

type Page = {
  id: string;
  space: { key: string; name: string };
  title: string;
  version: number;
  when: string;
  storage: string;
};

export const PAGES: Page[] = [
  {
    id: "65601",
    space: { key: "PAY", name: "Payments" },
    title: "Payments platform team",
    version: 7,
    when: "2026-09-01T10:00:00.000+01:00",
    storage: `<h2>What we own</h2><ul><li>Invoicing</li><li>Ledger exports</li><li>Refunds</li></ul>
<ac:structured-macro ac:name="info" ac:schema-version="1"><ac:rich-text-body><p>Contact us in <strong>#payments-help</strong> on Teams. Response within one working day.</p></ac:rich-text-body></ac:structured-macro>
<h2>People</h2><table><tbody><tr><th>Name</th><th>Role</th></tr><tr><td>Ana Bell</td><td>Tech lead</td></tr><tr><td>Priya Shah</td><td>Engineer</td></tr></tbody></table>
<h2>Escalation</h2><p>Page the on-call via <ac:link><ri:page ri:content-title="Payments escalation runbook" /></ac:link>.</p>`,
  },
  {
    id: "65602",
    space: { key: "PAY", name: "Payments" },
    title: "Payments escalation runbook",
    version: 3,
    when: "2026-08-12T09:30:00.000+01:00",
    storage: `<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Only escalate after the first response SLA has passed.</p></ac:rich-text-body></ac:structured-macro>
<ol><li>Post in <strong>#payments-help</strong> with the incident number.</li><li>If no answer in 4 hours, page the on-call.</li><li>After 1 day, email the tech lead.</li></ol>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[pagerctl page payments-oncall --reason "INC0012345 ledger export blocked"]]></ac:plain-text-body></ac:structured-macro>
<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Rota published</ac:task-body></ac:task></ac:task-list>`,
  },
  {
    id: "65701",
    space: { key: "PLAT", name: "Platform" },
    title: "Platform team: how to engage us",
    version: 12,
    when: "2026-09-15T14:00:00.000+01:00",
    storage: `<p>The platform team runs shared infrastructure: Kubernetes, CI, secrets and the API gateway.</p>
<h3>Requests</h3><p>Raise a ServiceNow request in the <em>Platform</em> queue. Urgent issues: incident with priority P2 or higher.</p>
<ac:structured-macro ac:name="note"><ac:rich-text-body><p>We prefer <strong>short, structured</strong> requests with the service name and environment.</p></ac:rich-text-body></ac:structured-macro>
<p>Status: <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">ACTIVE</ac:parameter></ac:structured-macro></p>`,
  },
  {
    id: "65801",
    space: { key: "NET", name: "Network" },
    title: "Network team firewall change process",
    version: 5,
    when: "2026-07-20T11:00:00.000+01:00",
    storage: `<p>Firewall changes go through CAB every Thursday.</p><ul><li>Submit by Tuesday 17:00</li><li>Include source, destination, port and justification</li></ul>
<p>Contact: <ac:link><ri:user ri:userkey="8a8b8c8d0003" /></ac:link> (Tom Kay).</p>`,
  },
];

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8090;

const summary = (p: Page, base: string) => ({
  id: p.id,
  type: "page",
  status: "current",
  title: p.title,
  space: { key: p.space.key, name: p.space.name, type: "global" },
  version: {
    number: p.version,
    when: p.when,
    by: { type: "known", username: "ana.b", displayName: "Ana Bell" },
  },
  _links: {
    webui: `/display/${p.space.key}/${encodeURIComponent(p.title).replace(/%20/g, "+")}`,
    base,
    self: `${base}/rest/api/content/${p.id}`,
  },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const plain = (storage: string) =>
  storage
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .toLowerCase();

export function createHandler(pages: Page[] = PAGES) {
  return (req: Request): Response => {
    const url = new URL(req.url);
    const base = url.origin;
    if (!req.headers.get("authorization")?.startsWith("Bearer "))
      return new Response("", { status: 401 });
    if (url.pathname === "/rest/api/user/current")
      return json({
        type: "known",
        username: "me",
        userKey: "8a8b8c8d0001",
        displayName: "Me Myself",
      });
    if (url.pathname === "/rest/api/content/search") {
      const cql = url.searchParams.get("cql") ?? "";
      const terms = [...cql.matchAll(/(?:title|text) ~ "((?:[^"\\]|\\.)*)"/g)].map((m) =>
        (m[1] ?? "").replace(/\\(.)/g, "$1").toLowerCase(),
      );
      const space = /space = "([^"]+)"/.exec(cql)?.[1];
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const found = pages.filter(
        (p) =>
          (!space || p.space.key === space) &&
          (terms.length === 0 ||
            terms.some((t) =>
              t
                .split(/\s+/)
                .every((w) => `${p.title.toLowerCase()} ${plain(p.storage)}`.includes(w)),
            )),
      );
      const results = found.slice(0, limit).map((p) => summary(p, base));
      return json({
        results,
        start: 0,
        limit,
        size: results.length,
        _links: { base, context: "" },
      });
    }
    const m = /^\/rest\/api\/content\/(\d+)$/.exec(url.pathname);
    if (m) {
      const p = pages.find((x) => x.id === m[1]);
      if (!p) return json({ statusCode: 404, message: "No content found with id: " + m[1] }, 404);
      return json({
        ...summary(p, base),
        ancestors: [],
        body: { storage: { value: p.storage, representation: "storage" } },
      });
    }
    return json(
      { statusCode: 404, message: `Mock does not implement ${req.method} ${url.pathname}` },
      404,
    );
  };
}

if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: createHandler() });
  console.log(`Mock Confluence DC on http://localhost:${PORT} with ${PAGES.length} pages`);
}
