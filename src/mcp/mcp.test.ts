import { describe, expect, it } from "vitest";
import { kv, type Group, type HttpItem, type TreeNode } from "../collections/model";
import type { Flow, RequestStep } from "../flows/model";
import { checkArgs, describe as describeTool, textOf, type Tool } from "./registry";
import type { NetworkPlan } from "../docker/api";
import {
  exportText,
  findFlow,
  findNode,
  findStep,
  flowOut,
  importedText,
  kvIn,
  kvOut,
  planText,
  questionsText,
  removedText,
  stepIn,
  treeText,
} from "./shapes";
import { draftOf, fileOf, fileText, questions } from "../docker/share";

const tool: Tool = {
  name: "save_request",
  title: "Save a request",
  description: "…",
  props: {
    url: { type: "string", description: "…" },
    headers: { type: ["object", "array"], description: "…" },
    body_type: { type: "string", enum: ["none", "json", "text"], description: "…" },
    wait: { type: "boolean", description: "…" },
  },
  required: ["url"],
  run: async () => "ok",
};

describe("registry", () => {
  it("describes a tool as MCP lists it", () => {
    const d = describeTool({ ...tool, destructive: true });
    expect(d.inputSchema).toMatchObject({ type: "object", required: ["url"], additionalProperties: false });
    expect(d.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(describeTool({ ...tool, read: true, destructive: true }).annotations.destructiveHint).toBe(false);
  });

  it("checks arguments and says what's wrong", () => {
    expect(checkArgs(tool, { url: "x", headers: { a: "1" }, wait: null })).toEqual({ url: "x", headers: { a: "1" } });
    expect(() => checkArgs(tool, {})).toThrow("url is required.");
    expect(() => checkArgs(tool, { url: "x", nope: 1 })).toThrow('has no argument "nope". It takes url, headers, body_type, wait.');
    expect(() => checkArgs(tool, { url: 3 })).toThrow("url should be string, not integer.");
    expect(() => checkArgs(tool, { url: "x", body_type: "xml" })).toThrow("body_type should be one of none, json, text.");
    expect(() => checkArgs(tool, [1])).toThrow("takes an object");
    expect(checkArgs({ ...tool, required: [] }, undefined)).toEqual({});
  });

  it("writes results as text", () => {
    expect(textOf("hi")).toBe("hi");
    expect(textOf(undefined)).toBe("Done.");
    expect(textOf({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("pairs", () => {
  it("takes an object or a list, and gives back an object when it can", () => {
    const list = kvIn({ Accept: "application/json", Retries: 3 }, "headers");
    expect(list.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ["Accept", "application/json", true],
      ["Retries", "3", true],
    ]);
    expect(kvOut(list)).toEqual({ Accept: "application/json", Retries: "3" });
    const off = kvIn([{ key: "X-Debug", value: "1", enabled: false }], "headers");
    expect(kvOut(off)).toEqual([{ key: "X-Debug", value: "1", enabled: false }]);
    expect(() => kvIn("a=1", "headers")).toThrow("headers should be an object");
  });
});

describe("steps", () => {
  it("makes a request step, working out the body's type", () => {
    const s = stepIn({ type: "request", name: "Book", method: "post", url: "{{base}}/rides", body: { from: "Maarif" }, keep: { id: "body.id" } }) as RequestStep;
    expect(s).toMatchObject({ method: "POST", bodyType: "json", expectOk: true, url: "{{base}}/rides" });
    expect(JSON.parse(s.body)).toEqual({ from: "Maarif" });
    expect(kvOut(s.keep)).toEqual({ id: "body.id" });
  });

  it("changes only what's given, and keeps the id", () => {
    const old = stepIn({ type: "request", url: "http://a", headers: { A: "1" } }) as RequestStep;
    const next = stepIn({ url: "http://b" }, old) as RequestStep;
    expect(next.id).toBe(old.id);
    expect(next.url).toBe("http://b");
    expect(kvOut(next.headers)).toEqual({ A: "1" });
  });

  it("says what a step doesn't take", () => {
    expect(() => stepIn({ type: "transform", url: "x" })).toThrow("A transform step has no url.");
    expect(() => stepIn({ type: "nope" })).toThrow("type should be one of request, transform, sheet");
    expect(() => stepIn({ type: "request", method: "FETCH" })).toThrow("method should be one of");
  });

  it("round-trips a flow", () => {
    const flow: Flow = {
      id: "f1",
      name: "Rides",
      vars: [kv("base", "http://localhost:3000")],
      steps: [stepIn({ type: "transform", name: "Count", as: "n", code: "return 1;" })],
    };
    const out = flowOut(flow);
    expect(out.inputs).toEqual({ base: "http://localhost:3000" });
    expect(stepIn(out.steps[0], flow.steps[0])).toEqual(flow.steps[0]);
  });
});

describe("finding", () => {
  const req = (id: string, name: string): HttpItem => ({
    id,
    type: "http",
    name,
    labels: ["smoke"],
    method: "GET",
    url: `http://x/${id}`,
    headers: [],
    bodyType: "none",
    body: "",
  });
  const inner: Group = { id: "g2", type: "group", name: "Admin", children: [req("r2", "List rides")] };
  const tree: TreeNode[] = [
    { id: "g1", type: "group", name: "Rides", children: [req("r1", "List rides"), inner] },
    req("r3", "Health"),
  ];

  it("finds by id, path or a name only one has", () => {
    expect(findNode(tree, "r2").id).toBe("r2");
    expect(findNode(tree, "Rides/Admin/List rides").id).toBe("r2");
    expect(findNode(tree, "health").id).toBe("r3");
    expect(findNode(tree, "Admin", "group").id).toBe("g2");
  });

  it("asks for the id when a name is ambiguous, and says when nothing matches", () => {
    expect(() => findNode(tree, "List rides")).toThrow('could be Rides/List rides (r1), Rides/Admin/List rides (r2). Use the id.');
    expect(() => findNode(tree, "Rides", ["http"])).toThrow('Collections has no request called "Rides".');
  });

  it("writes the tree as text", () => {
    expect(treeText(tree)).toEqual([
      "- Rides/ · group · id g1",
      "  - GET List rides · http://x/r1 · #smoke · id r1",
      "  - Admin/ · group · id g2",
      "    - GET List rides · http://x/r2 · #smoke · id r2",
      "- GET Health · http://x/r3 · #smoke · id r3",
    ]);
  });

  it("finds flows and steps", () => {
    const steps = [stepIn({ type: "transform", name: "Count" }), stepIn({ type: "transform", name: "Sum" })];
    const flow: Flow = { id: "f1", name: "Report", vars: [], steps };
    expect(findFlow([flow], "report")).toBe(flow);
    expect(findStep(flow, "2")).toBe(steps[1]);
    expect(findStep(flow, "count")).toBe(steps[0]);
    expect(() => findStep(flow, "9")).toThrow("Report has no step \"9\". It has 1. Count, 2. Sum.");
    expect(() => findFlow([flow], "Nope")).toThrow('There\'s no flow called "Nope".');
  });
});

describe("removing a network", () => {
  const plan: NetworkPlan = {
    network: "rides",
    recreated: false,
    containers: [{ id: "c1", name: "api", image: "uat/api:latest", state: "running" }],
    attached: [{ id: "c2", name: "kafka", image: "bitnami/kafka:3.7", state: "running" }],
    commands: [{ id: "p1", name: "web", running: true }],
    images: [
      { id: "i1", names: ["uat/api:latest"], size: "212.4 MB", kept: null },
      { id: "i2", names: ["redis:7-alpine"], size: "41.2 MB", kept: "used by uat-demo-redis" },
    ],
    volumes: [{ name: "ab".repeat(32), anonymous: true, kept: null }],
  };

  it("says what would go and what would stay", () => {
    expect(planText(plan, true, true)).toBe(
      [
        "Removing rides would:",
        "- remove 1 container: api (uat/api:latest)",
        "- stop and delete 1 command from UAT: web",
        "- disconnect, and leave running: kafka",
        "- remove 1 image: uat/api:latest (212.4 MB)",
        "- remove 1 volume and their data: abababababab (anonymous)",
        "- keep: redis:7-alpine, used by uat-demo-redis",
      ].join("\n"),
    );
  });

  it("keeps images and volumes when asked to", () => {
    const text = planText(plan, false, false);
    expect(text).not.toContain("remove 1 image");
    expect(text).toContain("- keep: uat/api:latest; redis:7-alpine, used by uat-demo-redis; volume abababababab");
  });

  it("says when the network is empty, or made again", () => {
    const empty = { ...plan, network: "uat-net", recreated: true, containers: [], attached: [], commands: [], images: [], volumes: [] };
    expect(planText(empty, true, true)).toBe(
      "Removing uat-net would:\n- remove the network only: nothing runs on it\n\nuat-net is UAT's default network, so UAT makes it again, empty.",
    );
  });

  it("says what went", () => {
    const text = removedText({
      network: "rides",
      recreated: false,
      containers: ["api"],
      disconnected: ["kafka"],
      commands: ["web"],
      images: ["uat/api:latest"],
      volumes: ["ab".repeat(32)],
      kept: ["redis:7-alpine: used by uat-demo-redis"],
    });
    expect(text).toBe(
      [
        "Removed rides.",
        "- containers removed: api",
        "- commands deleted: web",
        "- disconnected: kafka",
        "- images removed: uat/api:latest",
        "- volumes removed: abababababab",
        "- kept: redis:7-alpine: used by uat-demo-redis",
      ].join("\n"),
    );
  });
});

describe("sharing a network", () => {
  const draft = draftOf(
    {
      network: "rides",
      machine: { home: "/Users/amr", user: "amr", host: "mac" },
      containers: [
        {
          name: "api",
          containerName: "api",
          kind: "dockerfile",
          image: "uat/api",
          context: "/Users/amr/code/api",
          dockerfile: null,
          env: ["JWT_SECRET=x", "DATA=/Users/amr/data", "MODE=dev"],
          ports: [{ container: 3000, host: 3000 }],
          dependsOn: [],
          imageLocal: true,
        },
      ],
    },
    [],
    { "/Users/amr/code/api": { root: "/Users/amr/code/api", repo: "github.com/t/api", url: "git@github.com:t/api.git", path: "" } },
  );
  const file = fileOf(draft);

  it("says what an export asks for and how to share it", () => {
    const text = exportText(draft, file, fileText(file), "/tmp/rides.uat.json");
    expect(text).toContain("rides: 1 service from 1 repo (api).");
    expect(text).toContain('- api.JWT_SECRET: Looks secret; share: ["api.JWT_SECRET"] puts its value in the file');
    expect(text).toContain("- api.DATA: Names a Mac or its user, always asked");
    expect(text).not.toContain("/Users/amr");
  });

  it("says what an import needs, by argument", () => {
    const text = questionsText(questions(file, { inUse: [3000], existing: [] }), { api: { clones: [], named: ["/x/api"] } }, "rides");
    expect(text).toBe(
      [
        "Nothing imported yet: 4 answers needed for rides.",
        "",
        "folders (where each repo is on this Mac, or clone_into to clone the missing ones):",
        "- api: github.com/t/api, not found here; folders with its name: /x/api",
        "",
        "values:",
        "- api.JWT_SECRET: Looks secret (secret)",
        "- api.DATA: Names a Mac or its user",
        "",
        "ports (a host port, or null to not publish it):",
        "- api:3000: 3000 is taken here; 3001 is free",
        "",
        "use_defaults takes the suggested values and free ports.",
      ].join("\n"),
    );
  });

  it("says which images only this Mac has, and asks how to get them", () => {
    const mailer = {
      name: "mailer",
      containerName: "mailer",
      kind: "image" as const,
      image: "uat/mailer:dev",
      context: null,
      dockerfile: null,
      env: [],
      ports: [],
      dependsOn: [],
      imageLocal: true,
    };
    const d = draftOf({ network: "rides", machine: { home: "/Users/amr", user: "amr", host: "mac" }, containers: [mailer] }, [], {});
    const f = fileOf(d);
    const text = exportText(d, f, fileText(f), null);
    expect(text).toContain("build_from names the folder that builds each, and the file its repo:\n- mailer: uat/mailer:dev");
    expect(text).not.toContain("Notes:");
    expect(questionsText(questions(f, { inUse: [], existing: [], images: ["uat/mailer:dev"] }), {}, "rides")).toBe(
      [
        "Nothing imported yet: 1 answer needed for rides.",
        "",
        'images (built on the exporter\'s Mac: "use" it when this Mac has it, "skip", or the folder with the Dockerfile that builds it):',
        "- mailer: uat/mailer:dev, this Mac has it",
      ].join("\n"),
    );
  });

  it("says what an import did", () => {
    const text = importedText(
      {
        network: "rides",
        createdNetwork: true,
        added: [{ service: "web", kind: "command", what: "npm run dev, in /x/web" }],
        skipped: [{ service: "db", why: "already on rides" }],
        failed: [{ service: "api", error: "No Dockerfile" }],
      },
      ["found web at /x/web"],
    );
    expect(text).toContain("Imported into rides, which was made for it.");
    expect(text).toContain("- api failed: No Dockerfile");
    expect(text).toContain("Commands are added stopped");
  });
});
