/** A report of a flow's run, to export: a summary of every step, then each
 *  step in full (what it sent and got back, what it kept, its log, its sheet,
 *  the calls its request led to). One HTML page, or Markdown. Values that
 *  look secret are hidden unless `secrets` is set. */
import type { Hop, HopState, TraceState } from "../trace/api";
import { flowName, STEP_WORD, stepName, type Step } from "./model";
import type { FlowRun, StepRun, StepStatus } from "./engine";
import { clip, kind, pretty, size } from "./text";

export type ReportFormat = "html" | "md";

export type ReportOptions = {
  /** Show values that look secret as they are */
  secrets?: boolean;
  /** A request step's trace */
  trace?: (stepId: string) => TraceState | undefined;
  /** When the report is made; now by default */
  made?: Date;
  /** The steps shown in full, by id; every step when unset */
  only?: string[];
};

export function report(run: FlowRun, format: ReportFormat, opts: ReportOptions = {}): string {
  const model = build(run, opts);
  return format === "html" ? html(model) : markdown(model);
}

/** "Book an open ride 2026-11-01 17-39.html" */
export function reportFile(run: FlowRun, format: ReportFormat): string {
  const d = new Date(run.at);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
  const name = flowName(run.flow).replace(/[/:\\]/g, "-").trim();
  return `${name} ${stamp}.${format}`;
}

// ---- What the report says ----

type Tone = "ok" | "bad" | "stopped" | "running";

type HopRow = { from: string; to: string; ok: boolean; result: string; requests: string[] };

type StepPart = {
  id: string;
  n: number;
  name: string;
  type: string;
  status: StepStatus;
  word: string;
  /** "API call · 17:39:37 · 130 ms" */
  meta: string;
  /** How long it took, when it ran */
  time: string;
  /** One line for the summary */
  result: string;
  error?: string;
  /** Why it didn't run */
  note?: string;
  sent?: { method: string; url: string; headers: [string, string][]; body?: string };
  answer?: { status: number; text: string; meta: string; headers: [string, string][]; body: string };
  code?: string;
  lines?: string[];
  sheet?: { path: string; columns: string[]; rows: string[][]; total: number };
  kept: { name: string; kind: string; text: string }[];
  trace?: { reached?: string; note?: string; hops: HopRow[]; logs: { service: string; lines: string[] }[] };
};

type Model = {
  name: string;
  tone: Tone;
  verdict: string;
  started: string;
  took: string;
  counts: string;
  inputs: { name: string; value: string }[];
  steps: StepPart[];
  /** The steps shown in full */
  details: StepPart[];
  hidden: boolean;
  made: string;
};

