/** Runs a flow: each step in order, with the values the earlier ones kept.
 *  The first step that fails stops the flow; the ones after it are skipped.
 *  Sending requests and writing sheets come from `deps`, so this runs the
 *  same in the app and in tests. */
import _ from "lodash";
import type { Flow, RequestStep, SheetStep, Step, TransformStep } from "./model";

export type Vars = Record<string, unknown>;
export type Cell = string | number | boolean | null;

export type Sent = { method: string; url: string; headers: [string, string][]; body?: string };
export type Answer = { status: number; statusText: string; headers: [string, string][]; body: string; ms: number };

export type StepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export type StepRun = {
  status: StepStatus;
  at?: number;
  ms?: number;
  error?: string;
  sent?: Sent;
  answer?: Answer;
  /** Values the step kept, by name */
  kept?: { name: string; value: unknown }[];
  /** What a transform wrote with log() */
  lines?: string[];
  /** The rows a sheet step wrote: the first few, and how many */
  sheet?: { path: string; columns: string[]; rows: Cell[][]; total: number };
};

export type FlowRun = {
  flowId: string;
  /** The flow as it was run, for a report of it after later edits */
  flow: Flow;
  status: "running" | "ok" | "failed" | "stopped";
  at: number;
  ms?: number;
  /** The step that failed */
  failed?: string;
  steps: Record<string, StepRun>;
  /** Every value kept so far, the inputs included */
  vars: Vars;
};

export type Deps = {
  send: (stepId: string, req: Sent, signal: AbortSignal) => Promise<Answer>;
  /** Writes the sheet and returns where it went */
  writeSheet: (sheet: { path: string; columns: string[]; rows: Cell[][] }) => Promise<string>;
};

/** How many of a sheet's rows the log keeps */
const SHEET_PREVIEW = 50;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function withScheme(url: string) {
  const u = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `http://${u}`;
}

// ---- Paths and templates ----

type Seg = string | number | "*";

/** `rides[0].from`, `body.items[*].id`, `headers["content-type"]`, `rides[-1]` */
export function parsePath(path: string): Seg[] {
  const s = path.trim();
  const segs: Seg[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ".") {
      i++;
      continue;
    }
    if (s[i] === "[") {
      const end = s.indexOf("]", i);
      if (end < 0) throw new Error(`${s}: a [ isn't closed`);
      const inner = s.slice(i + 1, end).trim();
      if (inner === "*") segs.push("*");
      else if (/^-?\d+$/.test(inner)) segs.push(Number(inner));
      else if (/^(["']).*\1$/.test(inner)) segs.push(inner.slice(1, -1));
      else throw new Error(`${s}: [${inner}] should be a number, * or a quoted name`);
      i = end + 1;
      continue;
    }
    const name = /^[^.[\]]+/.exec(s.slice(i))![0];
    segs.push(name.trim());
    i += name.length;
  }
  return segs;
}

/** The value at `path` in `root`. Says what isn't there when it isn't. */
export function get(root: unknown, path: string): unknown {
  return walk(root, parsePath(path), 0, "");
}

function walk(value: unknown, segs: Seg[], i: number, at: string): unknown {
  if (i === segs.length) return value;
  const seg = segs[i];
  if (seg === "*") {
    if (!Array.isArray(value)) throw new Error(`${at || "It"} isn't a list`);
    return value.map((v, n) => walk(v, segs, i + 1, `${at}[${n}]`));
  }
  if (typeof seg === "number") {
    if (!Array.isArray(value)) throw new Error(`${at || "It"} isn't a list`);
    const n = seg < 0 ? value.length + seg : seg;
    if (n < 0 || n >= value.length) {
      throw new Error(`${at}[${seg}] isn't there: ${at} has ${value.length} ${value.length === 1 ? "item" : "items"}`);
    }
    return walk(value[n], segs, i + 1, `${at}[${seg}]`);
  }
  const here = at ? `${at}.${seg}` : seg;
  if (Array.isArray(value) && seg === "length") return walk(value.length, segs, i + 1, here);
  if (value === null || typeof value !== "object" || !(seg in value)) {
    throw new Error(at ? `${here} isn't there` : `Nothing is kept as ${seg} yet`);
  }
  return walk((value as Record<string, unknown>)[seg], segs, i + 1, here);
}

/** Fills each `{{path}}` from `vars`: text as it is, anything else as JSON. */
export function render(template: string, vars: Vars): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path: string) => {
    let v: unknown;
    try {
      v = get(vars, path);
    } catch (e) {
      throw new Error(`Couldn't fill in {{${path}}}: ${errText(e)}`);
    }
    return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
  });
}

// ---- Running ----

function copy(run: FlowRun): FlowRun {
  return {
    ...run,
    steps: Object.fromEntries(Object.entries(run.steps).map(([id, s]) => [id, { ...s }])),
    vars: { ...run.vars },
  };
}

/** Runs `flow`, calling `onChange` with a fresh copy whenever something happens. */
export async function runFlow(
  flow: Flow,
  deps: Deps,
  onChange: (run: FlowRun) => void = () => {},
  signal: AbortSignal = new AbortController().signal,
): Promise<FlowRun> {
  const vars: Vars = {};
  for (const v of flow.vars) if (v.enabled && v.key.trim()) vars[v.key.trim()] = v.value;
  const run: FlowRun = {
    flowId: flow.id,
    flow,
    status: "running",
    at: Date.now(),
    steps: Object.fromEntries(flow.steps.map((s) => [s.id, { status: "pending" } as StepRun])),
    vars,
  };
  const emit = () => onChange(copy(run));
  emit();

  for (const [i, step] of flow.steps.entries()) {
    const sr: StepRun = { status: "running", at: Date.now() };
    run.steps[step.id] = sr;
    emit();
    try {
      if (signal.aborted) throw new Error("Stopped");
      await runStep(step, vars, sr, deps, signal, emit);
      sr.status = "ok";
    } catch (e) {
      sr.status = "failed";
      sr.error = signal.aborted ? "Stopped" : errText(e);
      run.status = signal.aborted ? "stopped" : "failed";
      run.failed = step.id;
    }
    sr.ms = Date.now() - sr.at!;
    if (sr.status === "failed") {
      for (const later of flow.steps.slice(i + 1)) run.steps[later.id] = { status: "skipped" };
      break;
    }
    emit();
  }
  if (run.status === "running") run.status = "ok";
  run.ms = Date.now() - run.at;
  emit();
  return copy(run);
}

