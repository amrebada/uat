/** Call traces: which service a call from Collections reached, what that
 *  service called, and the services' output while it ran. Rust watches the
 *  network; after the call this reads back what happened in its window. */
import { useSyncExternalStore } from "react";
import { call, inTauri, message } from "../lib/tauri";

export type HopState = "ok" | "pending" | "refused" | "unresolved" | "timeout" | "failed";

export type TraceRequest = {
  at: number;
  method: string;
  path: string;
  status: number | null;
  error: string | null;
  ms: number | null;
};

/** One service calling one other thing during the call, however many times. */
export type Hop = {
  from: string;
  to: string;
  kind: "service" | "external";
  port: number | null;
  state: HopState;
  error: string | null;
  at: number;
  count: number;
  failed: number;
  requests: TraceRequest[];
};

export type TraceNode = { name: string; kind: "container" | "process"; watched: boolean };
export type Trace = { network: string; entry: string; from: number; to: number; hops: Hop[]; nodes: TraceNode[] };
export type Entry = { network: string; service: string; kind: "container" | "process"; watching: boolean };
export type TraceLine = { at: number; stream: "out" | "err" | "sys"; text: string };
export type ServiceLines = { service: string; lines: TraceLine[] };

/** The call as Collections saw it. */
export type Origin = {
  /** "GET /rides", "Connect", "emit ride:request" */
  label: string;
  /** "200 OK", "Connected", the error */
  outcome: string;
  ok: boolean;
  at: number;
  end: number;
};

export type TraceState =
  | { status: "preparing" }
  | { status: "none" }
  | { status: "collecting"; origin: Origin; entry: Entry }
  | { status: "ready"; origin: Origin; entry: Entry; trace: Trace; logs: ServiceLines[] }
  | { status: "error"; error: string };

// In a plain browser during development, show a sample instead
const sample = !inTauri && import.meta.env.DEV;

export const traceApi = {
  prepare: (url: string): Promise<Entry | null> =>
    sample
      ? Promise.resolve(/\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) ? SAMPLE_ENTRY : null)
      : inTauri
        ? call<Entry | null>("trace_prepare", { url })
        : Promise.resolve(null),
  query: (network: string, entry: string, from: number, to: number) =>
    sample ? Promise.resolve(sampleTrace(from)) : call<Trace>("trace_query", { network, entry, from, to }),
  logs: (network: string, services: string[], from: number, to: number) =>
    sample ? Promise.resolve(sampleLogs(from)) : call<ServiceLines[]>("trace_logs", { network, services, from, to }),
  /** Builds the capture image ahead of the first call */
  warm: () => (inTauri ? call<void>("trace_warm").catch(() => {}) : Promise.resolve()),
};

// ---- Following a call ----

/** How long a call waits for its network to be watched, the first time */
const PREPARE_WAIT = 4000;
/** What a service does after it answers still belongs to the call */
const GRACE = 700;

const traces = new Map<string, TraceState>();
const generation = new Map<string, number>();
const entries = new Map<string, Entry | null>();
const listeners = new Set<() => void>();

