/** A network as a file to keep in git and share with a team: what runs on
 *  it, named by the repos it comes from, with nothing that only works on one
 *  Mac. Paths, secrets and anything naming the Mac or its user are left as
 *  questions, which an import asks before it adds anything.
 *
 *  This is the format and its rules only; `shareRun.ts` reads this Mac and
 *  runs an import. */
import type { AddServiceRequest, PortInfo } from "./api";
import type { NewProcess, ProcessInfo } from "./processes";

export const FORMAT = 1;
export const SUFFIX = ".uat.json";

/** Asked on import: why, and what to suggest */
export type Ask = { ask: string; default?: string; secret?: boolean };
export type Value = string | Ask;

/** A repo services come from, under its name. `git: null` is a folder that
 *  isn't in git (or has no remote): each person picks it. */
export type Repo = { git: string | null; clone?: string };

export type SharedService = {
  /** Built from a Dockerfile in a repo */
  build?: { repo: string; path?: string; dockerfile?: string };
  /** Run from an image */
  image?: string;
  /** With image: it was built on the exporter's Mac and isn't in a
   *  registry, so import asks how to get it */
  local?: boolean;
  /** Run on the Mac, in a repo */
  run?: { repo: string; path?: string; command: Value };
  /** Started outside UAT (compose, the CLI) and attached to the network */
  attached?: { image: string; container?: string };
  /** "3000", or "8080:3000" to publish it on the Mac */
  ports?: string[];
  env?: Record<string, Value>;
  dependsOn?: string[];
};

export type NetworkFile = {
  uat: number;
  kind: "network";
  name: string;
  repos: Record<string, Repo>;
  services: Record<string, SharedService>;
};

// ---------------------------------------------------------------------------
// What this Mac knows (from Rust)

export type SnapContainer = {
  name: string;
  containerName: string;
  kind: "dockerfile" | "image" | "attached";
  image: string;
  context: string | null;
  dockerfile: string | null;
  env: string[];
  ports: PortInfo[];
  dependsOn: string[];
  imageLocal: boolean;
};
export type Machine = { home: string; user: string; host: string };
export type Snapshot = { network: string; containers: SnapContainer[]; machine: Machine };
export type GitInfo = { root: string; repo: string | null; url: string | null; path: string };

// ---------------------------------------------------------------------------
// What doesn't travel

/** Why a value is asked for: it names this Mac, it's a path or an address
 *  here, or it looks secret */
export type Why = "machine" | "path" | "address" | "secret";

export const WHY: Record<Why, string> = {
  machine: "Names a Mac or its user",
  path: "A path",
  address: "An address on a local network",
  secret: "Looks secret",
};

const SECRET_NAME =
  /secret|passw|pwd|token|credential|private|api[-_]?key|access[-_]?key|(^|_)key($|_)|(^|_)auth($|_)|session|cookie|dsn|signing|salt/i;
