/** UAT's MCP server end to end, through the official SDK: an agent starts
 *  `app mcp`, which reaches a UAT run here under a scratch HOME, so nothing
 *  of yours is touched. Needs a built app and the Vite dev server:
 *
 *    cargo build --manifest-path src-tauri/Cargo.toml
 *    npm run dev &
 *    UAT_MCP_E2E=1 npx vitest run e2e
 *
 *  With UAT_MCP_E2E_DOCKER=1 it also runs a command as a service on a
 *  network of its own (uat-mcp-e2e), and exports a network built from a git
 *  repo and imports it back (uat-mcp-e2e-share, on alpine:3.20), removing
 *  what it made after.
 *
 *  Quit your own UAT first: a UAT that starts removes every UAT trace
 *  sidecar and command proxy, its own copy's included. */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BIN = new URL("../src-tauri/target/debug/app", import.meta.url).pathname;
const NETWORK = "uat-mcp-e2e";

type Text = { content: { type: string; text: string }[]; isError?: boolean };

const quietly = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
  } catch {
    // Not made, or already gone
  }
};

/** Trace sidecars of containers that are gone: the app is closed before it gets to them */
function removeOrphanSidecars() {
  const sidecars = execFileSync("docker", ["ps", "-a", "--filter", "label=uat.kind=sniffer", "--format", '{{.ID}} {{.Label "uat.sniff"}}'], { encoding: "utf8" });
  for (const [id, target] of sidecars.trim().split("\n").filter(Boolean).map((l) => l.split(" "))) {
    try {
      execFileSync("docker", ["inspect", target], { stdio: "ignore" });
    } catch {
      quietly("docker", ["rm", "-f", id]);
    }
  }
}

