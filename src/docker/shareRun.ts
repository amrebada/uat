/** Exporting and importing a network on this Mac: what runs on it, which
 *  repos its folders are in, where those repos are cloned here, which ports
 *  are taken, and adding what a file describes. The window's dialogs and
 *  the MCP tools both use these. */
import { open } from "@tauri-apps/plugin-dialog";
import { call, inTauri, message } from "../lib/tauri";
import { docker, onProgress } from "./api";
import { mock } from "./mock";
import { processes, refreshProcesses, type ProcessInfo } from "./processes";
import {
  draftOf,
  fileOf,
  fileText,
  portsOf,
  stepsOf,
  type Answers,
  type BuildFrom,
  type Draft,
  type GitInfo,
  type Here,
  type NetworkFile,
  type Snapshot,
} from "./share";

export type Found = { clones: string[]; named: string[] };

const sample = !inTauri && import.meta.env.DEV;

export const shareApi = {
  snapshot: (network: string) => (sample ? Promise.resolve(mock.snapshot(network)) : call<Snapshot>("network_snapshot", { network })),
  gitInfo: (paths: string[]) => (sample ? Promise.resolve(paths.map(mock.git)) : call<(GitInfo | null)[]>("git_info", { paths })),
  findRepos: (repos: string[], roots: string[] = []) =>
    sample
      ? Promise.resolve({ "github.com/yassir/rides-api": { clones: ["/Users/you/code/rides-api"], named: [] } } as Record<string, Found>)
      : call<Record<string, Found>>("find_repos", { repos, roots }),
  portsInUse: (ports: number[]) => (sample ? Promise.resolve([3000]) : call<number[]>("ports_in_use", { ports })),
  imagesHere: (images: string[]) => (sample ? Promise.resolve([]) : call<string[]>("images_here", { images })),
  clone: (url: string, parent: string) => call<string>("git_clone", { url, parent }),
  read: (path: string) => (sample ? sampleFile() : call<string>("share_read", { path })),
  write: (path: string, text: string) => call<string>("share_write", { path, text }),
};

const processList = () => (sample ? Promise.resolve(SAMPLE_COMMANDS) : call<ProcessInfo[]>("process_list"));

/** A network file to import, from the file picker. Any file can be
 *  chosen: macOS greyed out a .uat.json file under a "json" filter, and
 *  reading it says when a file isn't a network. */
export async function pickFile(): Promise<string | null> {
  if (sample) return "rides.uat.json";
  const path = await open({ multiple: false, directory: false, title: "A network file to import" });
  return typeof path === "string" ? path : null;
}

/** The folder that builds an image, and its Dockerfile when it isn't
 *  ./Dockerfile there: the person chooses the folder, then the file when
 *  there's none at its top. Null when they cancel. */
export async function pickBuild(service: string): Promise<BuildFrom | null> {
  if (sample) return { folder: "/Users/you/code/rides-mailer" };
  const folder = await open({ directory: true, title: `The folder that builds ${service}` });
  if (typeof folder !== "string") return null;
  const found = await docker.inspectDockerfile(folder).catch(() => null);
  if (found?.found) return { folder };
  const file = await open({ multiple: false, directory: false, defaultPath: folder, title: `No Dockerfile at its top: choose ${service}'s` });
  if (typeof file !== "string") return null;
  const base = `${folder.replace(/\/+$/, "")}/`;
  if (!file.startsWith(base)) throw new Error("The Dockerfile should be inside that folder, which is what Docker builds from.");
  return { folder, dockerfile: file.slice(base.length) };
}

/** That a folder has the Dockerfile to build from, for agents' answers */
export async function checkBuild(b: BuildFrom): Promise<void> {
  const found = await docker.inspectDockerfile(b.folder, b.dockerfile);
  if (!found.found) throw new Error(`No Dockerfile at ${found.dockerfile || b.folder}.`);
}

/** What exporting a network starts from: what runs on it here, and the repo each folder is in */
export type ExportSource = { snap: Snapshot; commands: ProcessInfo[]; git: Record<string, GitInfo | null> };

export async function exportSource(network: string): Promise<ExportSource> {
  const [snap, list] = await Promise.all([shareApi.snapshot(network), processList()]);
  const commands = list.filter((p) => p.network === network);
  const folders = [
    ...new Set([
      ...snap.containers.filter((c) => c.kind === "dockerfile" && c.context).map((c) => c.context!),
      ...commands.map((p) => p.cwd),
    ]),
  ];
  const infos = folders.length ? await shareApi.gitInfo(folders) : [];
  return { snap, commands, git: Object.fromEntries(folders.map((f, i) => [f, infos[i] ?? null])) };
}

/** The network's file as it would be, for the person to review, with
 *  `builds` naming the folders chosen to build images from */
