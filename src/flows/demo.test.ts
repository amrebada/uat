/// <reference types="node" />
/** Runs the flow demo against a stand-in for the demo's gateway, answering
 *  as `src-tauri/src/demo.sh` does. With UAT_DEMO_PORT set (the demo running
 *  in the app, on that port), runs it against the real gateway too. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFlow, type Cell, type Deps, type Sent } from "./engine";
import { demoFlow, DEMO_FLOW_ID } from "./demo";

const RIDES = {
  rider: { id: "7", name: "Salma", rating: 4.9 },
  rides: [
    { id: "r-104", from: "Ain Diab", to: "Maarif", status: "done" },
    { id: "r-105", from: "Gauthier", to: "Anfa", status: "open" },
  ],
};

function gateway(): Promise<Server> {
  const server = createServer((req, res) => {
    const reply = (status: number, statusText: string, body: unknown) => {
      res.writeHead(status, statusText, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify(body));
    };
    const route = `${req.method} ${req.url}`;
    if (route === "GET /rides") return reply(200, "OK", RIDES);
    if (route === "POST /rides") return reply(502, "Bad Gateway", { error: "orders could not book the ride" });
    if (route === "GET /users/7") return reply(200, "OK", { id: "7", name: "Salma", rating: 4.9 });
    reply(404, "Not Found", { error: "no such route" });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

function deps() {
  const sent: Sent[] = [];
  const sheets: { path: string; columns: string[]; rows: Cell[][] }[] = [];
  const d: Deps = {
    send: async (_id, req, signal) => {
      sent.push(req);
      const t0 = Date.now();
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal });
      const body = await res.text();
      return { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body, ms: Date.now() - t0 };
    },
    writeSheet: async (sheet) => {
      sheets.push(sheet);
      return sheet.path;
    },
  };
  return { d, sent, sheets };
}

async function checkDemo(port: number) {
  const { d, sent, sheets } = deps();
  const flow = demoFlow(port);
  const run = await runFlow(flow, d);
  const step = (id: string) => run.steps[`${DEMO_FLOW_ID}-${id}`];

  expect(flow.steps.map((s) => run.steps[s.id].status)).toEqual(["ok", "ok", "ok", "failed", "skipped"]);
  expect(run.status).toBe("failed");
  expect(run.failed).toBe(`${DEMO_FLOW_ID}-book`);

  expect(step("list").kept?.map((k) => k.name)).toEqual(["rides", "rider"]);
  expect(step("open").lines).toEqual(["1 of 2 rides are open"]);
  expect(step("open").kept).toEqual([{ name: "open", value: [RIDES.rides[1]] }]);

  expect(sheets).toEqual([
    {
      path: "~/Documents/UAT/rides-Salma.xlsx",
      columns: ["Ride", "From", "To", "Status"],
      rows: [
        ["r-104", "Ain Diab", "Maarif", "done"],
        ["r-105", "Gauthier", "Anfa", "open"],
      ],
    },
  ]);

  const book = sent.find((s) => s.method === "POST")!;
  expect(JSON.parse(book.body!)).toEqual({ rider: "7", from: "Gauthier", to: "Anfa" });
  expect(step("book")).toMatchObject({ status: "failed", error: "Answered 502 Bad Gateway" });
  expect(JSON.parse(step("book").answer!.body)).toEqual({ error: "orders could not book the ride" });
  // Nothing after the failure went out
  expect(sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(["GET /rides", "POST /rides"]);
}

describe("flow demo", () => {
  let server: Server;
  beforeAll(async () => {
    server = await gateway();
  });
  afterAll(() => server.close());

  it("lists, picks, writes the sheet, then fails booking and skips the rest", async () => {
    await checkDemo((server.address() as AddressInfo).port);
  });
});

const live = Number(process.env.UAT_DEMO_PORT);

describe.runIf(live)("flow demo against the running demo", () => {
  it("fails at booking, as payments isn't on the network", async () => {
    await checkDemo(live);
  });
});
