import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "./processes";
import {
  asked,
  draftOf,
  fileOf,
  fileText,
  missing,
  order,
  parseFile,
  portsOf,
  questions,
  stepsOf,
  warnings,
  whyAsk,
  withDefaults,
  type GitInfo,
  type Machine,
  type NetworkFile,
  type Snapshot,
} from "./share";

const machine: Machine = { home: "/Users/amr", user: "amr", host: "Amrs-MacBook-Pro" };

const snap: Snapshot = {
  network: "rides",
  machine,
  containers: [
    {
      name: "api",
      containerName: "api",
      kind: "dockerfile",
      image: "uat/api:latest",
      context: "/Users/amr/code/rides-api/services/api",
      dockerfile: "Dockerfile.dev",
      env: [
        "NODE_ENV=development",
        "DATABASE_URL=postgres://rides:rides@db:5432/rides",
        "JWT_SECRET=s3cr3t-value",
        "UPLOADS=/Users/amr/uploads",
        "CONFIG=./config/dev.json",
        "API_PREFIX=/api/v1",
        "CACHE=redis://cache:6379",
      ],
      ports: [{ container: 3000, host: 3000 }],
      dependsOn: ["db", "cache"],
      imageLocal: true,
    },
    {
      name: "db",
      containerName: "db",
      kind: "image",
      image: "postgres:16",
      context: null,
      dockerfile: null,
      env: ["POSTGRES_PASSWORD=rides", "POSTGRES_USER=rides"],
      ports: [{ container: 5432, host: 5433 }],
      dependsOn: [],
      imageLocal: false,
    },
    {
      name: "cache",
      containerName: "compose-redis-1",
      kind: "attached",
      image: "redis:7",
      context: null,
      dockerfile: null,
      env: ["REDIS_ARGS=--save 60"],
      ports: [{ container: 6379, host: 6379 }],
      dependsOn: [],
      imageLocal: false,
    },
  ],
};

const commands = [
  {
    id: "p1",
    name: "web",
    network: "rides",
    cwd: "~/code/rides-web",
    command: "npm run dev",
    env: ["VITE_API_URL=http://localhost:3000", "VITE_HOST=192.168.1.20"],
    ports: [5173],
    dependsOn: ["api"],
    state: "stopped",
    pid: null,
    exitCode: null,
    networkError: null,
  },
  {
    id: "p2",
    name: "seed",
    network: "rides",
    cwd: "/Users/amr/scratch/seed",
    command: "node /Users/amr/scratch/seed/run.js",
    env: [],
    ports: [],
    dependsOn: ["db"],
    state: "stopped",
    pid: null,
    exitCode: null,
    networkError: null,
  },
] satisfies ProcessInfo[];

const git: Record<string, GitInfo | null> = {
  "/Users/amr/code/rides-api/services/api": {
    root: "/Users/amr/code/rides-api",
    repo: "github.com/yassir/rides-api",
    url: "git@github.com:yassir/rides-api.git",
    path: "services/api",
  },
  "~/code/rides-web": { root: "/Users/amr/code/rides-web", repo: "github.com/yassir/rides-web", url: "https://github.com/yassir/rides-web.git", path: "" },
  "/Users/amr/scratch/seed": null,
};

describe("what doesn't travel", () => {
  it("asks for what names a Mac, paths, local addresses and secrets", () => {
    expect(whyAsk("UPLOADS", "/Users/amr/uploads", machine)).toBe("machine");
    expect(whyAsk("DIR", "~/data")).toBe("machine");
    expect(whyAsk("DIR", "C:\\Users\\amr\\data")).toBe("machine");
    expect(whyAsk("OWNER", "amr", machine)).toBe("machine");
    expect(whyAsk("HOST", "Amrs-MacBook-Pro.local", machine)).toBe("machine");
    expect(whyAsk("TOKEN", "abc")).toBe("secret");
    expect(whyAsk("DB_PASSWORD", "x")).toBe("secret");
    expect(whyAsk("DATABASE_URL", "postgres://u:p@db/x")).toBe("secret");
    expect(whyAsk("GH", "ghp_abcdef123456")).toBe("secret");
    expect(whyAsk("CERT", "/etc/ssl/cert.pem")).toBe("path");
    expect(whyAsk("CONFIG", "./config/dev.json")).toBe("path");
    expect(whyAsk("BIN", "/opt/homebrew/bin/node")).toBe("path");
    expect(whyAsk("HOST", "192.168.1.20")).toBe("address");
  });

  it("shares what works anywhere", () => {
    expect(whyAsk("NODE_ENV", "development", machine)).toBeNull();
    expect(whyAsk("API_PREFIX", "/api/v1")).toBeNull();
    expect(whyAsk("API_URL", "http://api:3000/v1")).toBeNull();
    expect(whyAsk("CDN", "https://cdn.example.com/app.js")).toBeNull();
    expect(whyAsk("KEYCLOAK_URL", "http://keycloak:8080")).toBeNull();
    // A common name isn't taken for this Mac's user
    expect(whyAsk("NODE_ENV", "dev", { ...machine, user: "dev" })).toBeNull();
    // In a command, ./x is inside its repo, and a secret's name is the command's
    expect(whyAsk("command", "./gradlew bootRun", machine, true)).toBeNull();
    expect(whyAsk("command", "node /Users/amr/x.js", machine, true)).toBe("machine");
  });
});

