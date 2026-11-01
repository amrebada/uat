/** Everything UAT does, as tools an AI agent calls over MCP: networks and
 *  services, Collections' requests and sockets with their traces, flows with
 *  their runs and reports, and the demo. Each runs the same code the window
 *  does, so what an agent changes shows there as it happens. */
import { call, inTauri, message } from "../lib/tauri";
import {
  DEFAULT_NETWORK,
  docker,
  networkRemoved,
  onProgress,
  parsePorts,
  type AddServiceRequest,
  type Service,
} from "../docker/api";
import { forgetProcess, processes, refreshProcesses, type LogLine, type ProcessInfo } from "../docker/processes";
import {
  fileOf,
  fileText,
  missing,
  parseFile,
  questions,
  stepsOf,
  SUFFIX,
  withDefaults,
  type Answers,
  type AttachChoice,
  type BuildFrom,
  type ImageChoice,
} from "../docker/share";
import { checkBuild, draftWith, exportSource, findClones, hereFor, runImport, shareApi } from "../docker/shareRun";
import {
  clone,
  countItems,
  displayName,
  filterTree,
  find,
  insert,
  LABEL_COLORS,
  newItem,
  remove,
  uid,
  update,
  type Group,
  type HttpItem,
  type IoItem,
  type Item,
  type TreeNode,
  type Workspace,
  type WsItem,
} from "../collections/model";
import { changeWorkspace, workspace } from "../collections/store";
import { lastResult, sendHttp, withScheme } from "../collections/send";
import { connectIo, connectWs, disconnect, emitIo, forget, liveOf, sendWs, type LogEntry } from "../collections/live";
import { demoApi, withDemo } from "../collections/demo";
import { beginTrace, knownEntry, traceAfter, traceState, type TraceState } from "../trace/api";
import { flowName, newFlow, stepName, type Flow } from "../flows/model";
import { changeFlows, flowsDoc, forgetRun, isRunning, lastRun, startRun, stopRun } from "../flows/store";
import { flowsApi, traceKey } from "../flows/api";
import { withDemoFlow } from "../flows/demo";
import { report, reportFile, traceMarkdown, type ReportFormat } from "../flows/report";
import type { FlowRun } from "../flows/engine";
import { size } from "../flows/text";
import type { Args, Prop, Tool } from "./registry";
import {
  bodyIn,
  bodyType,
  findFlow,
  findNode,
  findStep,
  flowOut,
  kvIn,
  kvOut,
  methodIn,
  exportText,
  importedText,
  importStepsText,
  planText,
  questionsText,
  removedText,
  stepIn,
  treeText,
} from "./shapes";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const opt = (args: Args, key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : undefined);
/** A folder to build an image from: its path, or { folder, dockerfile } when the Dockerfile isn't ./Dockerfile there */
const buildFrom = (v: unknown, name: string): BuildFrom => {
  if (typeof v === "string" && v.trim()) return { folder: v.trim() };
  const o = v as { folder?: unknown; dockerfile?: unknown } | null;
  if (!o || typeof o !== "object" || typeof o.folder !== "string" || !o.folder.trim() || (o.dockerfile !== undefined && typeof o.dockerfile !== "string")) {
    throw new Error(`${name} should be a folder, or { "folder": "…", "dockerfile": "…" }.`);
  }
  return { folder: o.folder.trim(), ...(o.dockerfile?.trim() && { dockerfile: o.dockerfile.trim() }) };
};
const need = (args: Args, key: string) => {
  const v = opt(args, key);
  if (!v) throw new Error(`${key} is required.`);
  return v;
};

/** How much of a body an answer shows */
const BODY_LIMIT = 30_000;
const clipBody = (s: string) =>
  s.length > BODY_LIMIT ? `${s.slice(0, BODY_LIMIT)}\n… ${s.length - BODY_LIMIT} more characters` : s;

const clock = (at: number) => {
  const d = new Date(at);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${t}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

/** Tells the window something changed that it doesn't watch */
const changed = (what: "networks") => window.dispatchEvent(new Event(`uat:${what}`));

// ---- Arguments many tools take ----

const P = {
  network: { type: "string", description: `The Docker network. ${DEFAULT_NETWORK} when not given.` },
  service: { type: "string", description: "The service's name or id, as list_services shows it." },
  serviceNetwork: {
    type: "string",
    description: "The network the service is on. Needed only when the name is on more than one.",
  },
  item: { type: "string", description: 'An item\'s id, path ("Examples/Get JSON") or name, as list_collections shows it.' },
  group: { type: "string", description: "The group's id, path or name. The top level when not given." },
  labels: { type: "array", items: { type: "string" }, description: "Labels to tag it with, like smoke or realtime." },
  headers: {
    type: ["object", "array"],
    description: 'Headers as { "Name": "value" }, or [{ key, value, enabled }] to keep some off. Replaces them all.',
  },
  body: { type: ["string", "object", "array"], description: "The body: text, or JSON given as an object." },
  bodyType: { type: "string", enum: ["none", "json", "text"], description: "How the body is sent. Worked out from the body when not given." },
  flow: { type: "string", description: "The flow's id or name, as list_flows shows it." },
  secrets: {
    type: "boolean",
    description: "Show values that look secret (Authorization, cookies, tokens, passwords). Hidden when not given.",
  },
} satisfies Record<string, Prop>;

// ---- Networks and services ----

async function networkNames(): Promise<string[]> {
  const nets = await docker.networks();
  return [...new Set([DEFAULT_NETWORK, ...nets.filter((n) => n.managed).map((n) => n.name)])];
}

const listProcesses = () => call<ProcessInfo[]>("process_list");

const portText = (s: Service) =>
  s.ports.map((p) => (p.host ? `${p.host}→${p.container}` : String(p.container))).join(", ");

function serviceLine(s: Service): string {
  const what =
    s.kind === "dockerfile"
      ? `built from ${s.source ?? "a Dockerfile"}`
      : s.kind === "external"
        ? `container ${s.containerName}, attached`
        : `image ${s.image}`;
  return [
    `- ${s.name}`,
    what,
    s.status || s.state,
    s.ports.length && `ports ${portText(s)}`,
    s.dependsOn.length && `needs ${s.dependsOn.join(", ")}`,
    `id ${s.id.slice(0, 12)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function processLine(p: ProcessInfo): string {
  return [
    `- ${p.name}`,
    `command \`${p.command}\` in ${p.cwd}`,
    p.state + (p.pid ? ` (pid ${p.pid})` : p.exitCode !== null ? ` (exit ${p.exitCode})` : ""),
    p.ports.length && `port ${p.ports.join(", ")}`,
    p.dependsOn.length && `needs ${p.dependsOn.join(", ")}`,
    p.networkError && `containers can't reach it: ${p.networkError}`,
    `id ${p.id}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

type Located = { network: string; service?: Service; process?: ProcessInfo };

/** A service by name or id: a container, or a command run on this Mac */
async function locate(ref: string, network?: string): Promise<Located> {
  const r = ref.trim();
  const hits: Located[] = (await listProcesses())
    .filter((p) => (!network || p.network === network) && (p.id === r || same(p.name, r)))
    .map((p) => ({ network: p.network, process: p }));
  const engine = await docker.status();
  if (engine.connected) {
    for (const n of network ? [network] : await networkNames()) {
      const list = await docker.services(n).catch(() => [] as Service[]);
      for (const s of list) {
        if (s.kind === "process") continue;
        if (s.id === r || (r.length >= 6 && s.id.startsWith(r)) || same(s.name, r) || s.containerName === r) {
          hits.push({ network: n, service: s });
        }
      }
    }
  }
  if (hits.length === 1) return hits[0];
  if (!hits.length) {
    const down = engine.connected ? "" : " Docker isn't running, so only commands were looked at.";
    throw new Error(`No service called "${ref}"${network ? ` on ${network}` : ""}.${down} list_services shows what's there.`);
  }
  throw new Error(`"${ref}" is on ${hits.map((h) => h.network).join(" and ")}. Say which with network.`);
}

/** A process once it's done starting or stopping, up to `ms` */
async function settledProcess(id: string, ms = 3000): Promise<ProcessInfo | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const p = (await listProcesses()).find((x) => x.id === id);
    if (!p || (p.state !== "starting" && p.state !== "stopping") || Date.now() > end) return p;
    await sleep(250);
  }
}

