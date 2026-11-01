/** The shapes agents read and write: headers and kept values as plain
 *  objects, steps without the editor's bookkeeping, the Collections tree as
 *  text, and finding things by id, name or path. */
import {
  displayName,
  kv,
  METHODS,
  methodWord,
  type HttpMethod,
  type ItemType,
  type KV,
  type TreeNode,
} from "../collections/model";
import type { NetworkPlan, NetworkRemoved } from "../docker/api";
import { WHY, type Draft, type NetworkFile, type Question, type Step as ImportStep } from "../docker/share";
import type { Found, Imported } from "../docker/shareRun";
import { flowName, newStep, stepName, type Flow, type Step, type StepType } from "../flows/model";

/** `{ "Accept": "application/json" }`, or a list when some are off */
export type Pairs = Record<string, string> | { key: string; value: string; enabled?: boolean }[];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));

export function kvIn(input: unknown, what: string): KV[] {
  if (input === undefined || input === null) return [];
  if (Array.isArray(input)) {
    return input.map((p, i) => {
      if (!isObject(p) || typeof p.key !== "string") throw new Error(`${what}[${i}] needs a key.`);
      return { ...kv(p.key, p.value === undefined ? "" : str(p.value)), enabled: p.enabled !== false };
    });
  }
  if (isObject(input)) return Object.entries(input).map(([k, v]) => kv(k, v === null ? "" : str(v)));
  throw new Error(`${what} should be an object of names to values.`);
}

export function kvOut(list: KV[]): Pairs {
  const keys = list.map((p) => p.key);
  if (list.every((p) => p.enabled) && new Set(keys).size === keys.length) {
    return Object.fromEntries(list.map((p) => [p.key, p.value]));
  }
  return list.map((p) => ({ key: p.key, value: p.value, ...(!p.enabled && { enabled: false }) }));
}

/** A body given as JSON, as the text sent */
export function bodyIn(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}

/** What a body's type is when not said: JSON when it parses */
export function bodyType(body: string): "json" | "text" | "none" {
  if (!body.trim()) return "none";
  try {
    JSON.parse(body);
    return "json";
  } catch {
    return "text";
  }
}

export function methodIn(v: unknown): HttpMethod {
  const m = String(v).trim().toUpperCase();
  if (!(METHODS as readonly string[]).includes(m)) throw new Error(`method should be one of ${METHODS.join(", ")}.`);
  return m as HttpMethod;
}

// ---- Steps ----

const STEP_TYPES: StepType[] = ["request", "transform", "sheet"];

export function stepOut(step: Step) {
  const base = { id: step.id, type: step.type, name: step.name };
  switch (step.type) {
    case "request":
      return {
        ...base,
        method: step.method,
        url: step.url,
        headers: kvOut(step.headers),
        body_type: step.bodyType,
        body: step.body,
        expect_ok: step.expectOk,
        keep: kvOut(step.keep),
      };
    case "transform":
      return { ...base, as: step.as, code: step.code };
    case "sheet":
      return { ...base, from: step.from, columns: kvOut(step.columns), file: step.file };
  }
}

