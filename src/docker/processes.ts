/** Commands run on the Mac (`npm run dev` in a repo) as services on a
 *  network. Rust runs them and keeps their output; this keeps a live copy of
 *  the list and of each log for React, fed by `process://` events. */
import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { call, inTauri } from "../lib/tauri";

export type ProcessState = "stopped" | "starting" | "running" | "stopping" | "exited" | "failed";

export type ProcessInfo = {
  id: string;
  name: string;
  network: string;
  cwd: string;
  command: string;
  env: string[];
  ports: number[];
  dependsOn: string[];
  state: ProcessState;
  pid: number | null;
  exitCode: number | null;
  /** Why containers can't reach it, when the proxy couldn't start */
  networkError: string | null;
};

export type LogLine = { seq: number; stream: "out" | "err" | "sys"; text: string };

export type NewProcess = Pick<ProcessInfo, "network" | "name" | "cwd" | "command" | "env" | "ports" | "dependsOn">;
export type ProcessPatch = Partial<Pick<ProcessInfo, "cwd" | "command" | "env" | "ports" | "dependsOn">>;
export type FolderInfo = { exists: boolean; suggestedName: string; commands: string[]; ports: number[] };

// In a plain browser during development, show a sample instead
const sample = !inTauri && import.meta.env.DEV;

export const processes = {
  create: (def: NewProcess) => call<ProcessInfo>("process_create", { def }),
  update: (id: string, patch: ProcessPatch) => call<ProcessInfo>("process_update", { id, patch }),
  remove: (id: string) => call<void>("process_delete", { id }),
  start: (id: string) => call<void>("process_start", { id }),
  stop: (id: string) => call<void>("process_stop", { id }),
  restart: (id: string) => call<void>("process_restart", { id }),
  clearLogs: (id: string) => {
    logs.set(id, []);
    notify();
    return call<void>("process_clear_logs", { id });
  },
  inspectFolder: (cwd: string) =>
    sample ? Promise.resolve(SAMPLE_FOLDER(cwd)) : call<FolderInfo>("process_inspect_folder", { cwd }),
};

// ---- Store ----

const MAX_LINES = 5000;
let list: ProcessInfo[] = [];
const logs = new Map<string, LogLine[]>();
const listeners = new Set<() => void>();
let started = false;
let frame = 0;

function notify() {
  listeners.forEach((fn) => fn());
}

/** Many log lines can land per frame; render once per frame. */
function notifySoon() {
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = 0;
      notify();
    });
  }
}

function upsert(p: ProcessInfo) {
  const i = list.findIndex((x) => x.id === p.id);
  list = i < 0 ? [...list, p] : list.map((x) => (x.id === p.id ? p : x));
  notify();
}

function append(id: string, line: LogLine) {
  const cur = logs.get(id);
  if (!cur) return; // Not loaded yet; the first read fetches the whole buffer
  if (cur.length && cur[cur.length - 1].seq >= line.seq) return;
  const next = cur.length >= MAX_LINES ? [...cur.slice(cur.length - MAX_LINES + 1), line] : [...cur, line];
  logs.set(id, next);
  notifySoon();
}

export async function refreshProcesses() {
  list = sample ? SAMPLE : await call<ProcessInfo[]>("process_list");
  notify();
}

function startOnce() {
  if (started) return;
  started = true;
  refreshProcesses().catch(() => {});
  if (!inTauri) return;
  listen<ProcessInfo>("process://status", (e) => upsert(e.payload));
  listen<{ id: string; line: LogLine }>("process://log", (e) => append(e.payload.id, e.payload.line));
}

function subscribe(fn: () => void) {
  startOnce();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useProcesses(): ProcessInfo[] {
  return useSyncExternalStore(subscribe, () => list);
}

export function forgetProcess(id: string) {
  list = list.filter((p) => p.id !== id);
  logs.delete(id);
  notify();
}

const NO_LINES: LogLine[] = [];

/** The process's output, loaded on first use and then kept live. */
export function useProcessLogs(id: string): LogLine[] {
  useEffect(() => {
    if (logs.has(id)) return;
    logs.set(id, []);
    const load = sample ? Promise.resolve(SAMPLE_LOG) : call<LogLine[]>("process_logs", { id });
    load
      .then((buffer) => {
        // Keep lines that arrived by event while this was in flight
        const live = logs.get(id) ?? [];
        const last = buffer.at(-1)?.seq ?? 0;
        logs.set(id, [...buffer, ...live.filter((l) => l.seq > last)]);
        notify();
      })
      .catch(() => {});
  }, [id]);
  return useSyncExternalStore(subscribe, () => logs.get(id) ?? NO_LINES);
}

// ---- Sample for the browser preview ----

const SAMPLE: ProcessInfo[] = [
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

const SAMPLE_LOG: LogLine[] = [
  { seq: 1, stream: "sys", text: "$ npm run dev" },
  { seq: 2, stream: "out", text: "> rides-web@0.4.0 dev" },
  { seq: 3, stream: "out", text: "> vite" },
  { seq: 4, stream: "out", text: "  VITE v6.0.7  ready in 412 ms" },
  { seq: 5, stream: "out", text: "  ➜  Local:   http://localhost:5173/" },
  { seq: 6, stream: "sys", text: "Containers on uat-net reach it at rides-web:5173" },
];

const SAMPLE_FOLDER = (cwd: string): FolderInfo => ({
  exists: true,
  suggestedName: cwd.split("/").filter(Boolean).at(-1) ?? "",
  commands: [
    "npm run start",
    "npm run build",
    "npm run build_start",
    "npm run build_start_calculate_driver_utilization_metrics_cron",
    "npm run build_start_calculate_trips_demands_utilization_metrics_cron",
  ],
  ports: [3000],
});