const lineText = (l: LogLine) => (l.stream === "err" ? `! ${l.text}` : l.stream === "sys" ? `# ${l.text}` : l.text);

async function processTail(id: string, n: number, find?: string): Promise<string[]> {
  let lines = (await call<LogLine[]>("process_logs", { id })).map(lineText);
  if (find) lines = lines.filter((l) => l.toLowerCase().includes(find.toLowerCase()));
  return lines.slice(-n);
}

/** `["A=1"]` or `{ A: "1" }` → `["A=1"]` */
function envIn(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(String);
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}=${x}`);
}

function portsIn(v: unknown) {
  if (v === undefined) return undefined;
  const text = Array.isArray(v) ? v.join(", ") : String(v);
  const parsed = parsePorts(text);
  if (parsed.error) throw new Error(parsed.error);
  return parsed.ports;
}

const listIn = (v: unknown) => (v === undefined ? undefined : (v as unknown[]).map(String));

async function stateOf(found: Located): Promise<string> {
  if (found.process) {
    const p = await settledProcess(found.process.id);
    if (!p) return `${found.process.name} is gone.`;
    const tail = await processTail(p.id, 15);
    return [processLine(p), "", tail.length ? `Last output:\n${tail.join("\n")}` : "No output yet."].join("\n");
  }
  const s = (await docker.services(found.network)).find((x) => x.id === found.service?.id);
  return s ? serviceLine(s) : `${found.service?.name} is gone from ${found.network}.`;
}

const networkTools: Tool[] = [
  {
    name: "list_networks",
    title: "List networks",
    description:
      "Whether Docker is running, and the Docker networks. Services on one network reach each other by name, like http://rides-api:3000.",
    read: true,
    run: async () => {
      const engine = await docker.status();
      if (!engine.connected) return `Docker isn't running${engine.error ? `: ${engine.error}` : ""}. Start Docker Desktop, OrbStack or Colima.`;
      const nets = await docker.networks();
      const mine = nets.filter((n) => n.managed);
      const others = nets.filter((n) => !n.managed);
      return [
        `Docker ${engine.version ?? ""} at ${engine.socket ?? "?"}`.replace("  ", " "),
        "",
        "UAT's networks:",
        ...(mine.length ? mine.map((n) => `- ${n.name} (${n.driver})`) : [`- none yet; ${DEFAULT_NETWORK} is made with the first service`]),
        ...(others.length ? ["", "Other networks:", ...others.map((n) => `- ${n.name} (${n.driver})`)] : []),
      ].join("\n");
    },
  },
  {
    name: "create_network",
    title: "Create a network",
    description: "Makes a Docker network for services to share. It shows in UAT's sidebar.",
    props: { name: { type: "string", description: "The network's name, like rides-net." } },
    required: ["name"],
    run: async (a) => {
      const name = need(a, "name");
      await docker.createNetwork(name);
      changed("networks");
      return `Created ${name}.`;
    },
  },
  {
    name: "remove_network",
    title: "Remove a network",
    description:
      "Removes a Docker network with what UAT runs on it: containers UAT made there are deleted, commands run as its services are stopped and deleted from UAT, and containers started elsewhere are only disconnected. Unless told not to, it also removes the images and volumes only those containers used; one that another container still uses stays. A volume's data is gone for good, so say what will go first: dry_run lists it without removing anything. UAT's default network, uat-net, is made again, empty.",
    props: {
      network: { type: "string", description: "The network to remove." },
      images: { type: "boolean", description: "Also remove the images only its containers used. Yes when not given." },
      volumes: { type: "boolean", description: "Also remove the volumes only its containers used, with their data. Yes when not given." },
      dry_run: { type: "boolean", description: "Only say what would go and what would stay." },
    },
    required: ["network"],
    destructive: true,
    run: async (a) => {
      const network = need(a, "network");
      const images = a.images !== false;
      const volumes = a.volumes !== false;
      if (a.dry_run === true) return planText(await docker.networkPlan(network), images, volumes);
      const removed = await docker.removeNetwork(network, images, volumes);
      networkRemoved(network);
      return removedText(removed);
    },
  },
  {
    name: "export_network",
    title: "Export a network",
    description:
      "Writes a network to a JSON file to keep in git and share with a team: its services, named by the git repos they come from (github.com/team/rides-api) and the folder inside each, with their images, commands, ports, env and what each needs. Nothing that only works on this Mac goes in: anything naming this Mac or its user (paths in the home folder, the user, the host) is always left out and asked for on import, and so are values that look secret, local paths and local network addresses, unless share names them. Say what's asked for before sharing a file.",
    props: {
      network: P.network,
      file: {
        type: "string",
        description: `Where to write it, like ~/code/team-infra/rides${SUFFIX}, or a folder to write <network>${SUFFIX} in. Only shown when not given.`,
      },
      share: {
        type: "array",
        items: { type: "string" },
        description: 'Values to put in the file though they look secret or local, as "service.NAME" or "service.command".',
      },
      ask: { type: "array", items: { type: "string" }, description: 'Values to leave out and ask for on import, as "service.NAME".' },
      build_from: {
        type: "object",
        description:
          'For an image only built on this Mac, the folder with the Dockerfile that builds it, so the file names its repo and others build it: { "mailer": "~/code/rides-mailer" }, or { "mailer": { "folder": "~/code/rides", "dockerfile": "mailer/Dockerfile" } }. Without it, import asks how to get the image.',
      },
    },
    run: async (a) => {
      const network = opt(a, "network") ?? DEFAULT_NETWORK;
      const src = await exportSource(network);
      const builds: Record<string, BuildFrom> = {};
      if (a.build_from !== undefined && (!a.build_from || typeof a.build_from !== "object" || Array.isArray(a.build_from))) {
        throw new Error("build_from should be an object.");
      }
      for (const [k, v] of Object.entries((a.build_from ?? {}) as Record<string, unknown>)) {
        const c = src.snap.containers.find((c) => c.name === k);
        if (c?.kind !== "image") {
          const images = src.snap.containers.filter((c) => c.kind === "image").map((c) => c.name);
          throw new Error(`${k} isn't a service run from an image on ${network}. Those are: ${images.join(", ") || "none"}.`);
        }
        builds[k] = buildFrom(v, `build_from.${k}`);
        await checkBuild(builds[k]);
      }
      const draft = await draftWith(src, builds);
      if (!Object.keys(draft.services).length) throw new Error(`Nothing runs on ${network}, so there's nothing to export.`);
      const entries = new Map(draft.entries.map((e) => [e.key, e]));
      const choose = (keys: string[] | undefined, share: boolean) => {
        for (const k of keys ?? []) {
          const e = entries.get(k);
          if (!e) throw new Error(`${network} has no value ${k}. Its values: ${[...entries.keys()].join(", ") || "none"}.`);
          if (share && e.locked) throw new Error(`${k} names this Mac or its user, so it's always asked for on import.`);
          e.share = share;
        }
      };
      choose(listIn(a.share), true);
      choose(listIn(a.ask), false);
      const file = fileOf(draft);
      const text = fileText(file);
      const to = opt(a, "file");
      const written = to ? await shareApi.write(/\.json$/i.test(to) ? to : `${to.replace(/\/+$/, "")}/${network}${SUFFIX}`, text) : null;
      return exportText(draft, file, text, written);
    },
  },
  {
    name: "import_network",
    title: "Import a network",
    description:
      "Adds what a network file from export_network describes to a network here, in dependency order: builds and pulls containers, adds commands (stopped), and attaches containers. First it needs what only this Mac knows: where each repo is (clones are found by their git remote when they're in the usual code folders; clone_into clones the missing ones), values the file leaves out, another port where one is taken here, what to do with containers started outside UAT, and how to get images only built on the exporter's Mac. Until it has them it adds nothing and lists what's needed and which argument answers each; ask the person for values rather than making them up. Services the network already has are left as they are. Building and pulling can take minutes; this waits.",
    props: {
      file: { type: "string", description: `The file, like ~/code/team-infra/rides${SUFFIX}.` },
      text: { type: "string", description: "The file's JSON, instead of file." },
      network: { type: "string", description: "The network to add it to. The name in the file when not given." },
      folders: { type: "object", description: 'Where each repo is on this Mac, by the name the file gives it: { "rides-api": "~/code/rides-api" }.' },
      clone_into: { type: "string", description: "A folder to git clone the repos that aren't found here into, like ~/code." },
      values: {
        type: "object",
        description: 'Values by "service.NAME" (or "service.command"): the ones the file asks for, or any to change: { "rides-api.JWT_SECRET": "…" }.',
      },
      ports: { type: "object", description: 'For each host port taken here, by "service:port": another, or null to not publish it. { "rides-api:3000": 3001 }' },
      attached: {
        type: "object",
        description: 'For each container that was started outside UAT: "run" its image, "skip" it, or the name of a container running here to attach.',
      },
      images: {
        type: "object",
        description:
          'For each image only built on the exporter\'s Mac: "use" it when this Mac has it too, "skip" to leave the service out, or the folder with the Dockerfile that builds it (a path, or { "folder": "…", "dockerfile": "…" }).',
      },
      use_defaults: { type: "boolean", description: "Take the file's suggested values and free ports for what isn't answered." },
      dry_run: { type: "boolean", description: "Only say what it would do, or what it still needs." },
    },
    open: true,
    run: async (a) => {
      const path = opt(a, "file");
      const raw = typeof a.text === "string" && a.text.trim() ? a.text : path ? await shareApi.read(path) : undefined;
      if (!raw) throw new Error("Give file, or the file's JSON as text.");
      const file = parseFile(raw);
      const network = (opt(a, "network") ?? file.name).toLowerCase();
      const here = await hereFor(file, network);
      const dry = a.dry_run === true;
      const record = (v: unknown, name: string): Record<string, unknown> => {
        if (v === undefined) return {};
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} should be an object.`);
        return v as Record<string, unknown>;
      };

      const repos = Object.fromEntries(Object.entries(record(a.folders, "folders")).map(([k, v]) => [k, String(v)]));
      const unknownRepo = Object.keys(repos).filter((k) => !(k in file.repos));
      if (unknownRepo.length) throw new Error(`The file has no repo ${unknownRepo.join(", ")}. Its repos: ${Object.keys(file.repos).join(", ") || "none"}.`);
      const found = await findClones(file);
      const notes: string[] = [];
      const repoQs = questions(file, here).filter((q) => q.kind === "repo");
      for (const q of repoQs) {
        const clone = found[q.key]?.clones[0];
        if (!repos[q.key] && clone) {
          repos[q.key] = clone;
          notes.push(`found ${q.key} at ${clone}`);
        }
      }
      const into = opt(a, "clone_into");
      for (const q of into ? repoQs : []) {
        if (repos[q.key] || !q.repo.clone) continue;
        if (dry) {
          repos[q.key] = `${into!.replace(/\/+$/, "")}/${q.repo.git!.split("/").pop()}`;
          notes.push(`would clone ${q.key} into ${repos[q.key]}`);
        } else {
          repos[q.key] = await shareApi.clone(q.repo.clone, into!);
          notes.push(`cloned ${q.key} into ${repos[q.key]}`);
        }
      }

      const values = Object.fromEntries(Object.entries(record(a.values, "values")).map(([k, v]) => [k, String(v)]));
      for (const k of Object.keys(values)) {
        const [service, ...rest] = k.split(".");
        const name = rest.join(".");
        const s = file.services[service];
        if (!s || !(name === "command" ? s.run : s.env && name in s.env)) {
          throw new Error(`${k} isn't a value in the file. Use "service.NAME", like rides-api.JWT_SECRET.`);
        }
      }
      const ports: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(record(a.ports, "ports"))) {
        if (v !== null && !(Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536)) throw new Error(`ports.${k} should be a port, or null.`);
        ports[k] = v as number | null;
      }
      const attached: Record<string, AttachChoice> = {};
      for (const [k, v] of Object.entries(record(a.attached, "attached"))) {
        if (!file.services[k]?.attached) throw new Error(`${k} wasn't started outside UAT in the file.`);
        const c = String(v).trim();
        attached[k] = c === "run" || c === "skip" ? c : { container: c };
      }
      const images: Record<string, ImageChoice> = {};
      for (const [k, v] of Object.entries(record(a.images, "images"))) {
        const s = file.services[k];
        if (!s?.image || !s.local) throw new Error(`${k} isn't an image built on the exporter's Mac in the file.`);
        if (v === "use" || v === "skip") {
          if (v === "use" && !here.images?.includes(s.image)) {
            throw new Error(`This Mac doesn't have ${s.image}: give images.${k} the folder that builds it, or "skip".`);
          }
          images[k] = v;
        } else {
          images[k] = buildFrom(v, `images.${k}`);
          await checkBuild(images[k] as BuildFrom);
        }
      }

      let answers: Answers = { network, repos, values, ports, attached, images };
      if (a.use_defaults === true) answers = withDefaults(questions(file, here), answers);
      const left = missing(file, here, answers);
      const said = notes.length ? `\n\nSo far:\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
      if (left.length) return questionsText(left, found, network) + said;
      if (dry) return importStepsText(stepsOf(file, here, answers), network) + said;
      const result = await runImport(file, here, answers);
      changed("networks");
      return importedText(result, notes);
    },
  },
  {
    name: "list_services",
    title: "List services",
    description:
      "The services on a network, or on every one of UAT's: containers (from an image or a Dockerfile, or attached) and commands run on this Mac, with their state, ports and what each needs.",
    props: { network: { type: "string", description: "Only this network. Every one of UAT's when not given." } },
    read: true,
    run: async (a) => {
      const engine = await docker.status();
      const procs = await listProcesses();
      const nets = opt(a, "network") ? [opt(a, "network")!] : engine.connected ? await networkNames() : [...new Set(procs.map((p) => p.network))];
      const out: string[] = engine.connected ? [] : ["Docker isn't running: only commands are listed.", ""];
      for (const n of nets) {
        const services = engine.connected ? (await docker.services(n).catch(() => [] as Service[])).filter((s) => s.kind !== "process") : [];
        const mine = procs.filter((p) => p.network === n);
        out.push(`${n}:`);
        if (!services.length && !mine.length) out.push("- nothing yet");
        out.push(...services.map(serviceLine), ...mine.map(processLine), "");
      }
      return out.join("\n").trim();
    },
  },
  {
    name: "list_containers",
    title: "List other containers",
    description: "Containers running on this Mac that aren't on the network, which attach_container can put on it.",
    props: { network: P.network },
    read: true,
    run: async (a) => {
      const network = opt(a, "network") ?? DEFAULT_NETWORK;
      const list = await docker.otherContainers(network);
      if (!list.length) return `Every container is on ${network} already, or there are none.`;
      return list.map((s) => `- ${s.containerName} · image ${s.image} · ${s.status || s.state} · id ${s.id.slice(0, 12)}`).join("\n");
    },
  },
  {
    name: "inspect_folder",
    title: "Inspect a folder",
    description:
      "What UAT finds in a repo before adding it as a service: its Dockerfile (base image, exposed ports) and the commands it can run (npm scripts and the like) with the ports they use.",
    props: {
      folder: { type: "string", description: "The repo's folder, like ~/code/rides-api." },
      dockerfile: { type: "string", description: "The Dockerfile's path inside it, when it isn't ./Dockerfile." },
    },
    required: ["folder"],
    read: true,
    run: async (a) => {
      const folder = need(a, "folder");
      const [file, cmds] = await Promise.all([
        docker.inspectDockerfile(folder, opt(a, "dockerfile")).catch((e) => ({ error: message(e) })),
        processes.inspectFolder(folder).catch((e) => ({ error: message(e) })),
      ]);
      return { dockerfile: file, commands: cmds };
    },
  },
  {
    name: "add_service",
    title: "Add a service",
    description:
      "Puts a service on a network. Give one of: image (a Docker image to pull and run), build (a repo folder with a Dockerfile to build and run), or command (something to run on this Mac, like npm run dev, in folder). Containers reach a command by its name, as if it were a container. Building or pulling can take minutes; this waits.",
    props: {
      network: P.network,
      name: { type: "string", description: "What others on the network call it. From the folder or image when not given." },
      image: { type: "string", description: "A Docker image, like postgres:16." },
      build: { type: "string", description: "A folder with a Dockerfile to build, like ~/code/rides-api." },
      dockerfile: { type: "string", description: "With build: the Dockerfile's path inside the folder, when not ./Dockerfile." },
      command: { type: "string", description: "A command to run on this Mac, like npm run dev." },
      folder: { type: "string", description: "With command: the folder to run it in." },
      env: { type: ["object", "array"], description: 'Environment: { "NAME": "value" } or ["NAME=value"].' },
      ports: {
        type: ["string", "array"],
        description:
          'Ports it listens on: "3000", or "8080:3000" to also publish 3000 as localhost:8080 (containers only). From the Dockerfile or folder when not given.',
      },
      depends_on: { type: "array", items: { type: "string" }, description: "Services to start before it." },
    },
    open: true,
    run: async (a) => {
      const network = opt(a, "network") ?? DEFAULT_NETWORK;
      const image = opt(a, "image");
      const build = opt(a, "build");
      const command = opt(a, "command");
      if ([image, build, command].filter(Boolean).length !== 1) throw new Error("Give one of image, build or command.");
      const env = envIn(a.env) ?? [];
      const dependsOn = listIn(a.depends_on) ?? [];
      let ports = portsIn(a.ports);
      let name = opt(a, "name")?.toLowerCase();

      if (command) {
        const folder = need(a, "folder");
        const found = await processes.inspectFolder(folder);
        if (!found.exists) throw new Error(`${folder} doesn't exist.`);
        if (ports?.some((p) => p.host !== null)) throw new Error("A command already runs on this Mac: give the port it listens on, like 3000.");
        name ||= found.suggestedName;
        const p = await processes.create({
          network,
          name,
          cwd: folder,
          command,
          env,
          ports: ports ? ports.map((x) => x.container) : found.ports,
          dependsOn,
        });
        await refreshProcesses();
        return `Added ${p.name} to ${network}.\n\n${await stateOf({ network, process: p })}`;
      }

      let source: AddServiceRequest["source"];
      if (build) {
        const file = await docker.inspectDockerfile(build, opt(a, "dockerfile"));
        if (!file.found) throw new Error(`No Dockerfile at ${file.dockerfile || build}.`);
        name ||= file.suggestedName;
        ports ??= file.exposes.map((container) => ({ container, host: null }));
        source = { kind: "dockerfile", context: build, ...(opt(a, "dockerfile") && { dockerfile: opt(a, "dockerfile") }) };
      } else {
        name ||= image!.split("/").pop()!.split(/[:@]/)[0];
        source = { kind: "image", image: image! };
      }
      const lines: string[] = [];
      const off = await onProgress((p) => p.service === name && lines.push(p.line));
      try {
        const s = await docker.addService({ network, name, source, env, ports: ports ?? [], dependsOn });
        return `Added ${s.name} to ${network}.\n${serviceLine(s)}`;
      } catch (e) {
        throw new Error([message(e), ...(lines.length ? ["", "Last output:", ...lines.slice(-25)] : [])].join("\n"));
      } finally {
        off();
      }
    },
  },
  {
    name: "attach_container",
    title: "Attach a container",
    description: "Puts a container that's already running (from list_containers) on a network, under a name the others use to reach it.",
    props: {
      container: { type: "string", description: "The container's name or id." },
      network: P.network,
      alias: { type: "string", description: "The name others on the network use. The container's own when not given." },
    },
    required: ["container"],
    run: async (a) => {
      const network = opt(a, "network") ?? DEFAULT_NETWORK;
      const container = need(a, "container");
      await docker.attach(container, network, opt(a, "alias") ?? container);
      return `Attached ${container} to ${network}${opt(a, "alias") ? ` as ${opt(a, "alias")}` : ""}.`;
    },
  },
  {
    name: "update_service",
    title: "Change a command service",
    description:
      "Changes a service that runs a command on this Mac: its command, folder, environment, ports or what it needs. It restarts if it was running. Containers can't be changed: remove and add them again.",
    props: {
      service: P.service,
      network: P.serviceNetwork,
      command: { type: "string", description: "The command to run." },
      folder: { type: "string", description: "The folder to run it in." },
      env: { type: ["object", "array"], description: 'Environment, replacing it all: { "NAME": "value" } or ["NAME=value"].' },
      ports: { type: ["string", "array"], description: 'The ports it listens on, like "3000, 9229".' },
      depends_on: { type: "array", items: { type: "string" }, description: "Services to start before it." },
    },
    required: ["service"],
    open: true,
    run: async (a) => {
      const found = await locate(need(a, "service"), opt(a, "network"));
      const p = found.process;
      if (!p) throw new Error(`${found.service?.name} is a container. Containers can't be changed: remove it and add it again.`);
      const ports = portsIn(a.ports);
      if (ports?.some((x) => x.host !== null)) throw new Error("Give the port the command listens on, like 3000.");
      await processes.update(p.id, {
        ...(opt(a, "command") && { command: opt(a, "command") }),
        ...(opt(a, "folder") && { cwd: opt(a, "folder") }),
        ...(a.env !== undefined && { env: envIn(a.env) }),
        ...(ports && { ports: ports.map((x) => x.container) }),
        ...(a.depends_on !== undefined && { dependsOn: listIn(a.depends_on) }),
      });
      const active = p.state === "running" || p.state === "starting";
      if (active) await processes.restart(p.id);
      return `${active ? "Changed and restarted" : "Changed"} ${p.name}.\n\n${await stateOf(found)}`;
    },
  },
  ...(["start", "stop", "restart"] as const).map(
    (verb): Tool => ({
      name: `${verb}_service`,
      title: `${verb[0].toUpperCase()}${verb.slice(1)} a service`,
      description: `${verb[0].toUpperCase()}${verb.slice(1)}s a service: a container, or a command run on this Mac. Returns its state${verb === "stop" ? "" : " and its first output"}.`,
      props: { service: P.service, network: P.serviceNetwork },
      required: ["service"],
      open: verb !== "stop",
      run: async (a) => {
        const found = await locate(need(a, "service"), opt(a, "network"));
        if (found.process) {
          await processes[verb](found.process.id);
        } else {
          const id = found.service!.id;
          if (verb !== "start") await docker.stop(id);
          if (verb !== "stop") await docker.start(id);
        }
        return stateOf(found);
      },
    }),
  ),
  {
    name: "remove_service",
    title: "Remove a service",
    description:
      "Takes a service off its network. A container UAT made is stopped and deleted (its image stays); an attached one is only disconnected; a command is stopped and forgotten (its folder is left alone).",
    props: { service: P.service, network: P.serviceNetwork },
    required: ["service"],
    destructive: true,
    run: async (a) => {
      const found = await locate(need(a, "service"), opt(a, "network"));
      if (found.process) {
        await processes.remove(found.process.id);
        forgetProcess(found.process.id);
        return `Removed ${found.process.name} from ${found.network}.`;
      }
      const s = found.service!;
      await docker.remove(s.id, found.network);
      return s.managed ? `Removed ${s.name} from ${found.network}.` : `Disconnected ${s.name} from ${found.network}.`;
    },
  },
  {
    name: "service_logs",
    title: "Read a service's logs",
    description: "A service's latest output: a container's logs, or a command's output (! marks stderr, # UAT's own lines).",
    props: {
      service: P.service,
      network: P.serviceNetwork,
      lines: { type: "integer", description: "How many lines, from the end. 200 when not given." },
      find: { type: "string", description: "Only lines containing this, ignoring case." },
    },
    required: ["service"],
    read: true,
    run: async (a) => {
      const found = await locate(need(a, "service"), opt(a, "network"));
      const n = Math.max(1, Math.min(5000, Number(a.lines ?? 200)));
      const find = opt(a, "find");
      let lines: string[];
      if (found.process) lines = await processTail(found.process.id, n, find);
      else {
        lines = (await docker.logs(found.service!.id, find ? 5000 : n)).split(/\r?\n/);
        if (find) lines = lines.filter((l) => l.toLowerCase().includes(find.toLowerCase()));
        lines = lines.slice(-n);
      }
      const text = lines.join("\n").trim();
      return text || (find ? `No lines contain "${find}".` : "No output yet.");
    },
  },
];