/** A step from what an agent sent; what it leaves out stays as `old` had it */
export function stepIn(input: unknown, old?: Step): Step {
  if (!isObject(input)) throw new Error("A step should be an object.");
  const type = (input.type ?? old?.type) as StepType;
  if (!STEP_TYPES.includes(type)) throw new Error(`A step's type should be one of ${STEP_TYPES.join(", ")}.`);
  const known = new Set(Object.keys(stepOut(newStep(type))));
  const extra = Object.keys(input).filter((k) => !known.has(k));
  if (extra.length) throw new Error(`A ${type} step has no ${extra.join(", ")}. It takes ${[...known].join(", ")}.`);

  const base = old?.type === type ? old : { ...newStep(type), ...(old && { id: old.id, name: old.name }) };
  const name = input.name === undefined ? base.name : str(input.name);
  const id = typeof input.id === "string" && input.id ? input.id : base.id;
  switch (base.type) {
    case "request": {
      const body = input.body === undefined ? base.body : bodyIn(input.body);
      const given = input.body_type as string | undefined;
      if (given !== undefined && !["none", "json", "text"].includes(given)) {
        throw new Error("body_type should be none, json or text.");
      }
      return {
        ...base,
        id,
        name,
        method: input.method === undefined ? base.method : methodIn(input.method),
        url: input.url === undefined ? base.url : str(input.url),
        headers: input.headers === undefined ? base.headers : kvIn(input.headers, "headers"),
        body,
        bodyType: (given as "none" | "json" | "text" | undefined) ?? (input.body === undefined ? base.bodyType : bodyType(body)),
        expectOk: input.expect_ok === undefined ? base.expectOk : input.expect_ok !== false,
        keep: input.keep === undefined ? base.keep : kvIn(input.keep, "keep"),
      };
    }
    case "transform":
      return {
        ...base,
        id,
        name,
        as: input.as === undefined ? base.as : str(input.as),
        code: input.code === undefined ? base.code : str(input.code),
      };
    case "sheet":
      return {
        ...base,
        id,
        name,
        from: input.from === undefined ? base.from : str(input.from),
        columns: input.columns === undefined ? base.columns : kvIn(input.columns, "columns"),
        file: input.file === undefined ? base.file : str(input.file),
      };
  }
}

export function flowOut(flow: Flow) {
  return { id: flow.id, name: flowName(flow), inputs: kvOut(flow.vars), steps: flow.steps.map(stepOut) };
}

// ---- Finding things ----

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function pick<T>(hits: T[], ref: string, label: (t: T) => string, none: string): T {
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(none);
  throw new Error(`"${ref}" could be ${hits.map(label).join(", ")}. Use the id.`);
}

type Placed = { node: TreeNode; path: string };

function walk(tree: TreeNode[], prefix = ""): Placed[] {
  return tree.flatMap((node) => {
    const path = prefix ? `${prefix}/${displayName(node)}` : displayName(node);
    return [{ node, path }, ...(node.type === "group" ? walk(node.children, path) : [])];
  });
}

/** An item or group by id, path ("Examples/Get JSON") or name */
export function findNode(tree: TreeNode[], ref: string, want?: "group" | ItemType[]): TreeNode {
  const fit = (n: TreeNode) => !want || (want === "group" ? n.type === "group" : n.type !== "group" && want.includes(n.type));
  const all = walk(tree).filter((p) => fit(p.node));
  const byId = all.find((p) => p.node.id === ref.trim());
  if (byId) return byId.node;
  const byPath = all.filter((p) => same(p.path, ref.replace(/^\/+|\/+$/g, "")));
  const hits = byPath.length ? byPath : all.filter((p) => same(displayName(p.node), ref));
  const what = want === "group" ? "group" : want?.length === 1 && want[0] === "http" ? "request" : want ? "connection" : "item";
  return pick(
    hits,
    ref,
    (p) => `${p.path} (${p.node.id})`,
    `Collections has no ${what} called "${ref}". list_collections shows what's there.`,
  ).node;
}

/** The tree as indented lines: each item's kind, name, URL, labels and id */
export function treeText(tree: TreeNode[], depth = 0): string[] {
  const pad = "  ".repeat(depth);
  return tree.flatMap((n) => {
    if (n.type === "group") {
      return [`${pad}- ${displayName(n)}/ · group · id ${n.id}`, ...treeText(n.children, depth + 1)];
    }
    const labels = n.labels.length ? ` · ${n.labels.map((l) => `#${l}`).join(" ")}` : "";
    return [`${pad}- ${methodWord(n)} ${displayName(n)} · ${n.url.trim() || "no URL"}${labels} · id ${n.id}`];
  });
}

export function findFlow(flows: Flow[], ref: string): Flow {
  const byId = flows.find((f) => f.id === ref.trim());
  if (byId) return byId;
  return pick(
    flows.filter((f) => same(flowName(f), ref)),
    ref,
    (f) => `${flowName(f)} (${f.id})`,
    `There's no flow called "${ref}". list_flows shows them.`,
  );
}