describe.runIf(process.env.UAT_MCP_E2E)("UAT over MCP", () => {
  // Made in beforeAll: the body runs to collect the tests even when they're skipped
  let home = "";
  let env: Record<string, string> = {};
  let app: ChildProcess;
  let api: Server;
  let base = "";
  const client = new Client({ name: "uat-e2e", version: "1.0.0" });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as Text;
    return { text: r.content.map((c) => c.text).join("\n"), error: !!r.isError };
  };
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    if (r.error) throw new Error(`${name}: ${r.text}`);
    return r.text;
  };

  beforeAll(async () => {
    api = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url, rides: [{ id: 7, status: "open" }, { id: 8, status: "done" }] }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;

    home = mkdtempSync(join(tmpdir(), "uat-mcp-e2e-"));
    env = { ...process.env, HOME: home } as Record<string, string>;
    app = spawn(BIN, [], { env, stdio: "ignore" });
    // Outside a bundle the bridge can't open UAT itself: wait for it to listen
    const settings = join(home, "Library/Application Support/dev.uat.desktop/mcp.json");
    for (let i = 0; ; i++) {
      if (app.exitCode !== null) throw new Error(`UAT exited with ${app.exitCode}`);
      const port = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")).port : null;
      const up = port && (await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" }).then(() => true, () => false));
      if (up) break;
      if (i > 150) throw new Error("UAT didn't start listening in 30 s");
      await new Promise((r) => setTimeout(r, 200));
    }
    await client.connect(new StdioClientTransport({ command: BIN, args: ["mcp"], env, stderr: "inherit" }));
  }, 120_000);

  afterAll(async () => {
    await client.close().catch(() => {});
    app?.kill();
    api?.close();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("introduces itself and lists every tool", async () => {
    expect(client.getServerVersion()?.name).toBe("uat");
    const { tools } = await client.listTools(undefined, { timeout: 60_000 });
    const names = tools.map((t) => t.name);
    for (const n of ["uat_overview", "add_service", "service_logs", "send_request", "connect_socket", "run_flow", "get_flow_run", "export_flow_report", "start_demo", "remove_network"]) {
      expect(names).toContain(n);
    }
    const remove = tools.find((t) => t.name === "remove_service")!;
    expect(remove.annotations?.destructiveHint).toBe(true);
    expect(remove.inputSchema.required).toEqual(["service"]);
  }, 90_000);

  it("gives an overview", async () => {
    expect(await ok("uat_overview")).toMatch(/Collections: \d+ items?/);
  });

  it("saves a request, sends it, and shows the response", async () => {
    const saved = JSON.parse(await ok("save_request", { name: "E2E rides", url: `${base}/rides`, labels: ["e2e"] }));
    expect(saved.saved).toMatchObject({ type: "http", method: "GET", labels: ["e2e"] });
    expect(await ok("list_collections", { query: "e2e" })).toContain("GET E2E rides");
    const sent = await ok("send_request", { item: "E2E rides" });
    expect(sent).toContain("200 OK");
    expect(sent).toContain('"status": "open"');
    expect(sent).toContain("No trace");
    expect(JSON.parse(await ok("get_item", { item: saved.saved.id })).last_response.status).toBe("200 OK");
  }, 60_000);

  it("sends a one-off request with a JSON body", async () => {
    const sent = await ok("send_request", { method: "POST", url: `${base}/book`, body: { from: "Maarif" }, trace: false });
    expect(sent).toContain('"path": "/book"');
  });

  it("says what's wrong with a call", async () => {
    const r = await call("save_request", { nope: 1 });
    expect(r.error).toBe(true);
    expect(r.text).toContain('has no argument "nope"');
    const missing = await call("get_item", { item: "Nothing like this" });
    expect(missing.text).toContain("list_collections shows what's there");
  });

  it("builds a flow, runs it, and reads and exports its report", async () => {
    await ok("save_flow", {
      name: "E2E flow",
      inputs: { base },
      steps: [
        { type: "request", name: "List rides", url: "{{base}}/rides", keep: { rides: "body.rides" } },
        { type: "transform", name: "Open ones", as: "open", code: "log(rides.length); return _.filter(rides, { status: 'open' });" },
      ],
    });
    await ok("save_step", { flow: "E2E flow", fields: { type: "request", name: "Get the ride", url: "{{base}}/rides/{{open[0].id}}" } });
    const flow = JSON.parse(await ok("get_flow", { flow: "E2E flow" }));
    expect(flow.steps.map((s: { name: string }) => s.name)).toEqual(["List rides", "Open ones", "Get the ride"]);

    const run = await ok("run_flow", { flow: "E2E flow" });
    expect(run).toContain("Passed: all 3 steps");
    expect(await ok("get_flow_run", { flow: "E2E flow", step: "3" })).toContain("GET http://127.0.0.1");
    expect(await ok("get_flow_run", { flow: "E2E flow", step: "Open ones" })).toContain('"id": 7');

    const path = join(home, "report.md");
    expect(await ok("export_flow_report", { flow: "E2E flow", format: "md", path })).toBe(`Saved ${path}`);
    expect(readFileSync(path, "utf8")).toContain("# E2E flow");
  }, 90_000);

  it("stops a flow when a step fails, and says where", async () => {
    await ok("save_step", { flow: "E2E flow", step: "1", fields: { url: "http://127.0.0.1:9/nothing" } });
    const run = await ok("run_flow", { flow: "E2E flow" });
    expect(run).toContain("Failed at step 1, List rides");
    expect(run).toContain("### 1. List rides — Failed");
  }, 60_000);

  it("reports on Docker", async () => {
    expect(await ok("list_networks")).toMatch(/Docker/);
  });

  it.runIf(process.env.UAT_MCP_E2E_DOCKER)(
    "runs a command as a service, reads its logs, and removes it",
    async () => {
      const folder = mkdtempSync(join(tmpdir(), "uat-mcp-e2e-web-"));
      try {
        const added = await ok("add_service", {
          network: NETWORK,
          name: "e2e-web",
          command: "python3 -u -m http.server 8799 --bind 127.0.0.1",
          folder,
          ports: "8799",
        });
        expect(added).toContain("Added e2e-web");
        expect(await ok("list_services", { network: NETWORK })).toContain("e2e-web");
        const until = async (what: () => Promise<string>, want: string) => {
          let last = "";
          for (let i = 0; i < 20 && !last.includes(want); i++) {
            if (i) await new Promise((r) => setTimeout(r, 500));
            last = await what();
          }
          return last;
        };
        expect(await until(() => ok("send_request", { url: "http://127.0.0.1:8799/", trace: false }), "200 OK")).toContain("200 OK");
        expect(await until(() => ok("service_logs", { service: "e2e-web", find: "GET /" }), "GET / HTTP")).toContain("GET / HTTP");
        expect(await ok("stop_service", { service: "e2e-web" })).toMatch(/stopped|exited/);
        expect(await ok("remove_service", { service: "e2e-web" })).toBe(`Removed e2e-web from ${NETWORK}.`);
        expect(await ok("remove_network", { network: NETWORK, dry_run: true })).toContain("remove the network only");
        expect(await ok("remove_network", { network: NETWORK })).toBe(`Removed ${NETWORK}.`);
        expect(await ok("list_networks")).not.toContain(NETWORK);
      } finally {
        await call("remove_service", { service: "e2e-web", network: NETWORK }).catch(() => {});
        rmSync(folder, { recursive: true, force: true });
        quietly("docker", ["network", "rm", NETWORK]);
        removeOrphanSidecars();
      }
    },
    240_000,
  );

  it.runIf(process.env.UAT_MCP_E2E_DOCKER)(
    "exports a network with nothing of this Mac in it, and imports it asking for what was left out",
    async () => {
      const net = "uat-mcp-e2e-share";
      const api = "e2e-share-api";
      const copy = "e2e-share-copy";
      const repo = join(home, "code", "uat-e2e-shop");
      const blocker = createServer();
      // Images only these containers use stay: alpine:3.20 may be yours
      const remove = () => call("remove_network", { network: net, images: false });
      try {
        mkdirSync(join(repo, "svc"), { recursive: true });
        mkdirSync(join(repo, "web"), { recursive: true });
        writeFileSync(join(repo, "svc", "Dockerfile"), 'FROM alpine:3.20\nCMD ["sh", "-c", "echo up; sleep 3600"]\n');
        execFileSync("git", ["init", "-q", repo]);
        execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/uat-e2e/shop.git"]);

        await ok("add_service", {
          network: net,
          name: api,
          build: join(repo, "svc"),
          env: { MODE: "dev", TOKEN: "s3cret-e2e", DATA_DIR: join(home, "data") },
          ports: "8797:80",
        });
        await ok("add_service", { network: net, name: "e2e-share-db", image: "alpine:3.20", env: { DB_PASSWORD: "pw-e2e" } });
        // Its image was only built here
        await ok("add_service", { network: net, name: copy, image: `uat/${api}:latest` });
        await ok("add_service", {
          network: net,
          name: "e2e-share-web",
          command: "python3 -u -m http.server 8796 --bind 127.0.0.1",
          folder: join(repo, "web"),
          ports: "8796",
          env: { ROOT: "./public" },
          depends_on: [api],
        });

        // Export: named by the repo, with nothing that only works here
        const exported = await ok("export_network", { network: net, file: join(home, "shared") });
        const path = join(home, "shared", `${net}.uat.json`);
        expect(exported).toContain(`Written to ${path}.`);
        expect(exported).toContain(`- ${api}.DATA_DIR: Names a Mac or its user, always asked`);
        const text = readFileSync(path, "utf8");
        for (const mine of [home, realpathSync(home), "s3cret-e2e", "pw-e2e"]) expect(text).not.toContain(mine);
        const file = JSON.parse(text);
        expect(file.repos).toEqual({ shop: { git: "github.com/uat-e2e/shop", clone: "https://github.com/uat-e2e/shop.git" } });
        expect(file.services[api]).toMatchObject({
          build: { repo: "shop", path: "svc" },
          ports: ["8797:80"],
          env: { MODE: "dev", TOKEN: { ask: "Looks secret", secret: true }, DATA_DIR: { ask: "Names a Mac or its user" } },
        });
        expect(file.services["e2e-share-db"]).toMatchObject({ image: "alpine:3.20", env: { DB_PASSWORD: { ask: "Looks secret", secret: true } } });
        expect(file.services[copy]).toEqual({ image: `uat/${api}:latest`, local: true });
        expect(exported).toContain(`the file its repo:\n- ${copy}: uat/${api}:latest`);

        // Built from the folder that builds it instead, the file names that repo
        expect((await call("export_network", { network: net, build_from: { [copy]: join(repo, "web") } })).text).toContain("No Dockerfile at");
        const linked = await ok("export_network", { network: net, build_from: { [copy]: join(repo, "svc") } });
        expect(linked).toContain("Not written");
        const linkedFile = JSON.parse(linked.split("```json\n")[1].split("\n```")[0]);
        expect(linkedFile.services[copy]).toEqual({ build: { repo: "shop", path: "svc" } });
        for (const mine of [home, realpathSync(home)]) expect(linked).not.toContain(mine);
        expect(file.services["e2e-share-web"]).toMatchObject({
          run: { repo: "shop", path: "web", command: "python3 -u -m http.server 8796 --bind 127.0.0.1" },
          env: { ROOT: { ask: "A path", default: "./public" } },
          dependsOn: [api],
        });

        expect((await remove()).text).toContain(`Removed ${net}.`);

        // Import: the clone is found by its remote; values and a taken port are asked for
        await new Promise<void>((r) => blocker.listen(8797, "127.0.0.1", r));
        const asked = await ok("import_network", { file: path });
        expect(asked).toContain(`Nothing imported yet: 6 answers needed for ${net}.`);
        expect(asked).toContain(`- ${copy}: uat/${api}:latest, this Mac has it`);
        expect(asked).toContain(`- ${api}.TOKEN: Looks secret (secret)`);
        expect(asked).toContain(`- ${api}:80: 8797 is taken here; 8798 is free`);
        expect(asked).toContain(`- found shop at ${realpathSync(repo)}`);
        expect(asked).not.toContain("folders (");

        const answers = {
          file: path,
          values: { [`${api}.TOKEN`]: "t-2", [`${api}.DATA_DIR`]: "/data", "e2e-share-db.DB_PASSWORD": "pw-2" },
          images: { [copy]: "use" },
          use_defaults: true,
        };
        expect((await call("import_network", { ...answers, images: { [copy]: join(repo, "web") }, dry_run: true })).text).toContain("No Dockerfile at");
        const dry = await ok("import_network", { ...answers, dry_run: true });
        expect(dry).toContain(`- add ${api}: built from ${realpathSync(repo)}/svc, ports 8798→80`);
        expect(dry).toContain(`- add ${copy}: uat/${api}:latest`);
        const done = await ok("import_network", answers);
        expect(done).toContain(`Imported into ${net}, which was made for it.`);
        expect(done).toContain("- added e2e-share-web: python3 -u -m http.server 8796 --bind 127.0.0.1, in");
        expect(done).not.toContain("failed");
        const env = JSON.parse(execFileSync("docker", ["inspect", `${net}-${api}`, "--format", "{{json .Config.Env}}"], { encoding: "utf8" }));
        expect(env).toEqual(expect.arrayContaining(["MODE=dev", "TOKEN=t-2", "DATA_DIR=/data"]));
        expect(execFileSync("docker", ["port", `${net}-${api}`], { encoding: "utf8" })).toContain(":8798");
        const listed = await ok("list_services", { network: net });
        for (const s of [api, "e2e-share-db", "e2e-share-web", copy]) expect(listed).toContain(s);
      } finally {
        blocker.close();
        await remove().catch(() => {});
        quietly("docker", ["rmi", `uat/${api}:latest`]);
        quietly("docker", ["network", "rm", net]);
        removeOrphanSidecars();
      }
    },
    300_000,
  );

  it("wrote its settings privately under the scratch HOME", () => {
    const settings = join(home, "Library/Application Support/dev.uat.desktop/mcp.json");
    expect(existsSync(settings)).toBe(true);
    expect(JSON.parse(readFileSync(settings, "utf8")).token).toHaveLength(64);
  });
});