// ---- Collections ----

async function changeTree(fn: (ws: Workspace) => Workspace): Promise<Workspace> {
  await workspace();
  changeWorkspace(fn);
  return workspace();
}

/** New labels get a color, as in the editor */
function withLabels(ws: Workspace, labels: string[]): Workspace {
  const fresh = labels.filter((l) => !ws.labels[l]);
  if (!fresh.length) return ws;
  const n = Object.keys(ws.labels).length;
  return { ...ws, labels: { ...ws.labels, ...Object.fromEntries(fresh.map((l, i) => [l, LABEL_COLORS[(n + i) % LABEL_COLORS.length]])) } };
}

function itemOut(n: Item) {
  const base = { id: n.id, type: n.type, name: n.name, labels: n.labels, url: n.url };
  if (n.type === "http") {
    return { ...base, method: n.method, headers: kvOut(n.headers), body_type: n.bodyType, body: n.body };
  }
  if (n.type === "ws") return { ...base, protocols: n.protocols, message: n.draft };
  return { ...base, path: n.path, auth: n.auth, listen: n.listen, event: n.event, message: n.draft };
}

const LOG_MARK: Record<LogEntry["dir"], string> = { in: "←", out: "→", sys: "·", err: "!" };
const logLine = (e: LogEntry) => `${clock(e.at)} ${LOG_MARK[e.dir]} ${e.event ? `[${e.event}] ` : ""}${e.text}`;