describe("export", () => {
  const draft = draftOf(snap, commands, git);
  const file = fileOf(draft);
  const text = fileText(file);

  it("names repos by their repo name, and folders outside git by theirs", () => {
    expect(file.repos).toEqual({
      "rides-api": { git: "github.com/yassir/rides-api", clone: "git@github.com:yassir/rides-api.git" },
      "rides-web": { git: "github.com/yassir/rides-web", clone: "https://github.com/yassir/rides-web.git" },
      seed: { git: null },
    });
    expect(file.services.api.build).toEqual({ repo: "rides-api", path: "services/api", dockerfile: "Dockerfile.dev" });
    expect(file.services.web.run).toEqual({ repo: "rides-web", command: "npm run dev" });
    expect(file.services.cache).toEqual({ attached: { image: "redis:7", container: "compose-redis-1" }, ports: ["6379:6379"] });
    expect(file.services.db).toMatchObject({ image: "postgres:16", ports: ["5433:5432"] });
  });

  it("puts nothing from this Mac in the file", () => {
    for (const s of ["/Users", "amr/", "Amrs-MacBook", "~/", "s3cr3t", "192.168", "scratch"]) expect(text).not.toContain(s);
  });

  it("asks for values that don't travel, with a suggestion only where it's safe", () => {
    expect(file.services.api.env).toEqual({
      NODE_ENV: "development",
      DATABASE_URL: { ask: "Looks secret", secret: true },
      JWT_SECRET: { ask: "Looks secret", secret: true },
      UPLOADS: { ask: "Names a Mac or its user" },
      CONFIG: { ask: "A path", default: "./config/dev.json" },
      API_PREFIX: "/api/v1",
      CACHE: "redis://cache:6379",
    });
    expect(file.services.seed.run!.command).toEqual({ ask: "Names a Mac or its user" });
    expect(file.services.web.env!.VITE_HOST).toEqual({ ask: "An address on a local network" });
    // An attached container's env is its own
    expect(file.services.cache.env).toBeUndefined();
  });

  it("lets the exporter share a secret, but never what names the Mac", () => {
    const shared = draftOf(snap, commands, git);
    for (const e of shared.entries) e.share = true;
    const f = fileOf(shared);
    expect(f.services.db.env!.POSTGRES_PASSWORD).toBe("rides");
    expect(f.services.api.env!.UPLOADS).toEqual({ ask: "Names a Mac or its user" });
    expect(f.services.seed.run!.command).toEqual({ ask: "Names a Mac or its user" });
  });

  it("says what others can't get", () => {
    const notes = draft.notes.map((n) => n.text);
    // Built from its repo, it's built again there
    expect(notes.some((n) => n.startsWith("uat/api"))).toBe(false);
    expect(notes.some((n) => n.startsWith("seed isn't in a git repo"))).toBe(true);
    expect(notes.some((n) => n.startsWith("cache was started outside UAT"))).toBe(true);
  });

  it("marks an image only this Mac has, or builds it from the folder chosen", () => {
    const localDb = { ...snap, containers: snap.containers.map((c) => (c.name === "db" ? { ...c, imageLocal: true } : c)) };
    const local = draftOf(localDb, [], git);
    expect(fileOf(local).services.db).toMatchObject({ image: "postgres:16", local: true });
    expect(local.images).toEqual([{ service: "db", image: "postgres:16", local: true, build: null }]);
    expect(local.notes.find((n) => n.local)).toMatchObject({ service: "db", text: expect.stringContaining("postgres:16 was only built on this Mac") });

    const pg = { "/Users/amr/code/pg": { root: "/Users/amr/code/pg", repo: "github.com/yassir/pg", url: null, path: "" } };
    const built = draftOf(localDb, [], { ...git, ...pg }, { db: { folder: "/Users/amr/code/pg", dockerfile: "docker/Dockerfile" } });
    const db = fileOf(built).services.db;
    expect(db.build).toMatchObject({ repo: "pg", dockerfile: "docker/Dockerfile" });
    expect(db.image).toBeUndefined();
    expect(db.local).toBeUndefined();
    expect(fileOf(built).repos.pg).toEqual({ git: "github.com/yassir/pg" });
    expect(built.notes.some((n) => n.local)).toBe(false);
    expect(fileText(fileOf(built))).not.toContain("/Users");
  });

  it("names two repos with one name by their owners", () => {
    const g = {
      a: { root: "/r/a", repo: "github.com/yassir/api", url: null, path: "" },
      b: { root: "/r/b", repo: "github.com/other/api", url: null, path: "" },
    };
    const two = draftOf({ ...snap, containers: [] }, [{ ...commands[0], name: "a", cwd: "a" }, { ...commands[0], name: "b", cwd: "b" }], g);
    expect(Object.keys(two.repos)).toEqual(["yassir-api", "other-api"]);
  });

  it("reads back what it writes", () => {
    expect(parseFile(text)).toEqual(file);
  });
});

