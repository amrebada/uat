import { describe, expect, it } from "vitest";
import { kv } from "../collections/model";
import type { TraceState } from "../trace/api";
import { runFlow, type Deps } from "./engine";
import { demoFlow, DEMO_FLOW_ID } from "./demo";
import type { Flow, RequestStep } from "./model";
import { report, reportFile } from "./report";

type Canned = { status: number; statusText: string; body: unknown; headers?: [string, string][] };

const RIDES = {
  rider: { id: "7", name: "Salma" },
  rides: [
    { id: "r-104", from: "Ain Diab", to: "Maarif", status: "done" },
    { id: "r-105", from: "Gauthier", to: "Anfa", status: "open" },
  ],
};

const DEMO: Record<string, Canned> = {
  "GET /rides": { status: 200, statusText: "OK", body: RIDES },
  "POST /rides": { status: 502, statusText: "Bad Gateway", body: { error: "orders could not book the ride" } },
};

function deps(answers: Record<string, Canned>): Deps {
  return {
    send: async (_id, req) => {
      const a = answers[`${req.method} ${new URL(req.url).pathname}`] ?? { status: 404, statusText: "Not Found", body: {} };
      return {
        status: a.status,
        statusText: a.statusText,
        headers: a.headers ?? [["content-type", "application/json"]],
        body: typeof a.body === "string" ? a.body : JSON.stringify(a.body),
        ms: 12,
      };
    },
    writeSheet: async (s) => s.path.replace(/^~/, "/Users/you"),
  };
}

const demoRun = (answers = DEMO, flow: Flow = demoFlow(8480)) => runFlow(flow, deps(answers));