/** A trace once it's read, up to `ms` */
async function settledTrace(key: string, ms = 8000): Promise<TraceState | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const s = traceState(key);
    if (!s || (s.status !== "preparing" && s.status !== "collecting") || Date.now() > end) return s;
    await sleep(150);
  }
}

function traceText(state: TraceState | undefined): string {
  if (state?.status === "ready" || state?.status === "collecting") {
    const o = state.origin;
    return `${o.label} → ${o.outcome}\n\n${traceMarkdown(state)}`;
  }
  return traceMarkdown(state);
}

/** The trace key of a socket's latest connect or message */
const socketTrace = (id: string) => [...liveOf(id).log].reverse().find((e) => e.trace)?.trace;

const httpFields = (a: Args, old: HttpItem): HttpItem => {
  const body = a.body === undefined ? old.body : bodyIn(a.body);
  return {
    ...old,
    name: opt(a, "name") ?? old.name,
    method: a.method === undefined ? old.method : methodIn(a.method),
    url: typeof a.url === "string" ? a.url.trim() : old.url,
    headers: a.headers === undefined ? old.headers : kvIn(a.headers, "headers"),
    body,
    bodyType: (opt(a, "body_type") as HttpItem["bodyType"] | undefined) ?? (a.body === undefined ? old.bodyType : bodyType(body)),
    labels: listIn(a.labels) ?? old.labels,
  };
};