describe("reading a file", () => {
  const base = { uat: 1, kind: "network", name: "rides", repos: {}, services: {} };
  const bad = (f: object) => () => parseFile(JSON.stringify({ ...base, ...f }));

  it("says what's wrong", () => {
    expect(() => parseFile("{")).toThrow(/isn't JSON/);
    expect(() => parseFile("{}")).toThrow(/isn't a UAT network file/);
    expect(bad({ uat: 9 })).toThrow(/newer UAT/);
    expect(bad({ services: { api: {} } })).toThrow(/needs one of build, image, run or attached/);
    expect(bad({ services: { api: { build: { repo: "x" } } } })).toThrow(/comes from x, which isn't in "repos"/);
    expect(bad({ repos: { x: { git: null } }, services: { api: { build: { repo: "x", path: "/Users/a" } } } })).toThrow(/inside the repo/);
    expect(bad({ repos: { x: { git: null } }, services: { api: { build: { repo: "x", path: "../up" } } } })).toThrow(/inside the repo/);
    expect(bad({ services: { db: { image: "pg", ports: ["99999"] } } })).toThrow(/isn't a port/);
    expect(bad({ services: { db: { image: "pg", env: { A: 1 } } } })).toThrow(/A should be a string/);
    expect(bad({ services: { db: { image: "pg", dependsOn: ["x"] } } })).toThrow(/depends on x/);
    expect(bad({ services: { "Bad Name": { image: "pg" } } })).toThrow(/names use/);
    expect(bad({ services: { db: { image: "pg", local: "yes" } } })).toThrow(/"local" goes with "image"/);
    expect(bad({ services: { db: { attached: { image: "pg" }, local: true } } })).toThrow(/"local" goes with "image"/);
  });
});

describe("import", () => {
  const file = fileOf(draftOf(snap, commands, git));
  const here = { inUse: [3000], existing: [] as string[] };

  it("asks for repos, values, ports in use and attached containers", () => {
    const qs = questions(file, here);
    expect(qs.filter((q) => q.kind === "repo").map((q) => q.key)).toEqual(["rides-api", "seed", "rides-web"]);
    expect(qs.filter((q) => q.kind === "value").map((q) => q.key)).toEqual([
      "api.DATABASE_URL",
      "api.JWT_SECRET",
      "api.UPLOADS",
      "api.CONFIG",
      "db.POSTGRES_PASSWORD",
      "seed.command",
      "web.VITE_HOST",
    ]);
    expect(qs.find((q) => q.kind === "port")).toMatchObject({ key: "api:3000", host: 3000, suggest: 3001 });
    expect(qs.find((q) => q.kind === "attached")).toMatchObject({ key: "cache", image: "redis:7", container: "compose-redis-1" });
    expect(portsOf(file).sort()).toEqual([3000, 5173, 5433]);
  });

  it("leaves services the network has alone, and what only they need", () => {
    const qs = questions(file, { inUse: [], existing: ["api", "seed"] });
    expect(qs.filter((q) => q.kind === "repo").map((q) => q.key)).toEqual(["rides-web"]);
    expect(qs.some((q) => q.key.startsWith("api."))).toBe(false);
  });

  it("asks for a path someone put in a file by hand", () => {
    const f = parseFile(JSON.stringify({ ...file, services: { db: { image: "pg", env: { DIR: "/Users/bob/data" } } } }));
    expect(questions(f, { inUse: [], existing: [] })[0]).toMatchObject({ key: "db.DIR", why: "A path on someone else's Mac" });
  });

  it("warns when a command's own port is taken", () => {
    expect(warnings(file, { inUse: [5173], existing: [] })[0].text).toBe("Port 5173 is in use here: web may not start until it's free.");
  });

  it("starts what others depend on first", () => {
    expect(order(file.services)).toEqual(["db", "cache", "api", "seed", "web"]);
    // A loop doesn't hang
    expect(order({ a: { image: "x", dependsOn: ["b"] }, b: { image: "y", dependsOn: ["a"] } })).toEqual(["b", "a"]);
  });

  it("turns answers into steps", () => {
    const answers = withDefaults(questions(file, here), {
      network: "rides-local",
      repos: { "rides-api": "/Users/sara/src/rides-api/", "rides-web": "/Users/sara/src/rides-web", seed: "/Users/sara/seed" },
      values: { "api.DATABASE_URL": "postgres://me:me@db/rides", "api.JWT_SECRET": "x", "api.UPLOADS": "/tmp/up", "db.POSTGRES_PASSWORD": "pw", "seed.command": "node run.js", "web.VITE_HOST": "localhost" },
      attached: { cache: "run" },
    });
    expect(missing(file, here, answers)).toEqual([]);
    const steps = stepsOf(file, here, answers);
    expect(steps.map((s) => `${s.kind} ${s.service}`)).toEqual(["container db", "container cache", "container api", "command seed", "command web"]);
    const api = steps[2];
    expect(api.kind === "container" && api.req).toMatchObject({
      network: "rides-local",
      source: { kind: "dockerfile", context: "/Users/sara/src/rides-api/services/api", dockerfile: "Dockerfile.dev" },
      ports: [{ container: 3000, host: 3001 }],
      dependsOn: ["db", "cache"],
    });
    expect(api.kind === "container" && api.req.env).toContain("CONFIG=./config/dev.json");
    expect(api.kind === "container" && api.req.env).toContain("NODE_ENV=development");
    // Run from its image, it's only on the network
    expect(steps[1].kind === "container" && steps[1].req.ports).toEqual([{ container: 6379, host: null }]);
    const web = steps[4];
    expect(web.kind === "command" && web.def).toMatchObject({ cwd: "/Users/sara/src/rides-web", command: "npm run dev", ports: [5173] });
  });

  it("asks how to get an image built on the exporter's Mac, and builds it from a folder", () => {
    const f: NetworkFile = {
      uat: 1,
      kind: "network",
      name: "n",
      repos: {},
      services: { mailer: { image: "uat/mailer:dev", local: true, env: { SMTP_PASS: { ask: "Looks secret", secret: true } }, ports: ["8025:8025"] } },
    };
    const none = { inUse: [8025], existing: [] };
    const qs = questions(f, none);
    expect(qs.find((q) => q.kind === "image")).toEqual({ kind: "image", key: "mailer", service: "mailer", image: "uat/mailer:dev", here: false });
    // Not here, so there's nothing to suggest
    expect(withDefaults(qs, {}).images).toEqual({});
    expect(withDefaults(questions(f, { ...none, images: ["uat/mailer:dev"] }), {}).images).toEqual({ mailer: "use" });

    // Left out, nothing else about it is asked
    const skip = { images: { mailer: "skip" as const } };
    expect(asked(qs, skip).map((q) => q.kind)).toEqual(["image"]);
    expect(missing(f, none, skip)).toEqual([]);
    expect(stepsOf(f, none, skip)).toEqual([{ kind: "skip", service: "mailer", why: "left out" }]);

    const build = { images: { mailer: { folder: " /Users/sara/mailer ", dockerfile: "Dockerfile.dev" } }, values: { "mailer.SMTP_PASS": "pw" }, ports: { "mailer:8025": 8026 } };
    expect(missing(f, none, build)).toEqual([]);
    const [step] = stepsOf(f, none, build);
    expect(step.kind === "container" && step.req).toMatchObject({
      source: { kind: "dockerfile", context: "/Users/sara/mailer", dockerfile: "Dockerfile.dev" },
      env: ["SMTP_PASS=pw"],
      ports: [{ container: 8025, host: 8026 }],
    });
    const use = stepsOf(f, { ...none, images: ["uat/mailer:dev"] }, { ...build, images: { mailer: "use" } })[0];
    expect(use.kind === "container" && use.req.source).toEqual({ kind: "image", image: "uat/mailer:dev" });
  });

  it("attaches or skips as answered, and won't run with questions left", () => {
    const f: NetworkFile = { uat: 1, kind: "network", name: "n", repos: {}, services: { cache: { attached: { image: "redis:7" } } } };
    const none = { inUse: [], existing: [] };
    expect(() => stepsOf(f, none, {})).toThrow(/1 question is unanswered/);
    expect(stepsOf(f, none, { attached: { cache: { container: "my-redis" } } })).toEqual([{ kind: "attach", service: "cache", container: "my-redis" }]);
    expect(stepsOf(f, none, { attached: { cache: "skip" } })[0]).toMatchObject({ kind: "skip" });
  });
});
