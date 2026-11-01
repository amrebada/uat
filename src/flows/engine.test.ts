import { describe, expect, it } from "vitest";
import { kv } from "../collections/model";
import { get, render, runFlow, type Answer, type Deps, type Sent } from "./engine";
import { newStep, type Flow, type RequestStep, type SheetStep, type TransformStep } from "./model";

const rides = [
  { id: "r-1", from: "Maarif", to: "Anfa", status: "open", fare: 42 },
  { id: "r-2", from: "Gauthier", to: "Ain Diab", status: "done", fare: 30 },
];

describe("paths", () => {
  const root = { body: { rides, "x-y": 1 }, headers: { "content-type": "application/json" } };

  it("reads names, indexes, wildcards and quoted names", () => {
    expect(get(root, "body.rides[0].from")).toBe("Maarif");
    expect(get(root, "body.rides[-1].id")).toBe("r-2");
    expect(get(root, "body.rides[*].id")).toEqual(["r-1", "r-2"]);
    expect(get(root, 'headers["content-type"]')).toBe("application/json");
    expect(get(root, "body['x-y']")).toBe(1);
    expect(get(root, "body.rides.length")).toBe(2);
    expect(get(root, "")).toBe(root);
  });

  it("says what isn't there", () => {
    expect(() => get(root, "body.rides[5].id")).toThrow("body.rides[5] isn't there: body.rides has 2 items");
    expect(() => get(root, "body.ride")).toThrow("body.ride isn't there");
    expect(() => get(root, "rider")).toThrow("Nothing is kept as rider yet");
    expect(() => get(root, "body[0]")).toThrow("body isn't a list");
  });

  it("fills templates: text as it is, the rest as JSON", () => {
    const vars = { base: "http://localhost:8480", ride: rides[0], n: 2 };
    expect(render("{{base}}/rides/{{ ride.id }}?n={{n}}", vars)).toBe("http://localhost:8480/rides/r-1?n=2");
    expect(render('{"ride": {{ride}}}', vars)).toBe(`{"ride": ${JSON.stringify(rides[0])}}`);
    expect(() => render("{{rider.name}}", vars)).toThrow("Couldn't fill in {{rider.name}}: Nothing is kept as rider yet");
  });
});

/** Answers from a table of `METHOD url` → [status, body] */
function fake(routes: Record<string, [number, unknown]>) {
  const sent: Sent[] = [];
  const written: { path: string; columns: string[]; rows: unknown[][] }[] = [];
  const deps: Deps = {
    send: async (_id, req) => {
      sent.push(req);
      const hit = routes[`${req.method} ${req.url}`];
      if (!hit) throw new Error(`Connection refused: ${req.url}`);
      const [status, body] = hit;
      const answer: Answer = {
        status,
        statusText: status === 200 ? "OK" : status === 502 ? "Bad Gateway" : "",
        headers: [["Content-Type", "application/json"]],
        body: JSON.stringify(body),
        ms: 3,
      };
      return answer;
    },
    writeSheet: async (sheet) => {
      written.push(sheet);
      return sheet.path.replace("~", "/Users/me");
    },
  };
  return { deps, sent, written };
}

function flow(steps: Flow["steps"]): Flow {
  return { id: "f", name: "Test", vars: [kv("base", "http://api")], steps };
}

const call = (name: string, patch: Partial<RequestStep>): RequestStep => ({
  ...(newStep("request") as RequestStep),
  name,
  ...patch,
});