/** A step by id, name, or number from 1 */
export function findStep(flow: Flow, ref: string): Step {
  const r = ref.trim();
  const byId = flow.steps.find((s) => s.id === r);
  if (byId) return byId;
  if (/^\d+$/.test(r)) {
    const step = flow.steps[Number(r) - 1];
    if (step) return step;
  }
  return pick(
    flow.steps.filter((s) => same(stepName(s), r)),
    r,
    (s) => `${stepName(s)} (${s.id})`,
    `${flowName(flow)} has no step "${ref}". It has ${flow.steps.length ? flow.steps.map((s, i) => `${i + 1}. ${stepName(s)}`).join(", ") : "no steps"}.`,
  );
}

// ---- Removing a network ----

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const short = (s: string) => (/^[0-9a-f]{64}$/.test(s) ? s.slice(0, 12) : s);

/** What removing a network would do, for a dry run */
export function planText(p: NetworkPlan, images: boolean, volumes: boolean): string {
  const out = [`Removing ${p.network} would:`];
  if (p.containers.length) out.push(`- remove ${plural(p.containers.length, "container")}: ${p.containers.map((c) => `${c.name} (${c.image})`).join(", ")}`);
  if (p.commands.length) out.push(`- stop and delete ${plural(p.commands.length, "command")} from UAT: ${p.commands.map((c) => c.name).join(", ")}`);
  if (p.attached.length) out.push(`- disconnect, and leave running: ${p.attached.map((c) => c.name).join(", ")}`);
  const goImages = p.images.filter((i) => !i.kept);
  if (images && goImages.length) out.push(`- remove ${plural(goImages.length, "image")}: ${goImages.map((i) => `${i.names.map(short).join(", ")} (${i.size})`).join("; ")}`);
  const goVolumes = p.volumes.filter((v) => !v.kept);
  if (volumes && goVolumes.length) out.push(`- remove ${plural(goVolumes.length, "volume")} and their data: ${goVolumes.map((v) => (v.anonymous ? `${short(v.name)} (anonymous)` : v.name)).join(", ")}`);
  const kept = [
    ...p.images.filter((i) => i.kept || !images).map((i) => `${i.names.map(short).join(", ")}${i.kept ? `, ${i.kept}` : ""}`),
    ...p.volumes.filter((v) => v.kept || !volumes).map((v) => `volume ${short(v.name)}${v.kept ? `, ${v.kept}` : ""}`),
  ];
  if (kept.length) out.push(`- keep: ${kept.join("; ")}`);
  if (out.length === 1) out.push("- remove the network only: nothing runs on it");
  if (p.recreated) out.push("", `${p.network} is UAT's default network, so UAT makes it again, empty.`);
  return out.join("\n");
}

export function removedText(r: NetworkRemoved): string {
  const out = [r.recreated ? `Removed ${r.network}; UAT made it again, empty.` : `Removed ${r.network}.`];
  const part = (label: string, list: string[]) => list.length && out.push(`- ${label}: ${list.map(short).join(", ")}`);
  part("containers removed", r.containers);
  part("commands deleted", r.commands);
  part("disconnected", r.disconnected);
  part("images removed", r.images);
  part("volumes removed", r.volumes);
  if (r.kept.length) out.push(`- kept: ${r.kept.join("; ")}`);
  return out.join("\n");
}

// ---- Exporting and importing a network ----

/** What an export holds, what it leaves to be asked for, and the file */
export function exportText(d: Draft, file: NetworkFile, text: string, written: string | null): string {
  const services = Object.keys(file.services);
  const repos = Object.keys(file.repos);
  const asked = d.entries.filter((e) => e.locked || !e.share);
  const out = [
    `${d.network}: ${plural(services.length, "service")}${repos.length ? ` from ${plural(repos.length, "repo")} (${repos.join(", ")})` : ""}.`,
    written ? `Written to ${written}.` : "Not written: give file to save it.",
  ];
  if (asked.length) {
    out.push("", `Asked for on import, not in the file (${asked.length}):`);
    for (const e of asked) {
      const why = e.why ? WHY[e.why] : "chosen to be asked";
      out.push(`- ${e.key}: ${why}${e.locked ? ", always asked" : `; share: ["${e.key}"] puts its value in the file`}`);
    }
  }
  const shared = d.entries.filter((e) => !e.locked && e.share && e.why);
  if (shared.length) out.push("", `Shared though they look like they may not travel: ${shared.map((e) => e.key).join(", ")}`);
  const local = d.images.filter((i) => i.local && !i.build);
  if (local.length) {
    out.push(
      "",
      `Only built on this Mac, so import asks how to get them; build_from names the folder that builds each, and the file its repo:`,
      ...local.map((i) => `- ${i.service}: ${i.image}`),
    );
  }
  const notes = d.notes.filter((n) => !n.local);
  if (notes.length) out.push("", "Notes:", ...notes.map((n) => `- ${n.text}`));
  out.push("", "The file:", "```json", text.trimEnd(), "```");
  return out.join("\n");
}

