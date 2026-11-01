/** The window's side of the MCP server: tells Rust which tools there are
 *  (again after a reload), runs each call it passes on, and keeps the latest
 *  calls for the MCP page. */
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { call, inTauri, message } from "../lib/tauri";
import { checkArgs, describe, textOf } from "./registry";
import { TOOLS } from "./tools";

export type Activity = {
  id: number;
  tool: string;
  title: string;
  /** The arguments, short */
  args: string;
  at: number;
  ms?: number;
  ok?: boolean;
  /** The answer's first line, or why it failed */
  result?: string;
};

const MAX_ACTIVITY = 50;
const ARGS_MAX = 160;

let activity: Activity[] = [];
const listeners = new Set<() => void>();

function publish(entry: Activity) {
  const i = activity.findIndex((a) => a.id === entry.id);
  activity = i < 0 ? [entry, ...activity].slice(0, MAX_ACTIVITY) : activity.map((a) => (a.id === entry.id ? entry : a));
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const useActivity = () => useSyncExternalStore(subscribe, () => activity);

const short = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

type CallEvent = { id: number; name: string; arguments?: unknown };

async function answer({ id, name, arguments: args }: CallEvent) {
  const tool = TOOLS.find((t) => t.name === name);
  const entry: Activity = {
    id,
    tool: name,
    title: tool?.title ?? name,
    args: args && Object.keys(args).length ? short(JSON.stringify(args), ARGS_MAX) : "",
    at: Date.now(),
  };
  publish(entry);
  const t0 = performance.now();
  let text: string | undefined;
  let error: string | undefined;
  try {
    if (!tool) throw new Error(`UAT has no tool called ${name}.`);
    text = textOf(await tool.run(checkArgs(tool, args)));
  } catch (e) {
    error = message(e);
  }
  const ms = Math.round(performance.now() - t0);
  publish({ ...entry, ms, ok: !error, result: short((error ?? text ?? "").split("\n")[0], ARGS_MAX) });
  // A tool that fails still answers: the agent reads why
  await call("mcp_reply", {
    id,
    result: text === undefined ? null : { content: [{ type: "text", text }] },
    error: error ?? null,
  }).catch(() => {});
}

let started = false;

/** At launch: the server can list and call the tools from here on */
export function startMcp() {
  if (!inTauri || started) return;
  started = true;
  listen<CallEvent>("mcp://call", (e) => {
    answer(e.payload);
  });
  call("mcp_register", { tools: TOOLS.map(describe) }).catch(() => {});
}