const SECRET_VALUE = [
  /^[a-z][\w+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // a URL with a password in it
  /^eyJ[\w-]+\.[\w-]+\./, // a JWT
  /^(sk|pk|rk)[-_](live|test)?[-_]?\w{12,}/, // Stripe-like and OpenAI-like keys
  /^(gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
// Paths only one Mac (or PC) has
const HOME_PATH = /(^|[\s=:,;"'(])(~(?=\/|$)|\/Users\/|\/home\/|\/Volumes\/|\/private\/var\/folders\/|\/var\/folders\/|[A-Za-z]:\\Users\\)/;
// A file path, not a URL's: under a root folder, or ending in a file's extension
const ABS_PATH =
  /(^|[\s=:,;"'(])(\/(usr|opt|etc|var|tmp|private|Library|System|Applications|bin|sbin|srv|mnt|root|run|nix|app|data|workspace|code|src)(\/|$)|\/(?!\/)[^\s:,;"')]*\.(json|ya?ml|toml|pem|key|crt|cert|p12|sock|db|sqlite3?|env|conf|cfg|ini|txt|log|js|ts|py|sh)\b|[A-Za-z]:\\)/;
const REL_PATH = /(^|[\s=:,;"'(])\.{1,2}\/[^\s]*/;
const LAN = /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b|\b[\w-]+\.local\b/;

// Usernames too common to mean this Mac's user
const COMMON = new Set(["dev", "admin", "user", "test", "app", "root", "node", "ubuntu", "postgres", "docker", "default"]);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `s` (a user, a host, a home) as a whole word of `v` */
const mentions = (v: string, s: string) =>
  s.length >= 3 && !COMMON.has(s.toLowerCase()) && new RegExp(`(^|[^\\w.-])${escape(s)}($|[^\\w-])`, "i").test(v);

/** What about a value keeps it from working on another Mac, if anything.
 *  `command` is checked as a command line, where ./x is inside its repo. */
export function whyAsk(name: string, value: string, machine?: Machine, command = false): Why | null {
  const v = value.trim();
  if (!v) return null;
  if (HOME_PATH.test(v) || (machine && [machine.home, machine.user, machine.host].some((s) => mentions(v, s)))) return "machine";
  if (!command && (SECRET_NAME.test(name) || SECRET_VALUE.some((r) => r.test(v)))) return "secret";
  if (command && SECRET_VALUE.some((r) => v.split(/\s+/).some((w) => r.test(w)))) return "secret";
  if (ABS_PATH.test(v)) return "path";
  if (!command && REL_PATH.test(v)) return "path";
  if (LAN.test(v)) return "address";
  return null;
}

// ---------------------------------------------------------------------------
// Export: a draft the person reviews, then the file

/** A value that may not travel: the exporter chooses to share it or have it
 *  asked for, unless it names this Mac, which is always asked for */
export type Entry = {
  /** "api.JWT_SECRET", or "web.command" */
  key: string;
  service: string;
  name: string;
  value: string;
  why: Why | null;
  locked: boolean;
  share: boolean;
};

/** `local`: an image only built on this Mac, which the dialog asks about where it lists the service */
export type Note = { service?: string; text: string; local?: boolean };

/** The folder that builds an image (with its Dockerfile when it isn't ./Dockerfile) */
export type BuildFrom = { folder: string; dockerfile?: string };

/** A service run from an image, which the exporter can have built from a folder instead */
export type ImageService = { service: string; image: string; local: boolean; build: BuildFrom | null };

export type Draft = {
  network: string;
  repos: Record<string, Repo>;
  /** With every value as it is here; `fileOf` applies the entries */
  services: Record<string, SharedService>;
  entries: Entry[];
  notes: Note[];
  images: ImageService[];
};

const portOut = (p: PortInfo) => (p.host ? `${p.host}:${p.container}` : `${p.container}`);
const splitEnv = (line: string): [string, string] => {
  const i = line.indexOf("=");
  return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
};
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "folder";

/** Names repos by their repo name (`rides-api`), with the owner when two
 *  share one, and folders outside git by the folder's name */
function nameRepos(found: { key: string; git: GitInfo | null; folder: string }[]) {
  const byKey = new Map<string, { name: string; repo: Repo; root: string }>();
  const used = new Set<string>();
  const unique = (raw: string) => {
    const base = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|-+$/g, "") || "repo";
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}-${i}`;
    used.add(n);
    return n;
  };
  // Every repo id's last part, to see which names clash
  const ids = [...new Set(found.map((f) => f.git?.repo).filter((r): r is string => !!r))];
  const last = (id: string) => id.split("/").pop()!;
  const clash = (id: string) => ids.filter((x) => last(x) === last(id)).length > 1;
  for (const f of found) {
    const id = f.git?.repo ?? null;
    const root = f.git ? f.git.root : f.folder;
    const existing = [...byKey.values()].find((r) => (id ? r.repo.git === id : r.root === root && !r.repo.git));
    if (existing) {
      byKey.set(f.key, existing);
      continue;
    }
    const parts = id?.split("/") ?? [];
    const name = unique(id ? (clash(id) ? parts.slice(-2).join("-") : last(id)) : baseName(root));
    const repo: Repo = id ? { git: id, ...(f.git?.url && { clone: f.git.url }) } : { git: null };
    byKey.set(f.key, { name, repo, root });
  }
  return byKey;
}

/** Inside the repo, from where the service's folder is in it */
const inside = (git: GitInfo | null) => (git?.path ? git.path.replace(/\\/g, "/") : undefined);

/** `builds`: services run from an image that the exporter chose to have
 *  built from a folder instead, as if they'd been added from it */
export function draftOf(
  snap: Snapshot,
  commands: ProcessInfo[],
  git: Record<string, GitInfo | null>,
  builds: Record<string, BuildFrom> = {},
): Draft {
  const machine = snap.machine;
  const services: Record<string, SharedService> = {};
  const entries: Entry[] = [];
  const notes: Note[] = [];
  const images: ImageService[] = snap.containers
    .filter((c) => c.kind === "image")
    .map((c) => ({ service: c.name, image: c.image, local: c.imageLocal, build: builds[c.name] ?? null }));
  const containers = snap.containers.map((c) => {
    const b = c.kind === "image" ? builds[c.name] : undefined;
    return b ? { ...c, kind: "dockerfile" as const, context: b.folder, dockerfile: b.dockerfile ?? null, imageLocal: false } : c;
  });
  const folders = [
    ...containers.filter((c) => c.kind === "dockerfile" && c.context).map((c) => c.context!),
    ...commands.map((p) => p.cwd),
  ];
  const repos = nameRepos(folders.map((f) => ({ key: f, git: git[f] ?? null, folder: f })));

  const entry = (service: string, name: string, value: string, command = false) => {
    const why = whyAsk(name, value, machine, command);
    entries.push({
      key: `${service}.${name}`,
      service,
      name,
      value,
      why,
      locked: why === "machine",
      share: why === null,
    });
  };
  const envOf = (service: string, lines: string[]) => {
    if (!lines.length) return undefined;
    const env: Record<string, Value> = {};
    for (const line of lines) {
      const [k, v] = splitEnv(line);
      if (!k) continue;
      env[k] = v;
      entry(service, k, v);
    }
    return env;
  };
  const where = (folder: string) => {
    const r = repos.get(folder)!;
    if (!r.repo.git) notes.push({ text: `${r.name} isn't in a git repo with a remote: each person chooses its folder.` });
    // A folder outside git is the repo itself; one in a repo without a remote is its folder inside the clone
    const g = git[folder];
    return { repo: r.name, ...(g && inside(g) && { path: inside(g) }) };
  };

  for (const c of containers) {
    const s: SharedService = {};
    if (c.kind === "dockerfile" && c.context) {
      s.build = { ...where(c.context), ...(c.dockerfile && c.dockerfile !== "Dockerfile" && { dockerfile: c.dockerfile }) };
    } else if (c.kind === "attached") {
      s.attached = { image: c.image, ...(c.containerName && { container: c.containerName }) };
      notes.push({ service: c.name, text: `${c.name} was started outside UAT: on import, each person runs its image or attaches theirs.` });
    } else {
      s.image = c.image;
      if (c.imageLocal) {
        s.local = true;
        notes.push({
          service: c.name,
          local: true,
          text: `${c.image} was only built on this Mac, so others can't pull it: give the folder that builds it, or import asks how to get it.`,
        });
      }
    }
    if (c.ports.length) s.ports = c.ports.map(portOut);
    if (c.kind !== "attached") {
      const env = envOf(c.name, c.env);
      if (env) s.env = env;
    }
    if (c.dependsOn.length) s.dependsOn = c.dependsOn;
    services[c.name] = s;
  }
  for (const p of commands) {
    const s: SharedService = { run: { ...where(p.cwd), command: p.command } };
    entry(p.name, "command", p.command, true);
    if (p.ports.length) s.ports = p.ports.map(String);
    const env = envOf(p.name, p.env);
    if (env) s.env = env;
    if (p.dependsOn.length) s.dependsOn = p.dependsOn;
    services[p.name] = s;
  }
  // Each repo said once
  const seen = new Set<string>();
  const unique = notes.filter((n) => !seen.has(n.text) && seen.add(n.text));
  const byName: Record<string, Repo> = {};
  for (const r of repos.values()) byName[r.name] = r.repo;
  return { network: snap.network, repos: byName, services: sorted(services), entries, notes: unique, images };
}

const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** The file, with each value shared or asked for as the entries say */
export function fileOf(draft: Draft): NetworkFile {
  const asks = new Map(draft.entries.filter((e) => !e.share || e.locked).map((e) => [e.key, e]));
  const valueOf = (key: string, value: Value): Value => {
    const e = asks.get(key);
    if (!e || typeof value !== "string") return value;
    // Only a path, or a value the exporter chose to ask for, is suggested:
    // not what's secret or names this Mac or its network
    const keep = e.why === "path" || e.why === null;
    return {
      ask: e.why ? WHY[e.why] : "Set on import",
      ...(keep && value && { default: value }),
      ...(e.why === "secret" && { secret: true }),
    };
  };
  const services: Record<string, SharedService> = {};
  for (const [name, s] of Object.entries(draft.services)) {
    const out: SharedService = structuredClone(s);
    if (out.run) out.run.command = valueOf(`${name}.command`, out.run.command);
    if (out.env) out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, valueOf(`${name}.${k}`, v)]));
    services[name] = out;
  }
  return { uat: FORMAT, kind: "network", name: draft.network, repos: draft.repos, services };
}

export const fileText = (f: NetworkFile) => JSON.stringify(f, null, 2) + "\n";

// ---------------------------------------------------------------------------
// Reading a file

const NAME = /^[a-z0-9][a-z0-9_.-]*$/;
const PORT = /^(?:(\d{1,5}):)?(\d{1,5})(?:\/tcp)?$/;

export function parsePort(s: string): { container: number; host: number | null } | null {
  const m = String(s).trim().match(PORT);
  if (!m) return null;
  const host = m[1] ? Number(m[1]) : null;
  const container = Number(m[2]);
  const ok = (n: number) => n >= 1 && n <= 65535;
  return ok(container) && (host === null || ok(host)) ? { container, host } : null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isAsk = (v: unknown): v is Ask => isObj(v) && typeof v.ask === "string";

/** The file, or an error saying what's wrong with it and where */
export function parseFile(text: string): NetworkFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`It isn't JSON: ${(e as Error).message}`);
  }
  if (!isObj(raw) || raw.kind !== "network" || typeof raw.uat !== "number") {
    throw new Error("It isn't a UAT network file: it needs \"uat\": 1 and \"kind\": \"network\".");
  }
  if (raw.uat > FORMAT) throw new Error(`It's from a newer UAT (format ${raw.uat}). Update UAT to import it.`);
  const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
  if (!NAME.test(name)) throw new Error(`"name" should be a network name, like rides.`);
  const repos = raw.repos ?? {};
  if (!isObj(repos)) throw new Error(`"repos" should be an object of repos by name.`);
  for (const [k, r] of Object.entries(repos)) {
    if (!isObj(r) || !(r.git === null || typeof r.git === "string")) {
      throw new Error(`Repo ${k} needs "git": its repo, like github.com/team/${k}, or null for a folder outside git.`);
    }
    if (r.clone !== undefined && typeof r.clone !== "string") throw new Error(`Repo ${k}'s "clone" should be a URL.`);
  }
  if (!isObj(raw.services)) throw new Error(`"services" should be an object of services by name.`);
  const names = Object.keys(raw.services);
  for (const [k, s] of Object.entries(raw.services)) {
    const where = `Service ${k}`;
    if (!NAME.test(k)) throw new Error(`${where}: names use a-z, 0-9, - _ . and start with a letter or digit.`);
    if (!isObj(s)) throw new Error(`${where} should be an object.`);
    const kinds = (["build", "image", "run", "attached"] as const).filter((x) => s[x] !== undefined);
    if (kinds.length !== 1) throw new Error(`${where} needs one of build, image, run or attached.`);
    for (const x of ["build", "run"] as const) {
      const v = s[x];
      if (v === undefined) continue;
      if (!isObj(v) || typeof v.repo !== "string") throw new Error(`${where}: ${x} needs "repo".`);
      if (!(v.repo in repos)) throw new Error(`${where} comes from ${v.repo}, which isn't in "repos".`);
      if (v.path !== undefined && (typeof v.path !== "string" || /^([\\/]|~|[A-Za-z]:)|(^|[\\/])\.\.([\\/]|$)/.test(v.path))) {
        throw new Error(`${where}: "path" should be a folder inside the repo, like services/api.`);
      }
    }
    if (s.build !== undefined && isObj(s.build) && s.build.dockerfile !== undefined && typeof s.build.dockerfile !== "string") {
      throw new Error(`${where}: "dockerfile" should be its path inside the folder.`);
    }
    if (s.run !== undefined && isObj(s.run) && !(typeof s.run.command === "string" || isAsk(s.run.command))) {
      throw new Error(`${where}: run needs "command".`);
    }
    if (s.image !== undefined && (typeof s.image !== "string" || !s.image.trim())) throw new Error(`${where}: "image" should name one.`);
    if (s.local !== undefined && (typeof s.local !== "boolean" || s.image === undefined)) {
      throw new Error(`${where}: "local" goes with "image", as true or false.`);
    }
    if (s.attached !== undefined && (!isObj(s.attached) || typeof s.attached.image !== "string")) {
      throw new Error(`${where}: attached needs "image".`);
    }
    if (s.ports !== undefined) {
      if (!Array.isArray(s.ports)) throw new Error(`${where}: "ports" should be a list, like ["3000"].`);
      for (const p of s.ports) if (!parsePort(String(p))) throw new Error(`${where}: "${p}" isn't a port. Use 3000 or 8080:3000.`);
    }
    if (s.env !== undefined) {
      if (!isObj(s.env)) throw new Error(`${where}: "env" should be an object of values by name.`);
      for (const [n, v] of Object.entries(s.env)) {
        if (typeof v !== "string" && !isAsk(v)) throw new Error(`${where}: ${n} should be a string, or { "ask": "why" }.`);
      }
    }
    if (s.dependsOn !== undefined) {
      if (!Array.isArray(s.dependsOn) || s.dependsOn.some((d) => typeof d !== "string")) {
        throw new Error(`${where}: "dependsOn" should be a list of service names.`);
      }
      const unknown = s.dependsOn.filter((d) => !names.includes(d as string));
      if (unknown.length) throw new Error(`${where} depends on ${unknown.join(", ")}, which isn't in the file.`);
    }
  }
  return { uat: raw.uat, kind: "network", name, repos: repos as NetworkFile["repos"], services: raw.services as NetworkFile["services"] };
}

// ---------------------------------------------------------------------------
// Import: what to ask, then what to do

export type Question =
  | { kind: "repo"; key: string; repo: Repo; services: string[] }
  | { kind: "value"; key: string; service: string; name: string; why: string; default?: string; secret: boolean }
  | { kind: "port"; key: string; service: string; container: number; host: number; suggest: number }
  | { kind: "attached"; key: string; service: string; image: string; container?: string }
  | { kind: "image"; key: string; service: string; image: string; here: boolean };

export type AttachChoice = "run" | "skip" | { container: string };
/** For an image built on the exporter's Mac: the one here, built from a folder, or none */
export type ImageChoice = "use" | "skip" | BuildFrom;

export type Answers = {
  network?: string;
  /** Repo name → its folder here */
  repos?: Record<string, string>;
  /** "api.JWT_SECRET" or "web.command" → the value */
  values?: Record<string, string>;
  /** "api:3000" → the port to publish it on here, or null for none */
  ports?: Record<string, number | null>;
  attached?: Record<string, AttachChoice>;
  images?: Record<string, ImageChoice>;
};

/** This Mac, for the questions: host ports in use, services the network
 *  already has (which are left as they are), and which of the file's local
 *  images it has */
export type Here = { inUse: number[]; existing: string[]; images?: string[] };

/** A value someone else's Mac put in a file by hand */
const foreign = (v: string) => HOME_PATH.test(v);

/** What may not work here though nothing's asked: a command listens on its
 *  own port, so one in use can't be moved */
export function warnings(file: NetworkFile, here: Here): Note[] {
  const out: Note[] = [];
  for (const [name, s] of Object.entries(file.services)) {
    if (!s.run || here.existing.includes(name)) continue;
    for (const p of s.ports ?? []) {
      const port = parsePort(p)?.container;
      if (port && here.inUse.includes(port)) out.push({ service: name, text: `Port ${port} is in use here: ${name} may not start until it's free.` });
    }
  }
  return out;
}

/** Host ports the file wants, to check here */
export function portsOf(file: NetworkFile): number[] {
  const out = new Set<number>();
  for (const s of Object.values(file.services)) {
    for (const p of s.ports ?? []) {
      const port = parsePort(p);
      if (!port) continue;
      if (s.run) out.add(port.container);
      else if (port.host && !s.attached) out.add(port.host);
    }
  }
  return [...out];
}

export function questions(file: NetworkFile, here: Here): Question[] {
  const out: Question[] = [];
  const todo = Object.entries(file.services).filter(([name]) => !here.existing.includes(name));
  const repos = new Map<string, string[]>();
  const taken = new Set(here.inUse);
  for (const [, s] of Object.entries(file.services)) for (const p of s.ports ?? []) {
    const h = parsePort(p)?.host;
    if (h) taken.add(h);
  }
  const free = (from: number) => {
    let p = from + 1;
    while (taken.has(p) && p < 65535) p++;
    taken.add(p);
    return p;
  };
  const value = (service: string, name: string, v: Value) => {
    const key = `${service}.${name}`;
    if (typeof v !== "string") {
      out.push({ kind: "value", key, service, name, why: v.ask || "Set on import", default: v.default, secret: !!v.secret });
    } else if (foreign(v)) {
      out.push({ kind: "value", key, service, name, why: "A path on someone else's Mac", secret: false });
    }
  };
  for (const [name, s] of todo) {
    const from = s.build?.repo ?? s.run?.repo;
    if (from) repos.set(from, [...(repos.get(from) ?? []), name]);
  }
  for (const [key, services] of repos) out.push({ kind: "repo", key, repo: file.repos[key], services });
  for (const [name, s] of todo) {
    if (s.image && s.local) out.push({ kind: "image", key: name, service: name, image: s.image, here: !!here.images?.includes(s.image) });
  }
  for (const [name, s] of todo) {
    if (s.attached) out.push({ kind: "attached", key: name, service: name, image: s.attached.image, container: s.attached.container });
    if (s.run) value(name, "command", s.run.command);
    for (const [k, v] of Object.entries(s.env ?? {})) value(name, k, v);
    if (s.attached) continue;
    for (const p of s.ports ?? []) {
      const port = parsePort(p);
      if (port?.host && here.inUse.includes(port.host)) {
        out.push({ kind: "port", key: `${name}:${port.container}`, service: name, container: port.container, host: port.host, suggest: free(port.host) });
      }
    }
  }
  return out;
}

const answered = (q: Question, a: Answers): boolean => {
  switch (q.kind) {
    case "repo":
      return !!a.repos?.[q.key]?.trim();
    case "value":
      return a.values?.[q.key] !== undefined;
    case "port":
      return a.ports?.[q.key] !== undefined;
    case "attached": {
      const c = a.attached?.[q.key];
      return c === "run" || c === "skip" || (typeof c === "object" && !!c.container.trim());
    }
    case "image": {
      const c = a.images?.[q.key];
      return c === "use" || c === "skip" || (typeof c === "object" && !!c.folder.trim());
    }
  }
};

/** Services the answers leave out */
const skipped = (a: Answers) =>
  new Set([...Object.entries(a.attached ?? {}), ...Object.entries(a.images ?? {})].filter(([, c]) => c === "skip").map(([k]) => k));

/** The questions that still matter: none about a service that's left out */
export function asked(qs: Question[], answers: Answers): Question[] {
  const out = skipped(answers);
  return qs.filter((q) => q.kind === "attached" || q.kind === "image" || q.kind === "repo" || !out.has(q.service));
}

/** What's still to answer */
export function missing(file: NetworkFile, here: Here, answers: Answers): Question[] {
  return asked(questions(file, here), answers).filter((q) => !answered(q, answers));
}

/** Answers with each value's suggestion taken where it has one */
export function withDefaults(qs: Question[], answers: Answers): Answers {
  const values = { ...answers.values };
  const ports = { ...answers.ports };
  const images = { ...answers.images };
  for (const q of qs) {
    if (q.kind === "value" && q.default !== undefined && values[q.key] === undefined) values[q.key] = q.default;
    if (q.kind === "port" && ports[q.key] === undefined) ports[q.key] = q.suggest;
    if (q.kind === "image" && q.here && images[q.key] === undefined) images[q.key] = "use";
  }
  return { ...answers, values, ports, images };
}

export type Step =
  | { kind: "container"; service: string; req: AddServiceRequest }
  | { kind: "command"; service: string; def: NewProcess }
  | { kind: "attach"; service: string; container: string }
  | { kind: "skip"; service: string; why: string };

/** Services before those that depend on them, otherwise in file order */
export function order(services: Record<string, SharedService>): string[] {
  const out: string[] = [];
  const state = new Map<string, "doing" | "done">();
  const visit = (name: string) => {
    if (state.get(name) || !services[name]) return; // A loop: leave it where it is
    state.set(name, "doing");
    for (const d of services[name].dependsOn ?? []) visit(d);
    state.set(name, "done");
    out.push(name);
  };
  Object.keys(services).forEach(visit);
  return out;
}

const join = (folder: string, path?: string) => {
  const base = folder.replace(/[\\/]+$/, "");
  return path ? `${base}/${path.replace(/^[\\/]+/, "")}` : base;
};

/** What to do, in order, once nothing's missing */
export function stepsOf(file: NetworkFile, here: Here, answers: Answers): Step[] {
  const left = missing(file, here, answers);
  if (left.length) throw new Error(`${left.length} question${left.length === 1 ? " is" : "s are"} unanswered.`);
  const network = (answers.network ?? file.name).trim().toLowerCase();
  const val = (service: string, name: string, v: Value) =>
    answers.values?.[`${service}.${name}`] ?? (typeof v === "string" ? v : v.default ?? "");
  const env = (service: string, s: SharedService) =>
    Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${val(service, k, v)}`);
  const ports = (service: string, s: SharedService) =>
    (s.ports ?? []).map((p) => {
      const port = parsePort(p)!;
      const moved = answers.ports?.[`${service}:${port.container}`];
      return { container: port.container, host: moved === undefined ? port.host : moved };
    });

  return order(file.services).map((name): Step => {
    const s = file.services[name];
    if (here.existing.includes(name)) return { kind: "skip", service: name, why: `already on ${network}` };
    const dependsOn = s.dependsOn ?? [];
    if (s.attached) {
      const c = answers.attached![name];
      if (c === "skip") return { kind: "skip", service: name, why: "left out" };
      if (c === "run") {
        // Only on the network: the copy it stands in for may hold its ports here
        const onNetwork = ports(name, s).map((p) => ({ container: p.container, host: null }));
        return { kind: "container", service: name, req: { network, name, source: { kind: "image", image: s.attached.image }, env: [], ports: onNetwork, dependsOn } };
      }
      return { kind: "attach", service: name, container: c.container };
    }
    if (s.image) {
      const c: ImageChoice = s.local ? answers.images![name] : "use";
      if (c === "skip") return { kind: "skip", service: name, why: "left out" };
      const source: AddServiceRequest["source"] =
        c === "use"
          ? { kind: "image", image: s.image }
          : { kind: "dockerfile", context: c.folder.trim(), ...(c.dockerfile && { dockerfile: c.dockerfile }) };
      return { kind: "container", service: name, req: { network, name, source, env: env(name, s), ports: ports(name, s), dependsOn } };
    }
    if (s.build) {
      const context = join(answers.repos![s.build.repo], s.build.path);
      const source = { kind: "dockerfile" as const, context, ...(s.build.dockerfile && { dockerfile: s.build.dockerfile }) };
      return { kind: "container", service: name, req: { network, name, source, env: env(name, s), ports: ports(name, s), dependsOn } };
    }
    const run = s.run!;
    return {
      kind: "command",
      service: name,
      def: {
        network,
        name,
        cwd: join(answers.repos![run.repo], run.path),
        command: val(name, "command", run.command),
        env: env(name, s),
        ports: ports(name, s).map((p) => p.container),
        dependsOn,
      },
    };
  });
}
