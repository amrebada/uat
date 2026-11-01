/** The API workspace, loaded once and saved shortly after each change. It
 *  lives outside the view, so the view and the MCP server's tools share it
 *  and neither saves over the other. */
import { useEffect, useSyncExternalStore } from "react";
import { call, inTauri, message } from "../lib/tauri";
import { sampleWorkspace, type Workspace } from "./model";

const LOCAL_KEY = "uat.workspace";
const SAVE_DELAY_MS = 400;

/** The saved workspace, or null before it is first saved. */
export async function loadWorkspace(): Promise<Workspace | null> {
  if (inTauri) return call<Workspace | null>("workspace_load");
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as Workspace) : null;
  } catch {
    return null;
  }
}

async function save(ws: Workspace) {
  if (inTauri) return call<void>("workspace_save", { workspace: ws });
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(ws));
  } catch {
    // Browser preview only; nothing to fall back to
  }
}

type State = { ws: Workspace | null; error: string | null };

let state: State = { ws: null, error: null };
let loading: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
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
  loading ??= loadWorkspace()
    .then((loaded) => publish({ ws: loaded ?? sampleWorkspace() }))
    // Don't overwrite a file we couldn't read; show the error instead
    .catch((e) => publish({ error: message(e) }));
  return loading;
}

function flush() {
  clearTimeout(timer);
  if (state.ws) save(state.ws).catch((e) => publish({ error: message(e) }));
}

window.addEventListener("beforeunload", flush);

export function changeWorkspace(fn: (ws: Workspace) => Workspace) {
  if (!state.ws) return;
  publish({ ws: fn(state.ws) });
  clearTimeout(timer);
  timer = setTimeout(() => {
    const ws = state.ws;
    if (ws) save(ws).then(() => state.error && publish({ error: null }), (e) => publish({ error: message(e) }));
  }, SAVE_DELAY_MS);
}

/** The workspace once it's loaded, for code outside React */
export async function workspace(): Promise<Workspace> {
  await load();
  if (!state.ws) throw new Error(state.error ?? "The workspace couldn't be loaded");
  return state.ws;
}

export function useWorkspace() {
  useEffect(() => {
    load();
  }, []);
  const { ws, error } = useSyncExternalStore(subscribe, () => state);
  return { ws, change: changeWorkspace, error };
}