async function socketItem(ref: string): Promise<WsItem | IoItem> {
  return findNode((await workspace()).tree, ref, ["ws", "socketio"]) as WsItem | IoItem;
}

/** Connects `item`, traced as the editor does, and waits for it to open or fail */
async function connect(item: WsItem | IoItem): Promise<{ ok: boolean; outcome: string; key: string }> {
  const key = `${item.id}:connect:${Date.now()}`;
  const traced = await beginTrace(key, item.url);
  const at = Date.now();
  return new Promise((resolve) => {
    const settled = (ok: boolean, outcome: string) => {
      traced({ label: "Connect", outcome, ok, at, end: Date.now() });
      resolve({ ok, outcome, key });
    };
    if (item.type === "ws") connectWs(item, { key, settled });
    else connectIo(item, { key, settled });
    setTimeout(() => resolve({ ok: false, outcome: "No answer in 15 s", key }), 15_000);
  });
}

const collectionTools: Tool[] = [
  {
    name: "list_collections",
    title: "List Collections",
    description:
      "Collections' saved HTTP requests, WebSocket and Socket.IO connections, in their groups, with each one's URL, labels and id.",
    props: { query: { type: "string", description: "Only items whose name, URL or label contains this." } },
    read: true,
    run: async (a) => {
      const ws = await workspace();
      const q = opt(a, "query");
      const tree = q ? filterTree(ws.tree, q) : ws.tree;
      if (!tree.length) return q ? `Nothing matches "${q}".` : "Collections is empty.";
      const items = tree.reduce((n, t) => n + countItems(t), 0);
      const labels = Object.keys(ws.labels);
      return [
        `${plural(items, "item")}${labels.length ? ` · labels: ${labels.join(", ")}` : ""}`,
        "",
        ...treeText(tree),
      ].join("\n");
    },
  },
  {
    name: "get_item",
    title: "Get an item",
    description:
      "One request or connection in full: its URL, headers and body, or its socket settings. A request also shows its last response; a connection, its state and latest messages. A group lists what's in it.",
    props: { item: P.item },
    required: ["item"],
    read: true,
    run: async (a) => {
      const node = findNode((await workspace()).tree, need(a, "item"));
      if (node.type === "group") return [`${displayName(node)}/ · group · id ${node.id}`, ...treeText(node.children, 1)].join("\n");
      const out: Record<string, unknown> = { item: itemOut(node) };
      if (node.type === "http") {
        const r = lastResult(node.id);
        if (r) out.last_response = r.ok ? { status: `${r.status} ${r.statusText}`.trim(), ms: r.ms, size: size(r.size), body: clipBody(r.body) } : { error: r.error, ms: r.ms };
      } else {
        const live = liveOf(node.id);
        out.connection = live.status;
        out.latest = live.log.slice(-20).map(logLine);
      }
      return out;
    },
  },
  {
    name: "save_request",
    title: "Save a request",
    description:
      "Adds an HTTP request to Collections, or changes one when item is given (what you leave out stays as it was).",
    props: {
      item: { type: "string", description: "The request to change. A new one is added when not given." },
      group: { type: "string", description: "Where a new one goes: a group's id, path or name. The top level when not given." },
      name: { type: "string", description: "Its name in the list." },
      method: { type: "string", description: "GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS. GET when not given." },
      url: { type: "string", description: "Where it goes, like http://localhost:3000/rides." },
      headers: P.headers,
      body: P.body,
      body_type: P.bodyType,
      labels: P.labels,
    },
    run: async (a) => {
      const ref = opt(a, "item");
      let saved: HttpItem;
      if (ref) {
        const old = findNode((await workspace()).tree, ref, ["http"]) as HttpItem;
        saved = httpFields(a, old);
        await changeTree((w) => withLabels({ ...w, tree: update(w.tree, old.id, () => saved) }, saved.labels));
      } else {
        if (!opt(a, "url")) throw new Error("url is required for a new request.");
        const parent = opt(a, "group") ? findNode((await workspace()).tree, opt(a, "group")!, "group").id : null;
        saved = httpFields(a, newItem("http") as HttpItem);
        await changeTree((w) => withLabels({ ...w, tree: insert(w.tree, parent, saved) }, saved.labels));
      }
      return { saved: itemOut(saved) };
    },
  },
  {
    name: "save_socket",
    title: "Save a socket connection",
    description:
      "Adds a WebSocket or Socket.IO connection to Collections, or changes one when item is given (what you leave out stays as it was).",
    props: {
      item: { type: "string", description: "The connection to change. A new one is added when not given." },
      kind: { type: "string", enum: ["ws", "socketio"], description: "A new one's kind: ws (WebSocket) or socketio." },
      group: { type: "string", description: "Where a new one goes. The top level when not given." },
      name: { type: "string", description: "Its name in the list." },
      url: { type: "string", description: "ws://localhost:8080/stream, or for Socket.IO http://localhost:3000." },
      protocols: { type: "string", description: "WebSocket: comma-separated subprotocols." },
      path: { type: "string", description: "Socket.IO: the server's path. /socket.io when not given." },
      auth: { type: ["string", "object"], description: "Socket.IO: the handshake's auth, as JSON." },
      listen: { type: "array", items: { type: "string" }, description: "Socket.IO: only show these events. Every event when empty." },
      event: { type: "string", description: "Socket.IO: the event send_socket emits by default." },
      message: { type: ["string", "object", "array"], description: "The message kept ready to send." },
      labels: P.labels,
    },
    run: async (a) => {
      const ref = opt(a, "item");
      const tree = (await workspace()).tree;
      const old = ref
        ? (findNode(tree, ref, ["ws", "socketio"]) as WsItem | IoItem)
        : (newItem((opt(a, "kind") as "ws" | "socketio" | undefined) ?? (/^https?:/i.test(opt(a, "url") ?? "") ? "socketio" : "ws")) as WsItem | IoItem);
      if (!ref && !opt(a, "url")) throw new Error("url is required for a new connection.");
      const common = {
        name: opt(a, "name") ?? old.name,
        url: opt(a, "url") ?? old.url,
        labels: listIn(a.labels) ?? old.labels,
        draft: a.message === undefined ? old.draft : bodyIn(a.message),
      };
      const saved: WsItem | IoItem =
        old.type === "ws"
          ? { ...old, ...common, protocols: opt(a, "protocols") ?? old.protocols }
          : {
              ...old,
              ...common,
              path: opt(a, "path") ?? old.path,
              auth: a.auth === undefined ? old.auth : bodyIn(a.auth),
              listen: listIn(a.listen) ?? old.listen,
              event: opt(a, "event") ?? old.event,
            };
      const parent = !ref && opt(a, "group") ? findNode(tree, opt(a, "group")!, "group").id : null;
      await changeTree((w) =>
        withLabels({ ...w, tree: ref ? update(w.tree, old.id, () => saved) : insert(w.tree, parent, saved) }, saved.labels),
      );
      return { saved: itemOut(saved) };
    },
  },
  {
    name: "save_group",
    title: "Save a group",
    description: "Adds a group to Collections (groups hold requests, connections and other groups), or renames one.",
    props: {
      group: { type: "string", description: "The group to rename. A new one is added when not given." },
      name: { type: "string", description: "Its name." },
      parent: { type: "string", description: "Where a new one goes: another group. The top level when not given." },
    },
    required: ["name"],
    run: async (a) => {
      const name = need(a, "name");
      const tree = (await workspace()).tree;
      const ref = opt(a, "group");
      if (ref) {
        const g = findNode(tree, ref, "group");
        await changeTree((w) => ({ ...w, tree: update(w.tree, g.id, (n) => ({ ...n, name })) }));
        return `Renamed it ${name} (id ${g.id}).`;
      }
      const parent = opt(a, "parent") ? findNode(tree, opt(a, "parent")!, "group").id : null;
      const g: Group = { ...(newItem("group") as Group), name };
      await changeTree((w) => ({ ...w, tree: insert(w.tree, parent, g) }));
      return `Added the group ${name} (id ${g.id}).`;
    },
  },
  {
    name: "move_item",
    title: "Move an item",
    description: "Moves a request, connection or group into another group, or to the top level.",
    props: {
      item: P.item,
      group: { type: "string", description: "The group to move it into. The top level when not given." },
      after: { type: "string", description: "Put it right after this item in that group. Last when not given." },
    },
    required: ["item"],
    run: async (a) => {
      const tree = (await workspace()).tree;
      const node = findNode(tree, need(a, "item"));
      const to = opt(a, "group") ? findNode(tree, opt(a, "group")!, "group") : null;
      if (to && (to.id === node.id || (node.type === "group" && find(node.children, to.id)))) {
        throw new Error("A group can't go inside itself.");
      }
      const after = opt(a, "after") ? findNode(tree, opt(a, "after")!).id : undefined;
      await changeTree((w) => ({ ...w, tree: insert(remove(w.tree, node.id), to?.id ?? null, node, after) }));
      return `Moved ${displayName(node)} to ${to ? displayName(to) : "the top level"}.`;
    },
  },
  {
    name: "duplicate_item",
    title: "Duplicate an item",
    description: "Copies a request, connection or group (with everything in it) right after itself.",
    props: { item: P.item },
    required: ["item"],
    run: async (a) => {
      const tree = (await workspace()).tree;
      const node = findNode(tree, need(a, "item"));
      const copy = clone(node);
      copy.name = `${displayName(node)} copy`;
      const parent = tree.some((n) => n.id === node.id) ? null : (findParent(tree, node.id)?.id ?? null);
      await changeTree((w) => ({ ...w, tree: insert(w.tree, parent, copy, node.id) }));
      return `Made ${copy.name} (id ${copy.id}).`;
    },
  },
  {
    name: "delete_item",
    title: "Delete an item",
    description: "Deletes a request, connection or group from Collections, with everything in a group. Open connections close.",
    props: { item: P.item },
    required: ["item"],
    destructive: true,
    run: async (a) => {
      const node = findNode((await workspace()).tree, need(a, "item"));
      const ids = (function all(n: TreeNode): string[] {
        return n.type === "group" ? n.children.flatMap(all) : [n.id];
      })(node);
      await changeTree((w) => ({ ...w, tree: remove(w.tree, node.id) }));
      forget(ids);
      return `Deleted ${displayName(node)}${node.type === "group" ? ` and the ${plural(ids.length, "item")} in it` : ""}.`;
    },
  },
  {
    name: "send_request",
    title: "Send a request",
    description:
      "Sends a saved request (item), or a one-off one (url, with method, headers and body), and returns the response. When the URL reaches a service on a UAT network, it also returns the call's trace: which service answered, what that service called in turn (and which of those failed), and their logs while it ran.",
    props: {
      item: { type: "string", description: "A saved request's id, path or name." },
      url: { type: "string", description: "A one-off request's URL, instead of item." },
      method: { type: "string", description: "A one-off request's method. GET when not given." },
      headers: { type: ["object", "array"], description: 'A one-off request\'s headers: { "Name": "value" }.' },
      body: P.body,
      body_type: P.bodyType,
      trace: { type: "boolean", description: "Wait for the trace and include it. Yes when not given." },
    },
    open: true,
    run: async (a) => {
      const ref = opt(a, "item");
      let item: HttpItem;
      if (ref) {
        const extra = ["url", "method", "headers", "body", "body_type"].filter((k) => a[k] !== undefined);
        if (extra.length) throw new Error(`With item, the saved request is sent: change it with save_request (not ${extra.join(", ")}).`);
        item = findNode((await workspace()).tree, ref, ["http"]) as HttpItem;
      } else {
        if (!opt(a, "url")) throw new Error("Give item, or url for a one-off request.");
        item = httpFields(a, { ...(newItem("http") as HttpItem), id: `mcp:${uid()}` });
      }
      const r = await sendHttp(item);
      const head = `${item.method} ${withScheme(item.url)}`;
      if (!r.ok) {
        const trace = a.trace === false ? "" : `\n\n${traceText(await settledTrace(item.id))}`;
        return `${head}\nFailed after ${r.ms} ms: ${r.error}${trace}`;
      }
      const out = [
        head,
        `${r.status} ${r.statusText}`.trim() + ` · ${r.ms} ms · ${size(r.size)}`,
        ...r.headers.map(([k, v]) => `${k}: ${v}`),
        "",
        clipBody(r.body) || "(empty body)",
      ];
      if (a.trace !== false) out.push("", traceText(await settledTrace(item.id)));
      return out.join("\n");
    },
  },
  {
    name: "connect_socket",
    title: "Connect a socket",
    description: "Opens a saved WebSocket or Socket.IO connection and waits for it to open or fail. It stays open for send_socket.",
    props: { item: P.item },
    required: ["item"],
    open: true,
    run: async (a) => {
      const item = await socketItem(need(a, "item"));
      if (!item.url.trim()) throw new Error(`${displayName(item)} has no URL.`);
      const { ok, outcome, key } = await connect(item);
      return [
        ok ? `Connected to ${item.url}.` : `Couldn't connect to ${item.url}: ${outcome}`,
        "",
        ...liveOf(item.id).log.slice(-10).map(logLine),
        "",
        traceText(await settledTrace(key, 5000)),
      ].join("\n");
    },
  },
  {
    name: "send_socket",
    title: "Send on a socket",
    description:
      "Sends a message on a WebSocket, or emits an event on Socket.IO, connecting first if needed, then returns what came back in the next moments.",
    props: {
      item: P.item,
      message: { type: ["string", "object", "array"], description: "What to send; JSON given as an object. The item's saved message when not given." },
      event: { type: "string", description: "Socket.IO: the event to emit. The item's event when not given." },
      wait_ms: { type: "integer", description: "How long to collect replies. 1500 when not given." },
    },
    required: ["item"],
    open: true,
    run: async (a) => {
      const item = await socketItem(need(a, "item"));
      if (liveOf(item.id).status !== "open") {
        const c = await connect(item);
        if (!c.ok) throw new Error(`Couldn't connect to ${item.url}: ${c.outcome}`);
      }
      const text = a.message === undefined ? item.draft : bodyIn(a.message);
      const event = item.type === "socketio" ? opt(a, "event") || item.event.trim() || "message" : null;
      const key = `${item.id}:message:${Date.now()}`;
      const before = liveOf(item.id).log.at(-1)?.id ?? 0;
      const sent = event === null ? sendWs(item.id, text, key) : emitIo(item.id, event, text, key);
      if (!sent) throw new Error("The connection closed before it could send.");
      const at = Date.now();
      const wait = Math.max(0, Math.min(30_000, Number(a.wait_ms ?? 1500)));
      traceAfter(key, knownEntry(item.url) ?? null, { label: event === null ? "Send" : `emit ${event}`, outcome: "Sent", ok: true, at, end: at }, wait);
      await sleep(wait);
      const after = liveOf(item.id).log.filter((e) => e.id > before);
      return [...after.map(logLine), "", traceText(await settledTrace(key, 5000))].join("\n");
    },
  },
  {
    name: "socket_log",
    title: "Read a socket's log",
    description: "A connection's state and its messages: ← in, → out, · the connection's own, ! errors.",
    props: { item: P.item, last: { type: "integer", description: "How many, from the end. 50 when not given." } },
    required: ["item"],
    read: true,
    run: async (a) => {
      const item = await socketItem(need(a, "item"));
      const live = liveOf(item.id);
      const n = Math.max(1, Number(a.last ?? 50));
      return [`${displayName(item)}: ${live.status}`, "", ...live.log.slice(-n).map(logLine)].join("\n").trim();
    },
  },
  {
    name: "disconnect_socket",
    title: "Disconnect a socket",
    description: "Closes a WebSocket or Socket.IO connection.",
    props: { item: P.item },
    required: ["item"],
    run: async (a) => {
      const item = await socketItem(need(a, "item"));
      disconnect(item.id);
      return `Closed ${displayName(item)}.`;
    },
  },
  {
    name: "get_trace",
    title: "Get a call's trace",
    description:
      "The trace of a request's last send, a socket's last connect or message, or a flow step's last call: the service it reached on a UAT network, what that called in turn (with failures like a name not found), and their logs while it ran.",
    props: {
      item: { type: "string", description: "A request or connection in Collections." },
      flow: { type: "string", description: "Or a flow, with step." },
      step: { type: "string", description: "With flow: the step's id, name or number." },
    },
    read: true,
    run: async (a) => {
      let key: string | undefined;
      if (opt(a, "flow")) {
        const flow = findFlow((await flowsDoc()).flows, need(a, "flow"));
        key = traceKey(flow.id, findStep(flow, need(a, "step")).id);
      } else {
        const node = findNode((await workspace()).tree, need(a, "item"), ["http", "ws", "socketio"]);
        key = node.type === "http" ? node.id : socketTrace(node.id);
      }
      if (!key || !traceState(key)) return "It hasn't been sent since UAT opened.";
      return traceText(await settledTrace(key, 5000));
    },
  },
];

