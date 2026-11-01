/** The flows document, loaded once and saved shortly after each change, and
 *  each flow's last run. Both live outside the view, so a run keeps going
 *  and nothing is lost while another section is open. */
import { useEffect, useSyncExternalStore } from "react";
import { message } from "../lib/tauri";
import { appDeps, flowsApi } from "./api";
import { runFlow, type FlowRun } from "./engine";
import type { Flow, FlowsDoc } from "./model";

const SAVE_DELAY_MS = 400;

type State = { doc: FlowsDoc | null; error: string | null };

let state: State = { doc: null, error: null };
let loading: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const runs = new Map<string, FlowRun>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function publish(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function load() {
  loading ??= flowsApi
    .load()
    .then((doc) => publish({ doc: doc ?? { version: 1, flows: [] } }))
    // Don't overwrite a file we couldn't read; show the error instead
    .catch((e) => publish({ error: message(e) }));
  return loading;
}

function flush() {
  clearTimeout(timer);
  if (state.doc) flowsApi.save(state.doc).catch((e) => publish({ error: message(e) }));
}

window.addEventListener("beforeunload", flush);

export function useFlows(): State {
  useEffect(() => {
    load();
  }, []);
  return useSyncExternalStore(subscribe, () => state);
}

export function changeFlows(fn: (doc: FlowsDoc) => FlowsDoc) {
  if (!state.doc) return;
  publish({ doc: fn(state.doc) });
  clearTimeout(timer);
  timer = setTimeout(() => {
    const doc = state.doc;
    if (doc) flowsApi.save(doc).then(() => state.error && publish({ error: null }), (e) => publish({ error: message(e) }));
  }, SAVE_DELAY_MS);
}

export function changeFlow(id: string, fn: (flow: Flow) => Flow) {
  changeFlows((d) => ({ ...d, flows: d.flows.map((f) => (f.id === id ? fn(f) : f)) }));
}

// ---- Runs ----

/** The flows once they're loaded, for code outside React */
export async function flowsDoc(): Promise<FlowsDoc> {
  await load();
  if (!state.doc) throw new Error(state.error ?? "The flows couldn't be loaded");
  return state.doc;
}

export const lastRun = (flowId: string): FlowRun | undefined => runs.get(flowId);
export const isRunning = (flowId: string) => controllers.has(flowId);

export function useRun(flowId: string): FlowRun | undefined {
  return useSyncExternalStore(subscribe, () => runs.get(flowId));
}

/** Runs `flow`; the run as it ended, or undefined when it's already running */
export async function startRun(flow: Flow): Promise<FlowRun | undefined> {
  if (controllers.has(flow.id)) return;
  const ctrl = new AbortController();
  controllers.set(flow.id, ctrl);
  try {
    return await runFlow(
      flow,
      appDeps(flow.id),
      (run) => {
        runs.set(flow.id, run);
        listeners.forEach((fn) => fn());
      },
      ctrl.signal,
    );
  } finally {
    controllers.delete(flow.id);
  }
}

export function stopRun(flowId: string) {
  controllers.get(flowId)?.abort();
}

export function forgetRun(flowId: string) {
  runs.delete(flowId);
}