describe("flow report", () => {
  it("summarises the run, then has each step in full", async () => {
    const html = report(await demoRun(), "html");

    expect(html).toContain("<title>Book an open ride · Flow report</title>");
    expect(html).toContain("Failed at step 4, Book the open ride");
    expect(html).toContain("3 passed · 1 failed · 1 skipped");
    // The summary's rows, in order
    expect([...html.matchAll(/<tr data-status="(\w+)">/g)].map((m) => m[1])).toEqual(["ok", "ok", "ok", "failed", "skipped"]);
    expect(html).toContain("200 OK · kept rides, rider");
    expect(html).toContain("returned open (list of 1) · 1 line logged");
    expect(html).toContain("2 rows to rides-Salma.xlsx");
    // The details
    expect(html).toContain('<article class="step" id="step-4" data-status="failed">');
    expect(html).toContain('<p class="error">Answered 502 Bad Gateway</p>');
    expect(html).toContain("orders could not book the ride");
    expect(html).toContain("1 of 2 rides are open");
    expect(html).toContain("const open = _.filter(rides, { status: &quot;open&quot; });");
    expect(html).toContain("/Users/you/Documents/UAT/rides-Salma.xlsx");
    expect(html).toContain("<td>r-105</td><td>Gauthier</td><td>Anfa</td><td>open</td>");
    expect(html).toContain("Book the open ride failed before this step.");
  });

  it("escapes what services send", async () => {
    const answers = { ...DEMO, "GET /rides": { status: 200, statusText: "OK", body: { ...RIDES, note: "<script>alert(1)</script>" } } };
    const html = report(await demoRun(answers), "html");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("hides secrets wherever they turn up, unless asked to show them", async () => {
    const flow = demoFlow(8480);
    flow.vars.push(kv("token", "s3cr3t-token-value"));
    const list = flow.steps[0] as RequestStep;
    list.url = "{{base}}/rides?key={{token}}";
    list.headers = [kv("Authorization", "Bearer {{token}}")];
    const answers = {
      ...DEMO,
      "GET /rides": {
        status: 200,
        statusText: "OK",
        body: { ...RIDES, echo: "s3cr3t-token-value" },
        headers: [["set-cookie", "sid=abcdef123456; Path=/; HttpOnly"]] as [string, string][],
      },
    };
    const run = await demoRun(answers, flow);

    for (const format of ["html", "md"] as const) {
      const hidden = report(run, format);
      expect(hidden).not.toContain("s3cr3t-token-value");
      expect(hidden).not.toContain("abcdef123456");
      expect(hidden).toContain("/rides?key=••••••");
      expect(hidden).toContain("Values that look secret are hidden");

      const shown = report(run, format, { secrets: true });
      expect(shown).toContain("Bearer s3cr3t-token-value");
      expect(shown).toContain("sid=abcdef123456");
      expect(shown).not.toContain("Values that look secret are hidden");
    }
  });

  it("writes the same in Markdown", async () => {
    const answers = { ...DEMO, "POST /rides": { ...DEMO["POST /rides"], body: "no ```payments``` here" } };
    const md = report(await demoRun(answers), "md");
    expect(md).toMatch(/^# Book an open ride\n\n\*\*Failed at step 4, Book the open ride\*\* · started .+ · 3 passed · 1 failed · 1 skipped\n/);
    expect(md).toContain("| # | Step | Type | Status | Time | Result |");
    expect(md).toContain("| 4 | Book the open ride | API call | Failed | ");
    expect(md).toContain("| Answered 502 Bad Gateway |");
    expect(md).toContain("| 5 | Get the rider | API call | Skipped |  | Skipped |");
    expect(md).toContain("### 3. Rides sheet — Passed");
    expect(md).toContain("| r-105 | Gauthier | Anfa | open |");
    // A body with a fence in it gets a longer one
    expect(md).toContain("````\nno ```payments``` here\n````");
  });

  it("has the calls each request led to", async () => {
    const run = await demoRun();
    const at = run.at;
    const traced: TraceState = {
      status: "ready",
      origin: { label: "POST /rides", outcome: "502 Bad Gateway", ok: true, at, end: at + 20 },
      entry: { network: "uat-demo", service: "gateway", kind: "container", watching: true },
      trace: {
        network: "uat-demo",
        entry: "gateway",
        from: at,
        to: at + 700,
        nodes: [],
        hops: [
          { from: "gateway", to: "orders", kind: "service", port: 8080, state: "ok", error: null, at, count: 1, failed: 0, requests: [{ at, method: "POST", path: "/orders", status: 502, error: null, ms: 9 }] },
          { from: "orders", to: "payments", kind: "service", port: null, state: "unresolved", error: "Not found on uat-demo", at, count: 1, failed: 1, requests: [] },
        ],
      },
      logs: [{ service: "orders", lines: [{ at, stream: "err", text: "payments: bad address" }] }],
    };
    const trace = (id: string) => (id === `${DEMO_FLOW_ID}-book` ? traced : { status: "none" as const });
    const html = report(run, "html", { trace });

    expect(html).toContain('Calls it led to <span class="aside">reached gateway on uat-demo</span>');
    expect(html).toContain("<td>orders:8080</td><td>connected<div class=\"mono\">POST /orders → 502 · 9 ms</div></td>");
    expect(html).toContain('<tr data-ok="false"><td>orders</td><td class="arrow">→</td><td>payments</td><td>Not found on uat-demo</td></tr>');
    expect(html).toContain("orders log (1 line)");
    expect(html).toContain("payments: bad address");
    // Untraced calls say nothing about it
    expect(html.match(/Calls it led to/g)).toHaveLength(1);
  });

  it("names the file after the flow and when it ran", async () => {
    const run = await demoRun();
    const at = new Date(2026, 10, 1, 17, 39, 12).getTime();
    expect(reportFile({ ...run, at }, "html")).toBe("Book an open ride 2026-11-01 17-39.html");
    expect(reportFile({ ...run, at, flow: { ...run.flow, name: "a/b: c" } }, "md")).toBe("a-b- c 2026-11-01 17-39.md");
  });
});