function findParent(tree: TreeNode[], id: string): Group | null {
  for (const n of tree) {
    if (n.type !== "group") continue;
    if (n.children.some((c) => c.id === id)) return n;
    const hit = findParent(n.children, id);
    if (hit) return hit;
  }
  return null;
}

// ---- Flows ----

async function flowRef(a: Args): Promise<Flow> {
  return findFlow((await flowsDoc()).flows, need(a, "flow"));
}

/** Steps' traces once they're read, so the report has them */
async function tracesSettled(run: FlowRun) {
  await Promise.all(
    run.flow.steps.filter((s) => s.type === "request").map((s) => settledTrace(traceKey(run.flowId, s.id), 5000)),
  );
}

const traceOf = (flowId: string) => (stepId: string) => traceState(traceKey(flowId, stepId));

function runOf(flow: Flow): FlowRun {
  const run = lastRun(flow.id);
  if (!run) throw new Error(`${flowName(flow)} hasn't run since UAT opened. run_flow runs it.`);
  return run;
}

const STEP_SCHEMA_HELP =
  "A step is { type, name, … }. request: method, url, headers, body, body_type, expect_ok (stop unless 2xx; yes by default), keep ({ name: path into { status, headers, body } }, like { rideId: \"body.rides[0].id\" }). transform: as (the name the result is kept as), code (JavaScript; earlier values are in scope by name, `vars` holds them all, lodash is _, log() writes to the step's log; return the value). sheet: from (a path to a list), columns ({ header: path into each row }), file (.xlsx or .csv; ~/Documents/UAT when relative). {{name}} in a URL, header or body is filled in from earlier values.";