const STATUS_WORD: Record<StepStatus, string> = {
  pending: "Not run",
  running: "Running",
  ok: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

const HOP_WORD: Record<HopState, string> = {
  ok: "connected",
  pending: "connecting",
  refused: "refused",
  unresolved: "not found",
  timeout: "timed out",
  failed: "failed",
};

const took = (ms?: number) =>
  ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const date = (at: number | Date) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
const clock = (at: number, ms = false) => {
  const d = new Date(at);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return ms ? `${t}.${String(d.getMilliseconds()).padStart(3, "0")}` : t;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const basename = (path: string) => path.split("/").pop() || path;

// ---- Secrets ----

/** Header, input and kept names whose values are hidden */
const SECRET_NAME = /authoriz|\bauth\b|cookie|token|secret|passw|api[-_]?key|session|credential/i;
const HIDDEN = "••••••";
/** Shorter secrets are hidden where they're named, but not looked for elsewhere: they'd match too much */
const SECRET_MIN = 6;

/** Hides secret values: by name where they're named, and wherever else they turn up */
function masker(run: FlowRun, show: boolean) {
  if (show) return { text: (s: string) => s, named: (_name: string, s: string) => s };
  const found = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (s.length >= SECRET_MIN) found.add(s);
    // "Bearer abc…": the credential alone, too
    const cred = /^\S+\s+(\S+)$/.exec(s)?.[1];
    if (cred && cred.length >= SECRET_MIN) found.add(cred);
  };
  const header = ([k, v]: [string, string]) => {
    if (!SECRET_NAME.test(k)) return;
    add(v);
    // Cookies: each value too
    if (/cookie/i.test(k)) for (const m of v.matchAll(/(?:^|;)\s*[^=;\s]+=([^;]*)/g)) add(m[1]);
  };
  for (const v of run.flow.vars) if (v.enabled && SECRET_NAME.test(v.key)) add(v.value);
  for (const [name, v] of Object.entries(run.vars)) if (SECRET_NAME.test(name)) add(v);
  for (const sr of Object.values(run.steps)) {
    sr.sent?.headers.forEach(header);
    sr.answer?.headers.forEach(header);
  }
  // Longest first, so a credential inside a longer secret doesn't leave the rest showing
  const secrets = [...found].sort((a, b) => b.length - a.length);
  const text = (s: string) => secrets.reduce((t, secret) => t.split(secret).join(HIDDEN), s);
  return { text, named: (name: string, s: string) => (SECRET_NAME.test(name) ? HIDDEN : text(s)) };
}

// ---- Building it ----

function build(run: FlowRun, opts: ReportOptions): Model {
  const mask = masker(run, !!opts.secrets);
  const steps = run.flow.steps;
  const failedAt = steps.findIndex((s) => s.id === run.failed);
  const failed = failedAt >= 0 ? `step ${failedAt + 1}, ${stepName(steps[failedAt])}` : "a step";
  const verdict =
    run.status === "ok"
      ? `Passed: ${steps.length === 1 ? "the step" : `all ${steps.length} steps`}`
      : run.status === "failed"
        ? `Failed at ${failed}`
        : run.status === "stopped"
          ? `Stopped at ${failed}`
          : "Still running";

  const count = (s: StepStatus) => steps.filter((x) => run.steps[x.id]?.status === s).length;
  const counts = [
    [count("ok"), "passed"],
    [count("failed"), "failed"],
    [count("skipped"), "skipped"],
  ]
    .filter(([n]) => n)
    .map(([n, w]) => `${n} ${w}`)
    .join(" · ");

  const parts = steps.map((s, i) => stepPart(s, i, run, opts, mask));
  return {
    name: flowName(run.flow),
    tone: run.status === "ok" ? "ok" : run.status === "failed" ? "bad" : run.status,
    verdict,
    started: date(run.at),
    took: took(run.ms),
    counts: counts || plural(steps.length, "step"),
    inputs: run.flow.vars
      .filter((v) => v.enabled && v.key.trim())
      .map((v) => ({ name: v.key.trim(), value: mask.named(v.key, v.value) })),
    steps: parts,
    details: opts.only ? parts.filter((p) => opts.only?.includes(p.id)) : parts,
    hidden: !opts.secrets,
    made: date(opts.made ?? new Date()),
  };
}

function stepPart(
  step: Step,
  i: number,
  run: FlowRun,
  opts: ReportOptions,
  mask: ReturnType<typeof masker>,
): StepPart {
  const sr: StepRun = run.steps[step.id] ?? { status: "pending" };
  const failedStep = run.flow.steps.find((s) => s.id === run.failed);
  const part: StepPart = {
    id: step.id,
    n: i + 1,
    name: stepName(step),
    type: STEP_WORD[step.type],
    status: sr.status,
    word: STATUS_WORD[sr.status],
    meta: [STEP_WORD[step.type], sr.at && clock(sr.at), took(sr.ms)].filter(Boolean).join(" · "),
    time: sr.status === "ok" || sr.status === "failed" ? took(sr.ms) : "",
    result: "",
    error: sr.error && mask.text(sr.error),
    kept: (sr.kept ?? []).map((k) => ({
      name: k.name,
      kind: kind(k.value),
      text: mask.named(
        k.name,
        clip(k.value === undefined ? "undefined" : typeof k.value === "string" ? k.value : JSON.stringify(k.value, null, 2)),
      ),
    })),
  };
  if (sr.status === "skipped") {
    part.note =
      run.status === "stopped"
        ? "The run was stopped before this step."
        : `${failedStep ? stepName(failedStep) : "A step"} failed before this step.`;
  }

  if (sr.sent) {
    part.sent = {
      method: sr.sent.method,
      url: mask.text(sr.sent.url),
      headers: sr.sent.headers.map(([k, v]) => [k, mask.named(k, v)]),
      body: sr.sent.body === undefined ? undefined : mask.text(pretty(sr.sent.body)),
    };
  }
  if (sr.answer) {
    const a = sr.answer;
    part.answer = {
      status: a.status,
      text: `${a.status} ${a.statusText}`.trim(),
      meta: `${took(a.ms)} · ${size(new TextEncoder().encode(a.body).length)}`,
      headers: a.headers.map(([k, v]) => [k, mask.named(k, v)]),
      body: mask.text(pretty(a.body)),
    };
  }
  if (step.type === "transform") {
    part.code = step.code.trim();
    if (sr.status !== "skipped" && sr.status !== "pending") part.lines = (sr.lines ?? []).map(mask.text);
  }
  if (sr.sheet) {
    part.sheet = {
      path: sr.sheet.path,
      columns: sr.sheet.columns,
      rows: sr.sheet.rows.map((row) => row.map((c) => mask.text(c === null ? "" : String(c)))),
      total: sr.sheet.total,
    };
  }
  if (step.type === "request") part.trace = tracePart(opts.trace?.(step.id), mask.text);

  // One line for the summary
  const keptNames = part.kept.map((k) => k.name).join(", ");
  if (sr.status === "failed") part.result = part.error ?? "Failed";
  else if (sr.status !== "ok") part.result = part.word;
  else if (step.type === "request") part.result = [part.answer?.text, keptNames && `kept ${keptNames}`].filter(Boolean).join(" · ");
  else if (step.type === "transform") {
    const k = part.kept[0];
    const logged = part.lines?.length ? plural(part.lines.length, "line") + " logged" : "";
    part.result = [k ? `returned ${k.name} (${k.kind})` : "ran", logged].filter(Boolean).join(" · ");
  } else if (part.sheet) part.result = `${plural(part.sheet.total, "row")} to ${basename(part.sheet.path)}`;
  return part;
}

function hopResult(h: Hop) {
  if (h.state !== "ok" && h.state !== "pending") return h.error ?? HOP_WORD[h.state];
  return h.count > 1 ? `${HOP_WORD[h.state]} ${h.count} times` : HOP_WORD[h.state];
}

function tracePart(state: TraceState | undefined, mask: (s: string) => string): StepPart["trace"] {
  if (!state || state.status === "none") return undefined;
  if (state.status === "error") return { note: `Couldn't read the trace: ${state.error}`, hops: [], logs: [] };
  if (state.status !== "ready") return { note: "The trace was still being read when this was exported.", hops: [], logs: [] };
  const { entry, trace, logs } = state;
  return {
    reached: `${entry.service} on ${entry.network}`,
    hops: trace.hops.map((h) => ({
      from: h.from,
      to: `${h.to}${h.port ? `:${h.port}` : ""}`,
      ok: h.state === "ok" || h.state === "pending",
      result: hopResult(h),
      requests: h.requests.map((r) =>
        mask(
          `${r.method} ${r.path} → ${r.status ?? r.error ?? "no answer"}${r.ms !== null ? ` · ${took(r.ms)}` : ""}`,
        ),
      ),
    })),
    logs: logs
      .filter((s) => s.lines.length)
      .map((s) => ({
        service: s.service,
        lines: s.lines.map((l) => `${clock(l.at, true)} ${l.stream === "err" ? "!" : " "} ${mask(l.text)}`),
      })),
  };
}

// ---- HTML ----

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Long values start folded; printing unfolds everything */
const FOLD_LINES = 8;

function htmlHeaders(headers: [string, string][]) {
  return `<table class="kv">${headers.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
}

function htmlStep(s: StepPart): string {
  const out: string[] = [];
  const h4 = (title: string, aside = "") => `<h4>${title}${aside && ` <span class="aside">${aside}</span>`}</h4>`;
  if (s.error) out.push(`<p class="error">${esc(s.error)}</p>`);
  if (s.note) out.push(`<p class="note">${esc(s.note)}</p>`);
  if (s.sent) {
    out.push(h4("Sent"), `<p class="req"><b class="method">${esc(s.sent.method)}</b> <span>${esc(s.sent.url)}</span></p>`);
    if (s.sent.headers.length) out.push(htmlHeaders(s.sent.headers));
    if (s.sent.body !== undefined) out.push(`<pre>${esc(s.sent.body)}</pre>`);
  }
  if (s.answer) {
    const a = s.answer;
    out.push(h4("Answer", `<span class="code" data-class="${String(a.status)[0]}">${esc(a.text)}</span> · ${esc(a.meta)}`));
    if (a.headers.length) out.push(`<details><summary>Headers (${a.headers.length})</summary>${htmlHeaders(a.headers)}</details>`);
    out.push(`<pre>${esc(a.body) || " "}</pre>`);
  }
  if (s.code !== undefined) out.push(h4("Code"), `<pre class="src">${esc(s.code)}</pre>`);
  if (s.lines) {
    out.push(h4("Log"), s.lines.length ? `<pre>${esc(s.lines.join("\n"))}</pre>` : `<p class="faint">Nothing logged</p>`);
  }
  if (s.sheet) {
    const sh = s.sheet;
    out.push(
      h4("Sheet", `${plural(sh.total, "row")} · ${plural(sh.columns.length, "column")}`),
      `<p class="file">${esc(sh.path)}</p>`,
      `<div class="scroll"><table class="grid"><thead><tr>${sh.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${sh.rows
        .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`,
    );
    if (sh.total > sh.rows.length) out.push(`<p class="faint">The first ${sh.rows.length} of ${sh.total} rows.</p>`);
  }
  if (s.kept.length) {
    out.push(h4("Kept"));
    for (const k of s.kept) {
      const open = k.text.split("\n").length <= FOLD_LINES ? " open" : "";
      out.push(
        `<details class="val"${open}><summary><code>${esc(k.name)}</code><span class="faint">${esc(k.kind)}</span></summary><pre>${esc(k.text)}</pre></details>`,
      );
    }
  }
  if (s.trace) {
    const t = s.trace;
    out.push(h4("Calls it led to", t.reached ? `reached ${esc(t.reached)}` : ""));
    if (t.note) out.push(`<p class="faint">${esc(t.note)}</p>`);
    else if (!t.hops.length) out.push(`<p class="faint">It called nothing else.</p>`);
    else {
      out.push(
        `<table class="hops">${t.hops
          .map(
            (h) =>
              `<tr data-ok="${h.ok}"><td>${esc(h.from)}</td><td class="arrow">→</td><td>${esc(h.to)}</td><td>${esc(h.result)}${h.requests
                .map((r) => `<div class="mono">${esc(r)}</div>`)
                .join("")}</td></tr>`,
          )
          .join("")}</table>`,
      );
    }
    for (const l of t.logs) {
      out.push(`<details><summary>${esc(l.service)} log (${plural(l.lines.length, "line")})</summary><pre>${esc(l.lines.join("\n"))}</pre></details>`);
    }
  }
  return `<article class="step" id="step-${s.n}" data-status="${s.status}">
<header><span class="n">${s.n}</span><h3>${esc(s.name)}</h3><span class="pill" data-status="${s.status}">${s.word}</span><span class="meta">${esc(s.meta)}</span></header>
${out.join("\n")}
</article>`;
}

function html(m: Model): string {
  const inputs = m.inputs.length
    ? `<section><h2>Inputs</h2><table class="kv">${m.inputs.map((v) => `<tr><th>${esc(v.name)}</th><td>${esc(v.value)}</td></tr>`).join("")}</table></section>`
    : "";
  const rows = m.steps
    .map(
      (s) =>
        `<tr data-status="${s.status}"><td class="n">${s.n}</td><td><a href="#step-${s.n}">${esc(s.name)}</a><span class="type">${s.type}</span></td><td><span class="pill" data-status="${s.status}">${s.word}</span></td><td class="num">${esc(s.time)}</td><td class="res">${esc(s.result)}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.name)} · Flow report</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="top">
<p class="eyebrow">Flow report</p>
<h1>${esc(m.name)}</h1>
<p class="verdict" data-tone="${m.tone}"><span class="dot"></span>${esc(m.verdict)}</p>
<dl class="facts">
<div><dt>Started</dt><dd>${esc(m.started)}</dd></div>
<div><dt>Took</dt><dd>${esc(m.took)}</dd></div>
<div><dt>Steps</dt><dd>${esc(m.counts)}</dd></div>
</dl>
</header>
${inputs}
<section>
<h2>Summary</h2>
<div class="scroll"><table class="sum">
<thead><tr><th>#</th><th>Step</th><th>Status</th><th class="num">Time</th><th>Result</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
</section>
${m.details.length ? `<section>\n<h2>Details</h2>\n${m.details.map(htmlStep).join("\n")}\n</section>\n` : ""}<footer>Exported from UAT on ${esc(m.made)}.${m.hidden ? " Values that look secret are hidden: headers like Authorization and Cookie, and inputs and kept values named like a token, key or password." : ""}</footer>
</main>
<script>addEventListener("beforeprint", () => document.querySelectorAll("details").forEach((d) => (d.open = true)));</script>
</body>
</html>
`;
}

const CSS = `
:root {
  --bg: #f6f6f5; --card: #fff; --line: #e7e7e5; --text: #4d4d4a; --strong: #1c1c1b; --faint: #8f8f8a;
  --tint: #f3f3f1; --accent: #2f66e8; --ok: #1f9d57; --ok-soft: #e4f4ea; --bad: #e5484d; --bad-soft: #fdecec;
  --warn: #c27c00; --skip: #a3a39f; --skip-soft: #f1f1ef;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --card: #1f1f1e; --line: #323230; --text: #b5b5b0; --strong: #f2f2f0; --faint: #84847f;
    --tint: #262625; --accent: #8fb0ff; --ok: #4cc283; --ok-soft: #1d3326; --bad: #ff6b6f; --bad-soft: #3a1f20;
    --warn: #f0b45c; --skip: #77776f; --skip-soft: #2a2a28;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 40px 24px 64px; }
h1, h2, h3, h4 { color: var(--strong); margin: 0; }
h1 { font-size: 28px; letter-spacing: -0.02em; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); margin: 36px 0 12px; }
h3 { font-size: 16px; }
h4 { font-size: 12.5px; margin: 18px 0 8px; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.eyebrow { margin: 0 0 6px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--faint); }
.verdict { display: inline-flex; align-items: center; gap: 8px; margin: 14px 0 0; padding: 6px 12px; border-radius: 999px; font-weight: 600; }
.verdict .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.verdict[data-tone="ok"] { color: var(--ok); background: var(--ok-soft); }
.verdict[data-tone="bad"] { color: var(--bad); background: var(--bad-soft); }
.verdict[data-tone="stopped"], .verdict[data-tone="running"] { color: var(--warn); background: var(--tint); }
.facts { display: flex; flex-wrap: wrap; gap: 12px 40px; margin: 22px 0 0; }
.facts dt { font-size: 12px; color: var(--faint); }
.facts dd { margin: 2px 0 0; color: var(--strong); font-weight: 500; }
table { border-collapse: collapse; width: 100%; }
.scroll { overflow-x: auto; }
.sum, .kv, .grid, .hops { background: var(--card); border-radius: 10px; box-shadow: 0 0 0 1px var(--line); overflow: hidden; }
th, td { text-align: left; vertical-align: top; padding: 9px 12px; border-top: 1px solid var(--line); }
tr:first-child > th, tr:first-child > td, thead + tbody tr:first-child > td { border-top: 0; }
thead th { font-size: 12px; font-weight: 600; color: var(--faint); background: var(--tint); border-top: 0; }
.sum td.n { color: var(--faint); width: 32px; }
.sum .type { display: block; font-size: 12px; color: var(--faint); }
.sum a { font-weight: 600; }
.sum .res { color: var(--text); word-break: break-word; }
.sum tr[data-status="failed"] .res { color: var(--bad); }
.sum tr[data-status="skipped"] a { color: var(--faint); }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.kv th { width: 200px; font-weight: 500; color: var(--strong); font-family: var(--mono); font-size: 12.5px; word-break: break-all; }
.kv td { font-family: var(--mono); font-size: 12.5px; word-break: break-all; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.pill[data-status="ok"] { color: var(--ok); background: var(--ok-soft); }
.pill[data-status="failed"] { color: var(--bad); background: var(--bad-soft); }
.pill[data-status="skipped"], .pill[data-status="pending"], .pill[data-status="running"] { color: var(--skip); background: var(--skip-soft); }
.step { background: var(--card); border-radius: 12px; box-shadow: 0 0 0 1px var(--line); padding: 18px 20px 20px; margin: 0 0 14px; }
.step[data-status="failed"] { box-shadow: 0 0 0 1px var(--bad); }
.step[data-status="skipped"] { opacity: 0.75; }
.step > header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.step > header .n { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--tint); font-size: 12px; font-weight: 600; color: var(--text); }
.step[data-status="ok"] > header .n { background: var(--accent); color: #fff; }
.step[data-status="failed"] > header .n { background: var(--bad); color: #fff; }
.step > header .meta { margin-left: auto; font-size: 12px; color: var(--faint); }
.aside { font-weight: 400; font-size: 12px; color: var(--faint); }
.code { font-weight: 600; }
.code[data-class="2"] { color: var(--ok); }
.code[data-class="3"] { color: var(--accent); }
.code[data-class="4"], .code[data-class="5"] { color: var(--bad); }
.error { margin: 14px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--bad-soft); color: var(--bad); font-weight: 500; word-break: break-word; }
.note, .faint { color: var(--faint); margin: 8px 0 0; }
.note { margin-top: 12px; }
.req { margin: 0 0 8px; font-family: var(--mono); font-size: 12.5px; word-break: break-all; color: var(--strong); }
.method { margin-right: 6px; color: var(--accent); }
.file { margin: 0 0 8px; font-family: var(--mono); font-size: 12.5px; word-break: break-all; }
pre { margin: 8px 0 0; padding: 12px 14px; border-radius: 8px; background: var(--tint); color: var(--strong); font: 12px/1.55 var(--mono); white-space: pre-wrap; word-break: break-word; }
@media screen { pre { max-height: 480px; overflow: auto; } }
.mono { font-family: var(--mono); font-size: 12px; color: var(--text); }
details { margin: 8px 0 0; }
summary { cursor: pointer; color: var(--text); font-size: 12.5px; }
.val summary { display: flex; gap: 10px; align-items: baseline; }
.val code { font: 600 12.5px var(--mono); color: var(--strong); }
.grid td, .grid th { font-size: 12.5px; white-space: nowrap; }
.hops td { font-size: 13px; }
.hops .arrow { color: var(--faint); width: 20px; }
.hops tr[data-ok="false"] td { color: var(--bad); }
footer { margin-top: 40px; font-size: 12px; color: var(--faint); }
@media print {
  body { background: #fff; }
  main { padding: 0; }
  .step { break-inside: avoid-page; box-shadow: 0 0 0 1px #ddd; }
  a { color: inherit; }
}
`;

// ---- Markdown ----

/** A fence longer than any run of backticks inside */
function fence(text: string, lang = "") {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${text}\n${f}`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const lang = (text: string) => (/^\s*[[{]/.test(text) ? "json" : "");

function mdTable(head: string[], rows: string[][]) {
  return [
    `| ${head.map(cell).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

function mdStep(s: StepPart): string {
  const out: string[] = [`### ${s.n}. ${s.name} — ${s.word}`, "", `_${s.meta}_`];
  if (s.error) out.push("", `> **Error:** ${s.error.replace(/\r?\n/g, " ")}`);
  if (s.note) out.push("", s.note);
  if (s.sent) {
    const head = [`${s.sent.method} ${s.sent.url}`, ...s.sent.headers.map(([k, v]) => `${k}: ${v}`)].join("\n");
    out.push("", "**Sent**", "", fence(head, "http"));
    if (s.sent.body !== undefined) out.push("", fence(s.sent.body, lang(s.sent.body)));
  }
  if (s.answer) {
    const a = s.answer;
    out.push("", `**Answer** · ${a.text} · ${a.meta}`);
    if (a.headers.length) out.push("", fence(a.headers.map(([k, v]) => `${k}: ${v}`).join("\n"), "http"));
    out.push("", fence(a.body, lang(a.body)));
  }
  if (s.code !== undefined) out.push("", "**Code**", "", fence(s.code, "js"));
  if (s.lines) out.push("", "**Log**", "", s.lines.length ? fence(s.lines.join("\n")) : "_Nothing logged_");
  if (s.sheet) {
    const sh = s.sheet;
    out.push("", `**Sheet** · ${plural(sh.total, "row")} · \`${sh.path}\``, "", mdTable(sh.columns, sh.rows));
    if (sh.total > sh.rows.length) out.push("", `_The first ${sh.rows.length} of ${sh.total} rows._`);
  }
  if (s.kept.length) {
    out.push("", "**Kept**");
    for (const k of s.kept) out.push("", `\`${k.name}\` · ${k.kind}`, "", fence(k.text, lang(k.text)));
  }
  if (s.trace) out.push("", ...mdTrace(s.trace));
  return out.join("\n");
}

function mdTrace(t: NonNullable<StepPart["trace"]>): string[] {
  const out = [`**Calls it led to**${t.reached ? ` · reached ${t.reached}` : ""}`];
  if (t.note) out.push("", `_${t.note}_`);
  else if (!t.hops.length) out.push("", "_It called nothing else._");
  else {
    const rows = t.hops.map((h) => [h.from, h.to, [h.ok ? h.result : `✕ ${h.result}`, ...h.requests].join("; ")]);
    out.push("", mdTable(["From", "To", "Result"], rows));
  }
  for (const l of t.logs) out.push("", `${l.service} log:`, "", fence(l.lines.join("\n")));
  return out;
}

/** A call's trace on its own, as Markdown, for an agent */
export function traceMarkdown(state: TraceState | undefined): string {
  const t = tracePart(state, (s) => s);
  if (!t) return "No trace: the call didn't reach a service on a UAT network.";
  return mdTrace(t).join("\n");
}

function markdown(m: Model): string {
  const out: string[] = [
    `# ${m.name}`,
    "",
    `**${m.verdict}** · started ${m.started} · took ${m.took} · ${m.counts}`,
  ];
  if (m.inputs.length) {
    out.push("", "## Inputs", "", mdTable(["Name", "Value"], m.inputs.map((v) => [v.name, v.value])));
  }
  out.push(
    "",
    "## Summary",
    "",
    mdTable(
      ["#", "Step", "Type", "Status", "Time", "Result"],
      m.steps.map((s) => [
        String(s.n),
        s.name,
        s.type,
        s.word,
        s.time,
        s.result,
      ]),
    ),
  );
  if (m.details.length) out.push("", "## Details");
  for (const s of m.details) out.push("", mdStep(s));
  out.push(
    "",
    "---",
    "",
    `_Exported from UAT on ${m.made}.${m.hidden ? " Values that look secret are hidden: headers like Authorization and Cookie, and inputs and kept values named like a token, key or password." : ""}_`,
    "",
  );
  return out.join("\n");
}
