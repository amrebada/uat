/** What a transform's code can use, as TypeScript declarations for the
 *  editor's suggestions: each kept value typed from what the last run kept
 *  (a list of rides is `{ id: string; from: string; ... }[]`), `vars`, `log`
 *  and `console`. Lodash's own declarations are added beside these. */
import { inScope } from "../engine";
import type { Kept } from "../model";

/** Deeper than this, a value is `any` */
const MAX_DEPTH = 6;
/** How many items of a list, and fields of an object, go into its type */
const SAMPLE = 50;
const MAX_FIELDS = 200;

const prop = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** One type covering every value in `values`: fields missing from some objects are optional */
export function typeOf(values: unknown[], depth = 0): string {
  return union(values, depth).join(" | ");
}

function union(values: unknown[], depth: number): string[] {
  if (depth > MAX_DEPTH) return ["any"];
  const parts = new Set<string>();
  const objects: Record<string, unknown>[] = [];
  const arrays: unknown[][] = [];
  for (const v of values) {
    if (Array.isArray(v)) arrays.push(v);
    else if (isObject(v)) objects.push(v);
    else if (v === null) parts.add("null");
    else if (v === undefined) parts.add("undefined");
    else if (["string", "number", "boolean"].includes(typeof v)) parts.add(typeof v);
    else parts.add("any");
  }
  if (objects.length) {
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))].slice(0, MAX_FIELDS);
    const fields = keys.map((k) => {
      const having = objects.filter((o) => k in o);
      const optional = having.length < objects.length ? "?" : "";
      return `${prop(k)}${optional}: ${typeOf(
        having.map((o) => o[k]),
        depth + 1,
      )}`;
    });
    parts.add(fields.length ? `{ ${fields.join("; ")} }` : "{}");
  }
  if (arrays.length) {
    const items = arrays.flatMap((a) => a.slice(0, SAMPLE));
    const item = union(items, depth + 1);
    parts.add(!items.length ? "any[]" : item.length > 1 ? `(${item.join(" | ")})[]` : `${item[0]}[]`);
  }
  return parts.size ? [...parts] : ["any"];
}

const doc = (text: string) => `/** ${text.replace(/\*\//g, "* /")} */`;

/** The declarations for a transform after `kept`, with the values a run kept, if any */
export function scopeDeclarations(kept: Kept[], values: Record<string, unknown>): string {
  const typed = kept.map((k) => ({
    ...k,
    type: k.name in values ? typeOf([values[k.name]]) : "any",
    known: k.name in values,
  }));
  const lines = typed
    .filter((k) => inScope(k.name))
    .map((k) => `${doc(`${k.source}.${k.known ? "" : " Run the flow to know its shape."}`)}\ndeclare const ${k.name}: ${k.type};`);
  return [
    ...lines,
    doc("Everything kept before this step, by name."),
    `declare const vars: { ${typed.map((k) => `${prop(k.name)}: ${k.type}`).join("; ")} };`,
    doc("Writes to this step's log."),
    "declare function log(...values: unknown[]): void;",
    "declare const console: { log(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void };",
    "",
  ].join("\n");
}
