/** Flows: steps run in order, each able to use what the earlier ones kept.
 *  An API call keeps values from its answer, a transform reshapes them with
 *  a little JavaScript, a sheet writes rows to a file. Saved as one JSON
 *  document beside the Collections workspace. */
import { kv, uid, type HttpMethod, type KV } from "../collections/model";

export type RequestStep = {
  id: string;
  type: "request";
  name: string;
  method: HttpMethod;
  /** `{{name}}` is filled in from what earlier steps kept, here and below */
  url: string;
  headers: KV[];
  bodyType: "none" | "json" | "text";
  body: string;
  /** Stop the flow unless the answer is 2xx */
  expectOk: boolean;
  /** Values to keep: key is the name, value a path into { status, headers, body } */
  keep: KV[];
};

export type TransformStep = {
  id: string;
  type: "transform";
  name: string;
  /** The name the returned value is kept as */
  as: string;
  code: string;
};

export type SheetStep = {
  id: string;
  type: "sheet";
  name: string;
  /** A path to the list the rows come from */
  from: string;
  /** key is the column's header, value a path into each row */
  columns: KV[];
  /** .xlsx or .csv */
  file: string;
};

export type Step = RequestStep | TransformStep | SheetStep;
export type StepType = Step["type"];

export type Flow = {
  id: string;
  name: string;
  /** Inputs every step can use */
  vars: KV[];
  steps: Step[];
};

export type FlowsDoc = { version: 1; flows: Flow[] };

export const STEP_WORD: Record<StepType, string> = { request: "API call", transform: "Transform", sheet: "Sheet" };

export function newStep(type: StepType): Step {
  const id = uid();
  switch (type) {
    case "request":
      return { id, type, name: "", method: "GET", url: "", headers: [], bodyType: "none", body: "", expectOk: true, keep: [] };
    case "transform":
      return { id, type, name: "", as: "result", code: "// What earlier steps kept is in scope by name; lodash is _\nreturn vars;\n" };
    case "sheet":
      return { id, type, name: "", from: "", columns: [], file: "~/Documents/UAT/sheet.xlsx" };
  }
}

export function newFlow(): Flow {
  return { id: uid(), name: "", vars: [kv("base", "http://localhost:3000")], steps: [] };
}

export function stepName(step: Step): string {
  if (step.name.trim()) return step.name;
  if (step.type === "request") return step.url.trim() ? `${step.method} ${step.url.trim()}` : "Untitled call";
  return `Untitled ${STEP_WORD[step.type].toLowerCase()}`;
}

export function flowName(flow: Flow): string {
  return flow.name.trim() || "Untitled flow";
}

/** A value kept before a step, and where it came from */
export type Kept = { name: string; source: string };

/** What every step before `index` keeps, the inputs first; a later one of the same name wins */
export function keptBefore(flow: Flow, index: number): Kept[] {
  const kept = new Map<string, string>();
  for (const v of flow.vars) if (v.enabled && v.key.trim()) kept.set(v.key.trim(), "An input");
  for (const s of flow.steps.slice(0, index)) {
    if (s.type === "request") {
      for (const k of s.keep) {
        if (k.enabled && k.key.trim()) kept.set(k.key.trim(), `Kept by ${stepName(s)}, from ${k.value.trim() || "body"}`);
      }
    }
    if (s.type === "transform" && s.as.trim()) kept.set(s.as.trim(), `Returned by ${stepName(s)}`);
  }
  return [...kept].map(([name, source]) => ({ name, source }));
}
