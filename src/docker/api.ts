import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { call, inTauri } from "../lib/tauri";
import { mock } from "./mock";
import { refreshProcesses } from "./processes";

export const DEFAULT_NETWORK = "uat-net";

export type EngineStatus = {
  connected: boolean;
  socket: string | null;
  version: string | null;
  error: string | null;
};

export type NetworkInfo = { id: string; name: string; driver: string; managed: boolean };

export type PortInfo = { container: number; host: number | null };

/** "process" is the proxy that puts a command running on this Mac on the network */
export type ServiceKind = "dockerfile" | "image" | "external" | "process";

export type Service = {
  id: string;
  name: string;
  containerName: string;
  image: string;
  /** created | running | paused | restarting | exited | removing | dead */
  state: string;
  status: string;
  ports: PortInfo[];
  dependsOn: string[];
  kind: ServiceKind;
  source: string | null;
  managed: boolean;
};

export type DockerfileInfo = {
  found: boolean;
  dockerfile: string;
  from: string | null;
  exposes: number[];
  suggestedName: string;
};

export type AddServiceRequest = {
  network: string;
  name: string;
  source: { kind: "dockerfile"; context: string; dockerfile?: string } | { kind: "image"; image: string };
  env: string[];
  ports: { container: number; host: number | null }[];
  dependsOn: string[];
};

export type Progress = { service: string; stage: string; line: string };

export type PlanContainer = { id: string; name: string; image: string; state: string };

/** What removing a network takes with it, and what stays */
export type NetworkPlan = {
  network: string;
  /** The default network: UAT makes it again, empty */
  recreated: boolean;
  /** Containers UAT made on it: removed */
  containers: PlanContainer[];
  /** Containers started elsewhere: only disconnected */
  attached: PlanContainer[];
  /** Commands run as its services: stopped and deleted */
  commands: { id: string; name: string; running: boolean }[];
  /** Images those containers run; `kept` says who else uses one */
  images: { id: string; names: string[]; size: string; kept: string | null }[];
  volumes: { name: string; anonymous: boolean; kept: string | null }[];
};

export type NetworkRemoved = {
  network: string;
  recreated: boolean;
  containers: string[];
  disconnected: string[];
  commands: string[];
  images: string[];
  volumes: string[];
  /** What stayed, and why */
  kept: string[];
};

// In a plain browser during development, read sample data instead
const sample = !inTauri && import.meta.env.DEV;

export const docker = {
  status: () =>
    inTauri
      ? call<EngineStatus>("docker_status")
      : Promise.resolve<EngineStatus>(
          sample
            ? mock.status()
            : {
                connected: false,
                socket: null,
                version: null,
                error: "Docker is reached from the desktop app. Run `npm run tauri dev`.",
              },
        ),
  networks: () => (sample ? Promise.resolve(mock.networks()) : call<NetworkInfo[]>("docker_networks")),
  createNetwork: (name: string) => call<void>("docker_create_network", { name }),
  services: (network: string) =>
    sample
      ? Promise.resolve(network === DEFAULT_NETWORK ? mock.services() : [])
      : call<Service[]>("docker_services", { network }),
  otherContainers: (network: string) =>
    sample ? Promise.resolve(mock.others()) : call<Service[]>("docker_other_containers", { network }),
  addService: (req: AddServiceRequest) => call<Service>("docker_add_service", { req }),
  attach: (container: string, network: string, alias: string) =>
    call<void>("docker_attach", { container, network, alias }),
  start: (id: string) => call<void>("docker_start", { id }),
  stop: (id: string) => call<void>("docker_stop", { id }),
  remove: (id: string, network: string) => call<void>("docker_remove", { id, network }),
  logs: (id: string, tail = 300) => call<string>("docker_logs", { id, tail }),
  inspectDockerfile: (context: string, dockerfile?: string) =>
    call<DockerfileInfo>("docker_inspect_dockerfile", { context, dockerfile: dockerfile || null }),
  networkPlan: (network: string) =>
    sample ? Promise.resolve(mock.plan(network)) : call<NetworkPlan>("docker_network_plan", { network }),
  /** Removes the network, its containers and commands, and the images and volumes only they used, if asked */
  removeNetwork: (network: string, images: boolean, volumes: boolean) =>
    sample
      ? new Promise<NetworkRemoved>((r) => setTimeout(() => r(mock.removed(network, images, volumes)), 900))
      : call<NetworkRemoved>("docker_remove_network", { network, images, volumes }),
};

/** What a network's removal is doing, line by line */
export function onNetworkProgress(cb: (p: { network: string; line: string }) => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return listen<{ network: string; line: string }>("network://progress", (e) => cb(e.payload));
}

/** After a network goes: the sidebar, the open section and the commands catch up */
export function networkRemoved(network: string) {
  refreshProcesses().catch(() => {});
  window.dispatchEvent(new CustomEvent("uat:network-removed", { detail: network }));
}

export function onProgress(cb: (p: Progress) => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return listen<Progress>("docker://progress", (e) => cb(e.payload));
}

/** "3000:3000, 5432" → published 3000→3000, and 5432 only on the network. */
export function parsePorts(text: string): { ports: AddServiceRequest["ports"]; error?: string } {
  const ports: AddServiceRequest["ports"] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const m = raw.match(/^(?:(\d{1,5}):)?(\d{1,5})(?:\/tcp)?$/);
    if (!m) return { ports, error: `"${raw}" is not a port. Use 3000 or 8080:3000.` };
    const host = m[1] ? Number(m[1]) : null;
    const container = Number(m[2]);
    if (container < 1 || container > 65535 || (host !== null && (host < 1 || host > 65535))) {
      return { ports, error: `"${raw}" is out of range.` };
    }
    ports.push({ container, host });
  }
  return { ports };
}

/** The port other containers on the network use to reach this one. */
export function mainPort(s: Service): number | null {
  return s.ports[0]?.container ?? null;
}
