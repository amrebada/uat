/** Open WebSocket and Socket.IO connections, kept by item id outside React so
 *  they stay open while you look at other items. */
import { useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import type { IoItem, WsItem } from "./model";

export type LogEntry = {
  id: number;
  at: number;
  dir: "in" | "out" | "sys" | "err";
  event?: string;
  text: string;
  /** The trace of the call this entry started */
  trace?: string;
};

/** A connect being traced: its key, and what to call once it opens or fails. */
export type Traced = { key: string; settled: (ok: boolean, outcome: string) => void };

function once(traced?: Traced) {
  let done = false;
  return (ok: boolean, outcome: string) => {
    if (done || !traced) return;
    done = true;
    traced.settled(ok, outcome);
  };
}

export type Live = {
  status: "idle" | "connecting" | "open" | "closed" | "error";
  log: LogEntry[];
};

const IDLE: Live = { status: "idle", log: [] };
const MAX_LOG = 500;

const state = new Map<string, Live>();
const conns = new Map<string, WebSocket | Socket>();
const ioListen = new Map<string, string[]>();
const listeners = new Set<() => void>();
let openIds: ReadonlySet<string> = new Set();
let seq = 0;

function emit() {
  openIds = new Set([...state].filter(([, l]) => l.status === "open" || l.status === "connecting").map(([id]) => id));
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function get(id: string): Live {
  return state.get(id) ?? IDLE;
}

function setStatus(id: string, status: Live["status"]) {
  state.set(id, { ...get(id), status });
  emit();
}

function push(id: string, entry: Omit<LogEntry, "id" | "at">) {
  const cur = get(id);
  state.set(id, { ...cur, log: [...cur.log, { ...entry, id: ++seq, at: Date.now() }].slice(-MAX_LOG) });
  emit();
}

export function useLive(id: string): Live {
  return useSyncExternalStore(subscribe, () => get(id));
}

/** Ids of items with a connection open or opening, for the tree's dots. */
export function useOpenIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => openIds);
}

export function clearLog(id: string) {
  state.set(id, { ...get(id), log: [] });
  emit();
}

export function disconnect(id: string) {
  const c = conns.get(id);
  conns.delete(id);
  if (!c) return;
  if (c instanceof WebSocket) c.close(1000);
  else c.disconnect();
}

/** Drops connections and logs for items that no longer exist. */
export function forget(ids: string[]) {
  for (const id of ids) {
    disconnect(id);
    state.delete(id);
  }
  emit();
}

export function connectWs(item: WsItem, traced?: Traced) {
  const id = item.id;
  disconnect(id);
  const settle = once(traced);
  const protocols = item.protocols.split(",").map((p) => p.trim()).filter(Boolean);
  setStatus(id, "connecting");
  push(id, { dir: "sys", text: `Connecting to ${item.url}`, trace: traced?.key });
  let ws: WebSocket;
  try {
    ws = new WebSocket(item.url.trim(), protocols.length ? protocols : undefined);
  } catch (e) {
    setStatus(id, "error");
    const text = e instanceof Error ? e.message : String(e);
    push(id, { dir: "err", text });
    settle(false, text);
    return;
  }
  conns.set(id, ws);
  ws.onopen = () => {
    setStatus(id, "open");
    push(id, { dir: "sys", text: ws.protocol ? `Connected (${ws.protocol})` : "Connected" });
    settle(true, "Connected");
  };
  ws.onmessage = (e) => {
    const text =
      typeof e.data === "string"
        ? e.data
        : `[binary, ${e.data instanceof Blob ? e.data.size : (e.data as ArrayBuffer).byteLength} bytes]`;
    push(id, { dir: "in", text });
  };
  ws.onerror = () => push(id, { dir: "err", text: "Connection error" });
  ws.onclose = (e) => {
    if (conns.get(id) === ws) conns.delete(id);
    setStatus(id, e.wasClean ? "closed" : "error");
    const text = `Closed (${e.code}${e.reason ? `: ${e.reason}` : ""})`;
    push(id, { dir: "sys", text });
    settle(false, text);
  };
}

export function sendWs(id: string, text: string, trace?: string): boolean {
  const ws = conns.get(id);
  if (!(ws instanceof WebSocket) || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(text);
  push(id, { dir: "out", text, trace });
  return true;
}

function show(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join("\n");
}

/** Socket.IO payloads are JSON when they parse, plain strings otherwise. */
export function parsePayload(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

export function setIoListen(id: string, events: string[]) {
  ioListen.set(id, events);
}

export function connectIo(item: IoItem, traced?: Traced) {
  const id = item.id;
  disconnect(id);
  const settle = once(traced);
  let auth: Record<string, unknown> | undefined;
  if (item.auth.trim()) {
    try {
      auth = JSON.parse(item.auth);
    } catch {
      setStatus(id, "error");
      push(id, { dir: "err", text: "Auth is not valid JSON" });
      settle(false, "Auth is not valid JSON");
      return;
    }
  }
  setIoListen(id, item.listen);
  setStatus(id, "connecting");
  push(id, { dir: "sys", text: `Connecting to ${item.url}`, trace: traced?.key });
  // WebSocket transport only: long-polling goes through fetch and CORS
  const socket = io(item.url.trim(), {
    path: item.path.trim() || "/socket.io",
    auth,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  conns.set(id, socket);
  socket.on("connect", () => {
    setStatus(id, "open");
    push(id, { dir: "sys", text: `Connected as ${socket.id}` });
    settle(true, "Connected");
  });
  socket.on("connect_error", (err) => {
    setStatus(id, "error");
    push(id, { dir: "err", text: err.message });
    settle(false, err.message);
  });
  socket.on("disconnect", (reason) => {
    if (conns.get(id) === socket) conns.delete(id);
    setStatus(id, "closed");
    push(id, { dir: "sys", text: `Disconnected: ${reason}` });
  });
  socket.onAny((event: string, ...args: unknown[]) => {
    const only = ioListen.get(id) ?? [];
    if (only.length && !only.includes(event)) return;
    push(id, { dir: "in", event, text: show(args) });
  });
}

export function emitIo(id: string, event: string, payloadText: string, trace?: string): boolean {
  const socket = conns.get(id);
  if (!socket || socket instanceof WebSocket || !socket.connected) return false;
  const payload = parsePayload(payloadText);
  const ack = (...args: unknown[]) => push(id, { dir: "in", event: `${event} ack`, text: show(args) });
  if (payload === undefined) socket.emit(event, ack);
  else socket.emit(event, payload, ack);
  push(id, { dir: "out", event, text: payloadText.trim(), trace });
  return true;
}

/** The connection and its log as they are now, outside React */
export const liveOf = (id: string): Live => get(id);