/** What an import still needs, and which argument answers each */
export function questionsText(qs: Question[], found: Record<string, Found>, network: string): string {
  const out = [`Nothing imported yet: ${plural(qs.length, "answer")} needed for ${network}.`];
  const repos = qs.filter((q) => q.kind === "repo");
  if (repos.length) {
    out.push("", "folders (where each repo is on this Mac, or clone_into to clone the missing ones):");
    for (const q of repos) {
      const named = found[q.key]?.named ?? [];
      const where = q.repo.git ? `${q.repo.git}, not found here` : `not in git; used by ${q.services.join(", ")}`;
      out.push(`- ${q.key}: ${where}${named.length ? `; folders with its name: ${named.join(", ")}` : ""}`);
    }
  }
  const values = qs.filter((q) => q.kind === "value");
  if (values.length) {
    out.push("", "values:");
    for (const q of values) out.push(`- ${q.key}: ${q.why}${q.secret ? " (secret)" : ""}${q.default !== undefined ? `; suggested: ${q.default}` : ""}`);
  }
  const ports = qs.filter((q) => q.kind === "port");
  if (ports.length) {
    out.push("", "ports (a host port, or null to not publish it):");
    for (const q of ports) out.push(`- ${q.key}: ${q.host} is taken here; ${q.suggest} is free`);
  }
  const images = qs.filter((q) => q.kind === "image");
  if (images.length) {
    out.push("", 'images (built on the exporter\'s Mac: "use" it when this Mac has it, "skip", or the folder with the Dockerfile that builds it):');
    for (const q of images) out.push(`- ${q.key}: ${q.image}, ${q.here ? "this Mac has it" : "not on this Mac"}`);
  }
  const attached = qs.filter((q) => q.kind === "attached");
  if (attached.length) {
    out.push("", 'attached ("run" its image, "skip", or the name of a container running here; list_containers shows them):');
    for (const q of attached) out.push(`- ${q.key}: ${q.image}${q.container ? `, was ${q.container}` : ""}`);
  }
  if (values.some((q) => q.default !== undefined) || ports.length) out.push("", "use_defaults takes the suggested values and free ports.");
  return out.join("\n");
}

/** What an import would do, in order */
export function importStepsText(steps: ImportStep[], network: string): string {
  return [
    `Importing would, on ${network}:`,
    ...steps.map((s) =>
      s.kind === "skip"
        ? `- leave ${s.service}: ${s.why}`
        : s.kind === "attach"
          ? `- attach ${s.container} as ${s.service}`
          : s.kind === "command"
            ? `- add ${s.service}: ${s.def.command}, in ${s.def.cwd}`
            : `- add ${s.service}: ${s.req.source.kind === "image" ? s.req.source.image : `built from ${s.req.source.context}`}${s.req.ports.length ? `, ports ${s.req.ports.map((p) => (p.host ? `${p.host}→${p.container}` : p.container)).join(", ")}` : ""}`,
    ),
  ].join("\n");
}

export function importedText(r: Imported, found: string[] = []): string {
  const out = [`Imported into ${r.network}${r.createdNetwork ? ", which was made for it" : ""}.`];
  if (found.length) out.push(...found.map((f) => `- ${f}`));
  for (const a of r.added) out.push(`- added ${a.service}: ${a.what}`);
  for (const s of r.skipped) out.push(`- left ${s.service}: ${s.why}`);
  for (const f of r.failed) out.push(`- ${f.service} failed: ${f.error}`);
  if (r.added.some((a) => a.kind === "command")) out.push("", "Commands are added stopped: start_service starts one once its repo is set up (npm install and the like).");
  return out.join("\n");
}