const flowTools: Tool[] = [
  {
    name: "list_flows",
    title: "List flows",
    description: "The flows: steps run in order (API calls, JavaScript transforms, sheets written to files), each able to use what earlier ones kept. With each one's last run.",
    read: true,
    run: async () => {
      const { flows } = await flowsDoc();
      if (!flows.length) return "No flows yet. save_flow makes one; start_demo adds an example.";
      return flows
        .map((f) => {
          const run = lastRun(f.id);
          const last = isRunning(f.id) ? "running now" : run ? `last run ${run.status}` : "not run since UAT opened";
          return `- ${flowName(f)} · ${plural(f.steps.length, "step")} · ${last} · id ${f.id}`;
        })
        .join("\n");
    },
  },
  {
    name: "get_flow",
    title: "Get a flow",
    description: "A flow in full: its inputs and every step, in the shape save_flow and save_step take.",
    props: { flow: P.flow },
    required: ["flow"],
    read: true,
    run: async (a) => flowOut(await flowRef(a)),
  },
  {
    name: "save_flow",
    title: "Save a flow",
    description: `Makes a flow, or changes one when flow is given: its name, its inputs, or all its steps at once (steps with an id keep it, so their runs and traces line up). ${STEP_SCHEMA_HELP}`,
    props: {
      flow: { type: "string", description: "The flow to change. A new one is made when not given." },
      name: { type: "string", description: "Its name." },
      inputs: { type: ["object", "array"], description: 'Inputs every step can use, replacing them all: { "base": "http://localhost:3000" }.' },
      steps: { type: "array", items: { type: "object" }, description: "Every step, in order, replacing them all." },
    },
    run: async (a) => {
      const doc = await flowsDoc();
      const old = opt(a, "flow") ? findFlow(doc.flows, need(a, "flow")) : null;
      const base = old ?? { ...newFlow(), name: opt(a, "name") ?? "" };
      const steps = a.steps === undefined
        ? base.steps
        : (a.steps as unknown[]).map((s, i) => {
            try {
              const id = (s as { id?: unknown })?.id;
              return stepIn(s, base.steps.find((x) => x.id === id));
            } catch (e) {
              throw new Error(`Step ${i + 1}: ${message(e)}`);
            }
          });
      const flow: Flow = {
        ...base,
        name: opt(a, "name") ?? base.name,
        vars: a.inputs === undefined ? base.vars : kvIn(a.inputs, "inputs"),
        steps,
      };
      changeFlows((d) => ({ ...d, flows: old ? d.flows.map((f) => (f.id === old.id ? flow : f)) : [...d.flows, flow] }));
      return { saved: flowOut(flow) };
    },
  },
  {
    name: "save_step",
    title: "Save a step",
    description: `Adds a step to a flow, or changes one when step is given (what you leave out stays as it was). ${STEP_SCHEMA_HELP}`,
    props: {
      flow: P.flow,
      step: { type: "string", description: "The step to change: its id, name or number from 1. A new one is added when not given." },
      fields: { type: "object", description: "The step's fields: { type, name, … } as described." },
      at: { type: "integer", description: "Its place, from 1. Last when not given; moves a changed step." },
    },
    required: ["flow", "fields"],
    run: async (a) => {
      const flow = await flowRef(a);
      const old = opt(a, "step") ? findStep(flow, need(a, "step")) : undefined;
      const step = stepIn(a.fields, old);
      const rest = flow.steps.filter((s) => s.id !== old?.id);
      const at = a.at === undefined ? (old ? flow.steps.indexOf(old) : rest.length) : Math.max(0, Math.min(rest.length, Number(a.at) - 1));
      const steps = [...rest.slice(0, at), step, ...rest.slice(at)];
      changeFlows((d) => ({ ...d, flows: d.flows.map((f) => (f.id === flow.id ? { ...f, steps } : f)) }));
      return { saved: { flow: flowName(flow), position: at + 1, step: flowOut({ ...flow, steps: [step] }).steps[0] } };
    },
  },
  {
    name: "delete_step",
    title: "Delete a step",
    description: "Removes a step from a flow.",
    props: { flow: P.flow, step: { type: "string", description: "The step's id, name or number from 1." } },
    required: ["flow", "step"],
    destructive: true,
    run: async (a) => {
      const flow = await flowRef(a);
      const step = findStep(flow, need(a, "step"));
      changeFlows((d) => ({ ...d, flows: d.flows.map((f) => (f.id === flow.id ? { ...f, steps: f.steps.filter((s) => s.id !== step.id) } : f)) }));
      return `Removed ${stepName(step)} from ${flowName(flow)}.`;
    },
  },
  {
    name: "delete_flow",
    title: "Delete a flow",
    description: "Deletes a flow and its last run.",
    props: { flow: P.flow },
    required: ["flow"],
    destructive: true,
    run: async (a) => {
      const flow = await flowRef(a);
      stopRun(flow.id);
      changeFlows((d) => ({ ...d, flows: d.flows.filter((f) => f.id !== flow.id) }));
      forgetRun(flow.id);
      return `Deleted ${flowName(flow)}.`;
    },
  },
  {
    name: "run_flow",
    title: "Run a flow",
    description:
      "Runs a flow's steps in order; the first that fails stops it. Waits for it to end and returns a summary of every step, the failed one in full. get_flow_run has every step in full; export_flow_report saves a report.",
    props: {
      flow: P.flow,
      inputs: { type: "object", description: "Values for this run only, over the flow's inputs: { \"base\": \"http://localhost:8480\" }." },
      wait: { type: "boolean", description: "Wait for it to end. Yes when not given; with no, check on it with get_flow_run." },
    },
    required: ["flow"],
    open: true,
    run: async (a) => {
      const flow = await flowRef(a);
      if (isRunning(flow.id)) throw new Error(`${flowName(flow)} is running already. stop_flow stops it.`);
      let toRun = flow;
      if (a.inputs !== undefined) {
        const given = kvIn(a.inputs, "inputs");
        const vars = flow.vars.map((v) => {
          const g = given.find((x) => x.key === v.key);
          return g ? { ...v, value: g.value, enabled: true } : v;
        });
        toRun = { ...flow, vars: [...vars, ...given.filter((g) => !flow.vars.some((v) => v.key === g.key))] };
      }
      const done = startRun(toRun);
      if (a.wait === false) {
        done.catch(() => {});
        return `Started ${flowName(flow)}. get_flow_run shows how it's going.`;
      }
      const run = await done;
      if (!run) throw new Error(`${flowName(flow)} is running already.`);
      await tracesSettled(run);
      const md = report(run, "md", { only: run.failed ? [run.failed] : [], trace: traceOf(flow.id) });
      return `${md}\nget_flow_run has every step in full; export_flow_report saves this as a file.`;
    },
  },
  {
    name: "stop_flow",
    title: "Stop a flow",
    description: "Stops a flow that's running; the steps after the current one are skipped.",
    props: { flow: P.flow },
    required: ["flow"],
    run: async (a) => {
      const flow = await flowRef(a);
      if (!isRunning(flow.id)) return `${flowName(flow)} isn't running.`;
      stopRun(flow.id);
      return `Stopped ${flowName(flow)}.`;
    },
  },
  {
    name: "get_flow_run",
    title: "Get a flow's run",
    description:
      "A flow's last run as a Markdown report: the summary, then each step in full (what it sent and got back, what it kept, its log, its sheet, the calls it led to and their logs). Or one step.",
    props: {
      flow: P.flow,
      step: { type: "string", description: "Only this step in full: its id, name or number from 1." },
      secrets: P.secrets,
    },
    required: ["flow"],
    read: true,
    run: async (a) => {
      const flow = await flowRef(a);
      const run = runOf(flow);
      const only = opt(a, "step") ? [findStep(run.flow, need(a, "step")).id] : undefined;
      if (run.status !== "running") await tracesSettled(run);
      return report(run, "md", { secrets: a.secrets === true, trace: traceOf(flow.id), only });
    },
  },
  {
    name: "export_flow_report",
    title: "Export a flow report",
    description:
      "Saves a report of a flow's last run as a file: an HTML page to open or share, or Markdown. ~/Documents/UAT when no path is given.",
    props: {
      flow: P.flow,
      format: { type: "string", enum: ["html", "md"], description: "html or md. html when not given." },
      path: { type: "string", description: "Where to save it: a path, or a file name in ~/Documents/UAT." },
      secrets: P.secrets,
      open: { type: "boolean", description: "Open it once saved." },
    },
    required: ["flow"],
    run: async (a) => {
      if (!inTauri) throw new Error("Saving a report needs the desktop app.");
      const flow = await flowRef(a);
      const run = runOf(flow);
      const format = (opt(a, "format") ?? "html") as ReportFormat;
      await tracesSettled(run);
      const text = report(run, format, { secrets: a.secrets === true, trace: traceOf(flow.id) });
      const path = await call<string>("flow_write_report", { path: opt(a, "path") ?? reportFile(run, format), text });
      if (a.open === true) await flowsApi.open(path, false);
      return `Saved ${path}`;
    },
  },
];