export async function draftWith(src: ExportSource, builds: Record<string, BuildFrom> = {}): Promise<Draft> {
  const unknown = [...new Set(Object.values(builds).map((b) => b.folder))].filter((f) => !(f in src.git));
  if (unknown.length) {
    const infos = await shareApi.gitInfo(unknown);
    unknown.forEach((f, i) => (src.git[f] = infos[i] ?? null));
  }
  return draftOf(src.snap, src.commands, src.git, builds);
}

export async function draftNetwork(network: string, builds: Record<string, BuildFrom> = {}): Promise<Draft> {
  return draftWith(await exportSource(network), builds);
}

/** What the import's questions depend on here: ports in use, what the
 *  network already runs, and which images built on the exporter's Mac
 *  this one has */
export async function hereFor(file: NetworkFile, network: string): Promise<Here> {
  const local = [...new Set(Object.values(file.services).flatMap((s) => (s.image && s.local ? [s.image] : [])))];
  const [inUse, networks, list, images] = await Promise.all([
    shareApi.portsInUse(portsOf(file)),
    docker.networks(),
    sample ? Promise.resolve([] as ProcessInfo[]) : processList(),
    local.length ? shareApi.imagesHere(local) : Promise.resolve([]),
  ]);
  const exists = networks.some((n) => n.name === network);
  const services = exists ? await docker.services(network) : [];
  return {
    inUse,
    existing: [...services.map((s) => s.name), ...list.filter((p) => p.network === network).map((p) => p.name)],
    images,
  };
}

/** Clones of the file's repos on this Mac, by repo name */
export async function findClones(file: NetworkFile, roots: string[] = []): Promise<Record<string, Found>> {
  const ids = Object.values(file.repos).map((r) => r.git).filter((g): g is string => !!g);
  const found = ids.length ? await shareApi.findRepos(ids, roots) : {};
  const out: Record<string, Found> = {};
  for (const [name, r] of Object.entries(file.repos)) if (r.git) out[name] = found[r.git] ?? { clones: [], named: [] };
  return out;
}

export type Imported = {
  network: string;
  createdNetwork: boolean;
  added: { service: string; kind: "container" | "command" | "attach"; what: string }[];
  skipped: { service: string; why: string }[];
  failed: { service: string; error: string }[];
};

/** Adds what the file describes, in dependency order. One service failing
 *  doesn't stop the others; the result says which. */
export async function runImport(
  file: NetworkFile,
  here: Here,
  answers: Answers,
  onLine: (service: string, line: string) => void = () => {},
): Promise<Imported> {
  const steps = stepsOf(file, here, answers);
  const network = (answers.network ?? file.name).trim().toLowerCase();
  const out: Imported = { network, createdNetwork: false, added: [], skipped: [], failed: [] };
  if (!(await docker.networks()).some((n) => n.name === network)) {
    onLine("", `Creating ${network}…`);
    await docker.createNetwork(network);
    out.createdNetwork = true;
  }
  const off = await onProgress((p) => onLine(p.service, p.line));
  try {
    for (const step of steps) {
      const name = step.service;
      try {
        switch (step.kind) {
          case "skip":
            out.skipped.push({ service: name, why: step.why });
            break;
          case "container": {
            const src = step.req.source;
            onLine(name, src.kind === "image" ? `Pulling ${src.image}…` : `Building ${name}…`);
            await docker.addService(step.req);
            out.added.push({ service: name, kind: "container", what: src.kind === "image" ? src.image : `built from ${src.context}` });
            break;
          }
          case "command":
            onLine(name, `Adding ${name}…`);
            await processes.create(step.def);
            out.added.push({ service: name, kind: "command", what: `${step.def.command}, in ${step.def.cwd}` });
            break;
          case "attach":
            onLine(name, `Attaching ${step.container}…`);
            await docker.attach(step.container, network, name);
            out.added.push({ service: name, kind: "attach", what: `${step.container}, attached` });
            break;
        }
      } catch (e) {
        out.failed.push({ service: name, error: message(e) });
      }
    }
  } finally {
    off();
    await refreshProcesses().catch(() => {});
    window.dispatchEvent(new CustomEvent("uat:networks"));
  }
  return out;
}

// ---- Sample for the browser preview ----

const SAMPLE_COMMANDS: ProcessInfo[] = [
  {
    id: "sample-web",
    name: "rides-web",
    network: "uat-net",
    cwd: "~/code/rides-web",
    command: "npm run dev",
    env: ["VITE_API_URL=http://localhost:3000"],
    ports: [5173],
    dependsOn: ["rides-api"],
    state: "running",
    pid: 48211,
    exitCode: null,
    networkError: null,
  },
];

const sampleFile = async () => {
  const draft = await draftNetwork("uat-net");
  return fileText({ ...fileOf(draft), name: "rides" });
};