function put(key: string, state: TraceState) {
  traces.set(key, state);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTrace(key: string | null): TraceState | undefined {
  return useSyncExternalStore(subscribe, () => (key ? traces.get(key) : undefined));
}

/** The trace `key` as it is now, outside React */
export const traceState = (key: string): TraceState | undefined => traces.get(key);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Starts watching the network `url` reaches, ahead of a call to it. */
export function prepareTrace(url: string): Promise<Entry | null> {
  const p = traceApi.prepare(url.trim());
  p.then((e) => entries.set(url.trim(), e)).catch(() => {});
  return p;
}

/** The service a URL reached the last time it was traced. */
export function knownEntry(url: string): Entry | null | undefined {
  return entries.get(url.trim());
}

/** Begins the trace `key` for a call about to go to `url`. Waits a moment
 *  for the network to be watched; call the returned function with what
 *  the call did once it's answered. */
export async function beginTrace(key: string, url: string): Promise<(origin: Origin) => void> {
  const gen = (generation.get(key) ?? 0) + 1;
  generation.set(key, gen);
  put(key, { status: "preparing" });
  const prepared = prepareTrace(url);
  await Promise.race([prepared.catch(() => null), sleep(PREPARE_WAIT)]);
  return (origin) => {
    prepared.then(
      (entry) => collect(key, gen, entry, origin),
      (e) => generation.get(key) === gen && put(key, { status: "error", error: message(e) }),
    );
  };
}

/** A trace for a call whose service is already known, like a socket
 *  message: it has no answer, so what follows for `grace` ms is its. */
export function traceAfter(key: string, entry: Entry | null, origin: Origin, grace = GRACE) {
  const gen = (generation.get(key) ?? 0) + 1;
  generation.set(key, gen);
  collect(key, gen, entry, origin, grace);
}

async function collect(key: string, gen: number, entry: Entry | null, origin: Origin, grace = GRACE) {
  const current = () => generation.get(key) === gen;
  if (!entry) {
    if (current()) put(key, { status: "none" });
    return;
  }
  put(key, { status: "collecting", origin, entry });
  const to = origin.end + grace;
  await sleep(Math.max(0, to - Date.now()));
  try {
    const trace = await traceApi.query(entry.network, entry.service, origin.at, to);
    const logs = await traceApi.logs(
      entry.network,
      trace.nodes.map((n) => n.name),
      origin.at,
      to,
    );
    if (current()) put(key, { status: "ready", origin, entry, trace, logs });
  } catch (e) {
    if (current()) put(key, { status: "error", error: message(e) });
  }
}

/** Whether any call in a finished trace failed, for the tab's dot. */
export function traceTone(state: TraceState | undefined): "ok" | "bad" | "busy" | null {
  if (!state) return null;
  if (state.status === "preparing" || state.status === "collecting") return "busy";
  if (state.status !== "ready") return null;
  return !state.origin.ok || state.trace.hops.some((h) => h.state !== "ok" && h.state !== "pending") ? "bad" : "ok";
}

// ---- Sample for the browser preview ----

const SAMPLE_ENTRY: Entry = { network: "uat-net", service: "rides-api", kind: "container", watching: true };

function sampleTrace(from: number): Trace {
  const hop = (h: Partial<Hop> & Pick<Hop, "from" | "to" | "at">): Hop => ({
    kind: "service",
    port: null,
    state: "ok",
    error: null,
    count: 1,
    failed: 0,
    requests: [],
    ...h,
  });
  return {
    network: "uat-net",
    entry: "rides-api",
    from,
    to: from + 900,
    nodes: [
      { name: "rides-api", kind: "container", watched: true },
      { name: "postgres", kind: "container", watched: true },
      { name: "drivers", kind: "process", watched: true },
      { name: "redis", kind: "container", watched: true },
    ],
    hops: [
      hop({ from: "rides-api", to: "postgres", port: 5432, at: from + 4, count: 2 }),
      hop({
        from: "rides-api",
        to: "drivers",
        port: 4000,
        at: from + 11,
        requests: [
          { at: from + 11, method: "GET", path: "/drivers/nearby?lat=33.59&lng=-7.62", status: 200, error: null, ms: 14 },
        ],
      }),
      hop({ from: "drivers", to: "redis", port: 6379, at: from + 13 }),
      hop({ from: "rides-api", to: "payments", state: "unresolved", error: "Not found on uat-net", at: from + 27, failed: 1 }),
      hop({ from: "rides-api", to: "maps.googleapis.com", kind: "external", port: 443, at: from + 29 }),
    ],
  };
}

function sampleLogs(from: number): ServiceLines[] {
  return [
    {
      service: "rides-api",
      lines: [
        { at: from + 2, stream: "out", text: "→ GET /rides?status=open" },
        { at: from + 28, stream: "err", text: "Error: getaddrinfo ENOTFOUND payments" },
        { at: from + 29, stream: "err", text: "    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26)" },
        { at: from + 41, stream: "out", text: "← 200 GET /rides?status=open 41ms" },
      ],
    },
    { service: "postgres", lines: [] },
    {
      service: "drivers",
      lines: [{ at: from + 12, stream: "out", text: "nearby: 7 drivers within 2km" }],
    },
    { service: "redis", lines: [] },
  ];
}