// ---- The app ----

const appTools: Tool[] = [
  {
    name: "uat_overview",
    title: "UAT overview",
    description:
      "What UAT has now: Docker's state and each network's services, Collections, and flows with their last runs. A good first call.",
    read: true,
    run: async () => {
      const [engine, procs, ws, doc] = await Promise.all([docker.status(), listProcesses().catch(() => []), workspace(), flowsDoc()]);
      const out = [engine.connected ? `Docker ${engine.version ?? ""} is running.`.replace("  ", " ") : "Docker isn't running."];
      const nets = engine.connected ? await networkNames() : [...new Set(procs.map((p) => p.network))];
      for (const n of nets) {
        const services = engine.connected ? (await docker.services(n).catch(() => [] as Service[])).filter((s) => s.kind !== "process") : [];
        const names = [
          ...services.map((s) => `${s.name} (${s.state})`),
          ...procs.filter((p) => p.network === n).map((p) => `${p.name} (command, ${p.state})`),
        ];
        out.push(`- ${n}: ${names.length ? names.join(", ") : "no services"}`);
      }
      const items = ws.tree.reduce((s, t) => s + countItems(t), 0);
      out.push("", `Collections: ${plural(items, "item")} in ${ws.tree.filter((t) => t.type === "group").map(displayName).join(", ") || "no groups"}.`);
      out.push(
        "",
        `Flows: ${doc.flows.length ? doc.flows.map((f) => `${flowName(f)}${lastRun(f.id) ? ` (last run ${lastRun(f.id)!.status})` : ""}`).join(", ") : "none"}.`,
      );
      return out.join("\n");
    },
  },
  {
    name: "start_demo",
    title: "Start the demo",
    description:
      "Sets up UAT's demo: a small network (uat-demo) with a gateway and services, the \"Trace demo\" group of requests in Collections (one call succeeds end to end, one fails at a service that isn't there), and a flow that uses them.",
    open: true,
    run: async () => {
      const lines: string[] = [];
      const off = await demoApi.onProgress((l) => lines.push(l));
      try {
        const { network, port } = await demoApi.start();
        await workspace();
        changeWorkspace((w) => withDemo(w, port));
        await flowsDoc();
        changeFlows((d) => withDemoFlow(d, port));
        changed("networks");
        return `The demo is up on ${network}, reached at http://localhost:${port}. Collections has the "Trace demo" group; Flows has its flow.`;
      } catch (e) {
        throw new Error([message(e), ...(lines.length ? ["", ...lines.slice(-15)] : [])].join("\n"));
      } finally {
        off();
      }
    },
  },
  {
    name: "show_in_app",
    title: "Show in UAT",
    description: "Brings a section of UAT's window into view, so the person can watch: a network's services, Collections, Flows, or the MCP page.",
    props: {
      section: { type: "string", enum: ["network", "collections", "flows", "mcp"], description: "Which section." },
      network: { type: "string", description: `With network: which. ${DEFAULT_NETWORK} when not given.` },
    },
    required: ["section"],
    run: async (a) => {
      const section = need(a, "section");
      const view = section === "network" ? { kind: "network", name: opt(a, "network") ?? DEFAULT_NETWORK } : { kind: section };
      window.dispatchEvent(new CustomEvent("uat:show", { detail: view }));
      return "Shown.";
    },
  },
];

/** The tools by what they work on, for the MCP page */
export const TOOL_GROUPS: { name: string; tools: Tool[] }[] = [
  { name: "Networks and services", tools: networkTools },
  { name: "Collections", tools: collectionTools },
  { name: "Flows", tools: flowTools },
  { name: "The app", tools: appTools },
];

export const TOOLS: Tool[] = TOOL_GROUPS.flatMap((g) => g.tools);