function runStep(step: Step, vars: Vars, sr: StepRun, deps: Deps, signal: AbortSignal, emit: () => void) {
  switch (step.type) {
    case "request":
      return runRequest(step, vars, sr, deps, signal, emit);
    case "transform":
      return runTransform(step, vars, sr, emit);
    case "sheet":
      return runSheet(step, vars, sr, deps);
  }
}

async function runRequest(
  step: RequestStep,
  vars: Vars,
  sr: StepRun,
  deps: Deps,
  signal: AbortSignal,
  emit: () => void,
) {
  if (!step.url.trim()) throw new Error("This call has no URL");
  const url = withScheme(render(step.url, vars));
  const headers: [string, string][] = step.headers
    .filter((h) => h.enabled && h.key.trim())
    .map((h) => [render(h.key.trim(), vars), render(h.value, vars)]);
  const hasBody = step.method !== "GET" && step.method !== "HEAD" && step.bodyType !== "none";
  const body = hasBody ? render(step.body, vars) : undefined;
  sr.sent = { method: step.method, url, headers, body };
  if (body !== undefined && step.bodyType === "json") {
    try {
      JSON.parse(body);
    } catch (e) {
      throw new Error(`The body isn't JSON once filled in: ${errText(e)}`);
    }
    if (!headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", "application/json"]);
  }
  emit();

  const answer = await deps.send(step.id, sr.sent, signal);
  sr.answer = answer;
  let parsed: unknown = answer.body;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    // Not JSON: keep it as text
  }
  const response = {
    status: answer.status,
    statusText: answer.statusText,
    headers: Object.fromEntries(answer.headers.map(([k, v]) => [k.toLowerCase(), v])),
    body: parsed,
  };
  if (step.expectOk && (answer.status < 200 || answer.status >= 300)) {
    throw new Error(`Answered ${answer.status} ${answer.statusText}`.trim());
  }
  sr.kept = [];
  for (const k of step.keep) {
    const name = k.key.trim();
    if (!k.enabled || !name) continue;
    try {
      vars[name] = get(response, k.value.trim() || "body");
    } catch (e) {
      throw new Error(`Couldn't keep ${name}: ${errText(e)}`);
    }
    sr.kept.push({ name, value: vars[name] });
  }
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval vars log _".split(
    " ",
  ),
);

/** Whether a kept value can be used by its name in a transform */
export const inScope = (name: string) => IDENT.test(name) && !RESERVED.has(name);

async function runTransform(step: TransformStep, vars: Vars, sr: StepRun, emit: () => void) {
  const lines: string[] = [];
  sr.lines = lines;
  const log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    emit();
  };
  // Every kept value by its name too, as copies, so the earlier steps' logs stay as
  // they were; lodash is `_`
  const scope = structuredClone(vars);
  const names = Object.keys(scope).filter(inScope);
  let fn: (...args: unknown[]) => unknown;
  try {
    fn = new Function(...names, "vars", "log", "_", `"use strict";\n${step.code}`) as typeof fn;
  } catch (e) {
    throw new Error(`The code doesn't parse: ${errText(e)}`);
  }
  const out = await fn(...names.map((n) => scope[n]), scope, log, _);
  const as = step.as.trim();
  if (as) {
    vars[as] = out;
    sr.kept = [{ name: as, value: out }];
  }
}

function cell(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v);
}

async function runSheet(step: SheetStep, vars: Vars, sr: StepRun, deps: Deps) {
  if (!step.from.trim()) throw new Error("Say which list the rows come from");
  let list: unknown;
  try {
    list = get(vars, step.from);
  } catch (e) {
    throw new Error(`No rows: ${errText(e)}`);
  }
  if (!Array.isArray(list)) throw new Error(`${step.from.trim()} isn't a list`);

  let columns = step.columns
    .filter((c) => c.enabled && (c.key.trim() || c.value.trim()))
    .map((c) => ({ header: c.key.trim() || c.value.trim(), path: c.value.trim() || c.key.trim() }));
  if (!columns.length) {
    // Every field of the rows, in the order they first appear
    const keys = new Set<string>();
    for (const row of list.slice(0, 100)) {
      if (row && typeof row === "object" && !Array.isArray(row)) Object.keys(row).forEach((k) => keys.add(k));
    }
    columns = keys.size
      ? [...keys].map((k) => ({ header: k, path: `[${JSON.stringify(k)}]` }))
      : [{ header: step.from.trim(), path: "" }];
  }
  const rows = list.map((item) =>
    columns.map((c) => {
      try {
        return cell(get(item, c.path));
      } catch {
        return null;
      }
    }),
  );
  const file = render(step.file, vars).trim();
  if (!file) throw new Error("Choose the file the sheet goes to");
  const headers = columns.map((c) => c.header);
  const path = await deps.writeSheet({ path: file, columns: headers, rows });
  sr.sheet = { path, columns: headers, rows: rows.slice(0, SHEET_PREVIEW), total: rows.length };
}