describe("runFlow", () => {
  it("passes what one step keeps to the next", async () => {
    const { deps, sent, written } = fake({
      "GET http://api/rides": [200, { rides }],
      "POST http://api/bookings": [200, { id: "b-9" }],
    });
    const list = call("List", { url: "{{base}}/rides", keep: [kv("rides", "body.rides"), kv("code", "status")] });
    const open: TransformStep = {
      ...(newStep("transform") as TransformStep),
      as: "open",
      code: 'const open = rides.filter((r) => r.status === "open");\nlog(`${open.length} open`, { of: rides.length });\nreturn open;',
    };
    const book = call("Book", {
      method: "POST",
      url: "{{base}}/bookings",
      bodyType: "json",
      body: '{ "ride": "{{open[0].id}}", "route": {{open[*].to}} }',
      keep: [kv("booking", "body.id")],
    });
    const sheet: SheetStep = {
      ...(newStep("sheet") as SheetStep),
      from: "rides",
      columns: [kv("Ride", "id"), kv("To", "to"), kv("Driver", "driver.name")],
      file: "~/Documents/UAT/{{booking}}.xlsx",
    };
    const changes: string[] = [];
    const run = await runFlow(flow([list, open, book, sheet]), deps, (r) => changes.push(r.status));

    expect(run.status).toBe("ok");
    expect(Object.values(run.steps).map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(run.vars.code).toBe(200);
    expect(run.steps[open.id].lines).toEqual(['1 open {"of":2}']);
    expect(run.steps[open.id].kept).toEqual([{ name: "open", value: [rides[0]] }]);
    expect(sent[1].body).toBe('{ "ride": "r-1", "route": ["Anfa"] }');
    expect(sent[1].headers).toEqual([["Content-Type", "application/json"]]);
    expect(written[0]).toEqual({
      path: "~/Documents/UAT/b-9.xlsx",
      columns: ["Ride", "To", "Driver"],
      rows: [
        ["r-1", "Anfa", null],
        ["r-2", "Ain Diab", null],
      ],
    });
    expect(run.steps[sheet.id].sheet?.path).toBe("/Users/me/Documents/UAT/b-9.xlsx");
    expect(changes.at(-1)).toBe("ok");
    // The transform worked on copies
    expect(rides).toHaveLength(2);
  });

  it("stops at the step that fails and skips the rest", async () => {
    const { deps, sent } = fake({ "POST http://api/rides": [502, { error: "payments is unreachable" }] });
    const steps = [
      call("Book", { method: "POST", url: "{{base}}/rides", bodyType: "json", body: "{}" }),
      call("Then", { url: "{{base}}/after" }),
    ];
    const run = await runFlow(flow(steps), deps);
    expect(run.status).toBe("failed");
    expect(run.failed).toBe(steps[0].id);
    expect(run.steps[steps[0].id]).toMatchObject({ status: "failed", error: "Answered 502 Bad Gateway" });
    expect(run.steps[steps[0].id].answer?.status).toBe(502);
    expect(run.steps[steps[1].id].status).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  it("fails a step on a value that isn't there, a refused call, bad JSON or bad code", async () => {
    const { deps } = fake({ "GET http://api/rides": [200, { rides }] });
    const cases: [Flow["steps"][number], string][] = [
      [call("Keep", { url: "{{base}}/rides", keep: [kv("x", "body.ridez")] }), "Couldn't keep x: body.ridez isn't there"],
      [call("Down", { url: "{{base}}/down" }), "Connection refused: http://api/down"],
      [call("Fill", { url: "{{base}}/{{ride.id}}" }), "Couldn't fill in {{ride.id}}: Nothing is kept as ride yet"],
      [
        call("Body", { method: "POST", url: "{{base}}/rides", bodyType: "json", body: "{ nope }" }),
        "The body isn't JSON once filled in",
      ],
      [{ ...(newStep("transform") as TransformStep), code: "return (" }, "The code doesn't parse"],
      [{ ...(newStep("transform") as TransformStep), code: "return base.nope.x" }, "Cannot read properties of undefined"],
      [{ ...(newStep("sheet") as SheetStep), from: "base" }, "base isn't a list"],
    ];
    for (const [step, error] of cases) {
      const run = await runFlow(flow([step]), deps);
      expect(run.steps[step.id].status, error).toBe("failed");
      expect(run.steps[step.id].error).toContain(error);
    }
  });

  it("gives transforms lodash as _", async () => {
    const { deps } = fake({});
    const seed: TransformStep = { ...(newStep("transform") as TransformStep), as: "rides", code: `return ${JSON.stringify(rides)};` };
    const group: TransformStep = {
      ...(newStep("transform") as TransformStep),
      as: "byStatus",
      code: 'return _.mapValues(_.groupBy(rides, "status"), (rs) => _.map(rs, "id"));',
    };
    const run = await runFlow(flow([seed, group]), deps);
    expect(run.vars.byStatus).toEqual({ open: ["r-1"], done: ["r-2"] });
  });

  it("lets a call answer anything when it doesn't expect 2xx", async () => {
    const { deps } = fake({ "GET http://api/missing": [404, { error: "no" }] });
    const step = call("Probe", { url: "{{base}}/missing", expectOk: false, keep: [kv("code", "status")] });
    const run = await runFlow(flow([step]), deps);
    expect(run.status).toBe("ok");
    expect(run.vars.code).toBe(404);
  });

  it("takes every field when a sheet names no columns", async () => {
    const { deps, written } = fake({});
    const seed: TransformStep = { ...(newStep("transform") as TransformStep), as: "rides", code: `return ${JSON.stringify(rides)};` };
    const sheet: SheetStep = { ...(newStep("sheet") as SheetStep), from: "rides", file: "out.csv" };
    const run = await runFlow(flow([seed, sheet]), deps);
    expect(run.status).toBe("ok");
    expect(written[0].columns).toEqual(["id", "from", "to", "status", "fare"]);
    expect(written[0].rows[0]).toEqual(["r-1", "Maarif", "Anfa", "open", 42]);
  });

  it("stops when asked", async () => {
    const ctrl = new AbortController();
    const deps: Deps = {
      send: (_id, _req, signal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
      writeSheet: async (s) => s.path,
    };
    const steps = [call("Slow", { url: "{{base}}/slow" }), call("Next", { url: "{{base}}/next" })];
    const running = runFlow(flow(steps), deps, undefined, ctrl.signal);
    setTimeout(() => ctrl.abort(), 10);
    const run = await running;
    expect(run.status).toBe("stopped");
    expect(run.steps[steps[0].id]).toMatchObject({ status: "failed", error: "Stopped" });
    expect(run.steps[steps[1].id].status).toBe("skipped");
  });
});

