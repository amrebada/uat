import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Copy,
  Ellipsis,
  FileCode,
  FileDown,
  FileText,
  Globe,
  Library,
  Play,
  Plus,
  Sheet,
  SlidersHorizontal,
  Square,
  SquareCheck,
  Trash,
  X,
  type LucideIcon,
} from "lucide-react";
import { ICON, Menu, Spinner, useDismiss } from "../ui";
import { inTauri, message } from "../lib/tauri";
import { uid, type HttpItem, type TreeNode } from "../collections/model";
import { loadWorkspace } from "../collections/store";
import { KVTable } from "../collections/HttpEditor";
import { traceTone, useTrace } from "../trace/api";
import { TracePanel } from "../trace/TraceView";
import { exportReport, flowsApi, traceKey } from "./api";
import { changeFlow, startRun, stopRun, useRun } from "./store";
import { keptBefore, newStep, STEP_WORD, stepName, type Flow, type RequestStep, type Step, type StepType } from "./model";
import type { FlowRun, StepRun } from "./engine";
import { StepSetup } from "./StepSetup";
import { StepLog, Value } from "./StepLog";
import { menuAt, type MenuAt } from "./menu";
import type { ReportFormat } from "./report";

export type Tab = "setup" | "log" | "trace";

export const STEP_ICON: Record<StepType, LucideIcon> = { request: Globe, transform: Braces, sheet: Sheet };

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Whether reports show values that look secret: a convenience, kept per viewer */
const SECRETS_KEY = "uat.reportSecrets";

function savedSecrets() {
  try {
    return localStorage.getItem(SECRETS_KEY) === "1";
  } catch {
    return false;
  }
}

function summary(flow: Flow, run: FlowRun | undefined): string {
  const n = flow.steps.length;
  const steps = `${n} ${n === 1 ? "step" : "steps"}`;
  if (!run) return steps;
  const name = (id?: string) => {
    const s = flow.steps.find((x) => x.id === id);
    return s ? stepName(s) : "a step";
  };
  if (run.status === "running") {
    const at = flow.steps.findIndex((s) => run.steps[s.id]?.status === "running");
    return `Running step ${at + 1} of ${n}`;
  }
  const when = clock(run.at);
  if (run.status === "ok") return `${steps} · ran at ${when} in ${run.ms} ms`;
  if (run.status === "stopped") return `${steps} · stopped at ${name(run.failed)}, ${when}`;
  return `${steps} · failed at ${name(run.failed)}, ${when}`;
}

export function FlowEditor({ flow }: { flow: Flow }) {
  const run = useRun(flow.id);
  const [focus, setFocus] = useState<string>(flow.steps[0]?.id ?? "inputs");
  const [tab, setTab] = useState<Tab>("setup");
  const [menu, setMenu] = useState<MenuAt>(null);
  const [adding, setAdding] = useState<"menu" | "pick" | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ path: string } | { error: string } | null>(null);
  const [secrets, setSecrets] = useState(savedSecrets);
  const set = (fn: (f: Flow) => Flow) => changeFlow(flow.id, fn);
  const running = run?.status === "running";

  const showSecrets = (on: boolean) => {
    setSecrets(on);
    try {
      localStorage.setItem(SECRETS_KEY, on ? "1" : "0");
    } catch {
      // A convenience only
    }
  };

  const exportAs = async (format: ReportFormat) => {
    if (!run) return;
    try {
      const path = await exportReport(run, format, secrets);
      if (path) setExported({ path });
    } catch (e) {
      setExported({ error: message(e) });
    }
  };

  // Where a report went shows for a while; an error stays until dismissed
  useEffect(() => {
    if (!exported || "error" in exported) return;
    const t = setTimeout(() => setExported(null), 8000);
    return () => clearTimeout(t);
  }, [exported]);

  // When a run ends, show what happened: at the step that failed, if one did
  const status = run?.status;
  const was = useRef(status);
  useEffect(() => {
    if (was.current === "running" && status && status !== "running") {
      if (run?.failed) setFocus(run.failed);
      setTab("log");
    }
    was.current = status;
  }, [status, run?.failed]);

  const index = flow.steps.findIndex((s) => s.id === focus);
  const step = index >= 0 ? flow.steps[index] : null;

  /** Adds `s` at the end, or right after the step `after` */
  const insert = (s: Step, after?: string) => {
    set((f) => {
      const at = after ? f.steps.findIndex((x) => x.id === after) : -1;
      const steps = [...f.steps];
      steps.splice(at >= 0 ? at + 1 : steps.length, 0, s);
      return { ...f, steps };
    });
    setFocus(s.id);
    setTab("setup");
  };

  const move = (id: string, by: number) =>
    set((f) => {
      const i = f.steps.findIndex((s) => s.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= f.steps.length) return f;
      const steps = [...f.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...f, steps };
    });

  const remove = (id: string) => {
    const i = flow.steps.findIndex((s) => s.id === id);
    set((f) => ({ ...f, steps: f.steps.filter((s) => s.id !== id) }));
    if (focus === id) setFocus((flow.steps[i + 1] ?? flow.steps[i - 1])?.id ?? "inputs");
  };

  const menuStep = menu && flow.steps.find((s) => s.id === menu.id);
  const menuIndex = menuStep ? flow.steps.indexOf(menuStep) : -1;

  return (
    <div className="fe">
      <div className="fe__head">
        <div className="fe__titles">
          <input
            className="ed__title"
            value={flow.name}
            placeholder="Untitled flow"
            onChange={(e) => {
              const name = e.target.value;
              set((f) => ({ ...f, name }));
            }}
          />
          <div className="fe__meta" data-tone={run?.status}>
            {summary(flow, run)}
          </div>
        </div>
        <div className="fe__actions">
          <button
            ref={exportRef}
            className="btn"
            disabled={!run || running}
            title={run ? "A report of the last run" : "Run the flow to export a report of it"}
            data-open={exporting || undefined}
            onClick={() => setExporting((o) => !o)}
          >
            <FileDown {...ICON} />
            Export
          </button>
          <button
            className="btn-primary"
            disabled={!running && !flow.steps.length}
            onClick={() => (running ? stopRun(flow.id) : startRun(flow))}
          >
            {running ? <Spinner /> : <Play {...ICON} />}
            {running ? "Stop" : "Run"}
          </button>
        </div>
        {exporting && (
          <Menu
            entries={[
              { label: "HTML report…", icon: FileText, onSelect: () => exportAs("html") },
              { label: "Markdown report…", icon: FileCode, onSelect: () => exportAs("md") },
              "separator",
              { label: "Include secrets", icon: secrets ? SquareCheck : Square, onSelect: () => showSecrets(!secrets) },
            ]}
            anchor={exportRef}
            onClose={() => setExporting(false)}
            style={{ position: "fixed", ...under(exportRef.current) }}
          />
        )}
      </div>

      <div className="fe__cols">
        <div className="fe__steps">
          <button className="fs fs--inputs" data-active={focus === "inputs" || undefined} onClick={() => setFocus("inputs")}>
            <span className="fs__node">
              <SlidersHorizontal size={12} strokeWidth={1.75} className="icon" />
            </span>
            <span className="fs__main">
              <span className="fs__top">
                <span className="fs__name">Inputs</span>
              </span>
              <span className="fs__sum">
                {keptBefore(flow, 0).map((k) => `{{${k.name}}}`).join("  ") || "None yet"}
              </span>
            </span>
          </button>

          {flow.steps.map((s, i) => (
            <Fragment key={s.id}>
              <span className="fs__line" data-status={run?.steps[s.id]?.status} />
              <StepCard
                step={s}
                n={i + 1}
                sr={run?.steps[s.id]}
                active={focus === s.id}
                menuOpen={menu?.id === s.id}
                onSelect={() => setFocus(s.id)}
                onMenu={(e) => setMenu(menuAt(e, s.id))}
              />
            </Fragment>
          ))}

          <span className="fs__line fs__line--add" />
          <button ref={addRef} className="fs__add" data-open={adding || undefined} onClick={() => setAdding((a) => (a ? null : "menu"))}>
            <Plus size={14} strokeWidth={1.75} className="icon" />
            Add step
          </button>
          {adding === "menu" && (
            <Menu
              entries={[
                { label: STEP_WORD.request, icon: Globe, onSelect: () => insert(newStep("request")) },
                { label: STEP_WORD.transform, icon: Braces, onSelect: () => insert(newStep("transform")) },
                { label: STEP_WORD.sheet, icon: Sheet, onSelect: () => insert(newStep("sheet")) },
                "separator",
                { label: "Call from Collections…", icon: Library, onSelect: () => setTimeout(() => setAdding("pick")) },
              ]}
              anchor={addRef}
              onClose={() => setAdding((a) => (a === "menu" ? null : a))}
              style={{ position: "fixed", ...place(addRef.current, 180) }}
            />
          )}
          {adding === "pick" && (
            <CollectionPicker
              anchor={addRef}
              onPick={(item) => {
                setAdding(null);
                insert(fromCollection(item));
              }}
              onClose={() => setAdding(null)}
            />
          )}
        </div>

        <div className="fe__inspect">
          {step ? (
            <StepPanel
              key={step.id}
              flow={flow}
              step={step}
              index={index}
              run={run}
              tab={tab}
              setTab={setTab}
              onChange={(fn) => set((f) => ({ ...f, steps: f.steps.map((x) => (x.id === step.id ? fn(x) : x)) }))}
            />
          ) : (
            <InputsPanel flow={flow} run={run} onChange={(vars) => set((f) => ({ ...f, vars }))} />
          )}
        </div>
      </div>

      {menu && menuStep && (
        <Menu
          entries={[
            ...(menuIndex > 0 ? [{ label: "Move up", icon: ArrowUp, onSelect: () => move(menuStep.id, -1) }] : []),
            ...(menuIndex < flow.steps.length - 1
              ? [{ label: "Move down", icon: ArrowDown, onSelect: () => move(menuStep.id, 1) }]
              : []),
            {
              label: "Duplicate",
              icon: Copy,
              onSelect: () =>
                insert({ ...structuredClone(menuStep), id: uid(), name: menuStep.name && `${menuStep.name} copy` }, menuStep.id),
            },
            "separator",
            { label: "Delete", icon: Trash, danger: true, onSelect: () => remove(menuStep.id) },
          ]}
          anchor={{ current: menu.anchor }}
          onClose={() => setMenu(null)}
          style={{ position: "fixed", top: menu.top, bottom: menu.bottom, left: menu.left }}
        />
      )}

      {exported &&
        ("error" in exported ? (
          <div className="cl__toast" data-tone="bad">
            <span className="cl__toast-text" title={exported.error}>
              Couldn't export the report: {exported.error}
            </span>
            <button onClick={() => setExported(null)}>Dismiss</button>
          </div>
        ) : (
          <div className="cl__toast">
            <span className="cl__toast-text" title={exported.path}>
              {inTauri ? "Saved" : "Downloaded"} {exported.path.split("/").pop()}
            </span>
            {inTauri && (
              <>
                <button onClick={() => flowsApi.open(exported.path, false)}>Open</button>
                <button onClick={() => flowsApi.open(exported.path, true)}>Show in Finder</button>
              </>
            )}
          </div>
        ))}
    </div>
  );
}

/** Under `el`, or over it when `height` doesn't fit below */
/** Under `el`, lined up with its right edge */
function under(el: HTMLElement | null) {
  const r = el?.getBoundingClientRect();
  return r ? { top: r.bottom + 4, right: window.innerWidth - r.right } : { top: 0, right: 0 };
}

function place(el: HTMLElement | null, height: number) {
  const r = el?.getBoundingClientRect();
  if (!r) return { top: 0, left: 0 };
  return r.bottom + 4 + height > window.innerHeight
    ? { bottom: window.innerHeight - r.top + 4, left: r.left }
    : { top: r.bottom + 4, left: r.left };
}

function stateText(step: Step, sr: StepRun | undefined): string {
  if (!sr) return "";
  switch (sr.status) {
    case "running":
      return "Running";
    case "failed":
      return sr.error === "Stopped" ? "Stopped" : "Failed";
    case "skipped":
      return "Skipped";
    case "ok": {
      const extra =
        step.type === "request" && sr.answer
          ? `${sr.answer.status} · `
          : step.type === "sheet" && sr.sheet
            ? `${sr.sheet.total} ${sr.sheet.total === 1 ? "row" : "rows"} · `
            : "";
      return `${extra}${sr.ms ?? 0} ms`;
    }
    default:
      return "";
  }
}

function StepCard({
  step,
  n,
  sr,
  active,
  menuOpen,
  onSelect,
  onMenu,
}: {
  step: Step;
  n: number;
  sr: StepRun | undefined;
  active: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onMenu: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const Icon = STEP_ICON[step.type];
  const status = sr?.status;
  return (
    <div
      className="fs"
      role="button"
      tabIndex={0}
      data-active={active || undefined}
      data-status={status}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
    >
      <span className="fs__node">
        {status === "running" ? <Spinner size={12} /> : status === "failed" ? <X size={12} strokeWidth={2.5} /> : n}
      </span>
      <span className="fs__main">
        <span className="fs__top">
          <span className="fs__name">{stepName(step)}</span>
          <span className="fs__state">{stateText(step, sr)}</span>
        </span>
        <span className="fs__sum">
          {step.type === "request" ? (
            <>
              <span className="method" data-m={step.method}>
                {step.method}
              </span>
              <span className="fs__mono">{step.url.trim() || "No URL yet"}</span>
            </>
          ) : (
            <>
              <Icon size={12} strokeWidth={1.75} className="icon" />
              <span className="fs__mono">
                {step.type === "transform"
                  ? `→ ${step.as.trim() || "nothing kept"}`
                  : `${step.from.trim() || "?"} → ${step.file.split("/").pop() || "?"}`}
              </span>
            </>
          )}
        </span>
        {status === "failed" && sr?.error !== "Stopped" && <span className="fs__error">{sr?.error}</span>}
      </span>
      <button className="icon-btn fs__more" data-open={menuOpen || undefined} title="More" onClick={onMenu}>
        <Ellipsis size={14} strokeWidth={1.75} className="icon" />
      </button>
    </div>
  );
}

function StepPanel({
  flow,
  step,
  index,
  run,
  tab,
  setTab,
  onChange,
}: {
  flow: Flow;
  step: Step;
  index: number;
  run: FlowRun | undefined;
  tab: Tab;
  setTab: (t: Tab) => void;
  onChange: (fn: (s: Step) => Step) => void;
}) {
  const sr = run?.steps[step.id];
  const trace = useTrace(step.type === "request" ? traceKey(flow.id, step.id) : null);
  const kept = useMemo(() => keptBefore(flow, index), [flow, index]);
  // What the last run kept, for the code editor's suggestions; the inputs are known without one
  const values = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const v of flow.vars) if (v.enabled && v.key.trim()) out[v.key.trim()] = v.value;
    for (const k of kept) if (run && k.name in run.vars) out[k.name] = run.vars[k.name];
    return out;
  }, [flow.vars, kept, run]);
  const tone = traceTone(trace);
  const shown: Tab = tab === "trace" && !trace ? "log" : tab;
  const Icon = STEP_ICON[step.type];
  return (
    <div className="fp">
      <div className="fp__head">
        <div className="fp__kind">
          <Icon size={13} strokeWidth={1.75} className="icon" />
          {STEP_WORD[step.type]} · step {index + 1}
        </div>
        <input
          className="fp__name"
          value={step.name}
          placeholder={stepName({ ...step, name: "" })}
          onChange={(e) => {
            const name = e.target.value;
            onChange((s) => ({ ...s, name }));
          }}
        />
        <div className="tabs fp__tabs">
          <button data-active={shown === "setup" || undefined} onClick={() => setTab("setup")}>
            Setup
          </button>
          <button data-active={shown === "log" || undefined} onClick={() => setTab("log")}>
            Log
            {sr?.status === "running" ? (
              <Spinner size={11} />
            ) : (
              sr &&
              sr.status !== "pending" &&
              sr.status !== "skipped" && <span className="trace-dot" data-tone={sr.status === "ok" ? "ok" : "bad"} />
            )}
          </button>
          {trace && (
            <button data-active={shown === "trace" || undefined} onClick={() => setTab("trace")}>
              Trace
              {tone === "busy" ? <Spinner size={11} /> : tone && <span className="trace-dot" data-tone={tone} />}
            </button>
          )}
        </div>
      </div>
      <div className="fp__body" data-tab={shown}>
        {shown === "setup" ? (
          <StepSetup
            step={step}
            kept={kept}
            values={values}
            onChange={onChange}
            onRun={() => startRun(flow)}
          />
        ) : shown === "log" ? (
          <StepLog flow={flow} step={step} sr={sr} run={run} />
        ) : (
          <TracePanel state={trace} />
        )}
      </div>
    </div>
  );
}

function InputsPanel({ flow, run, onChange }: { flow: Flow; run: FlowRun | undefined; onChange: (vars: Flow["vars"]) => void }) {
  const kept = run ? Object.entries(run.vars) : [];
  return (
    <div className="fp">
      <div className="fp__head">
        <div className="fp__kind">
          <SlidersHorizontal size={13} strokeWidth={1.75} className="icon" />
          Inputs
        </div>
        <div className="fp__title">What every step starts with</div>
      </div>
      <div className="fp__body">
        <section className="fp__section">
          <KVTable rows={flow.vars} onChange={onChange} keyHint="Name" />
          <div className="field__hint">
            Steps use these as <code>{"{{name}}"}</code>, like <code>{"{{base}}/rides"}</code>.
          </div>
        </section>
        {kept.length > 0 && (
          <section className="fp__section">
            <h3 className="fp__h">{run?.status === "running" ? "Kept so far" : "Kept by the last run"}</h3>
            <div className="vals">
              {kept.map(([name, value]) => (
                <Value key={name} name={name} value={value} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ---- Calls from Collections ----

type Found = { item: HttpItem; path: string };

function requests(tree: TreeNode[], trail: string[] = []): Found[] {
  return tree.flatMap((n): Found[] =>
    n.type === "group"
      ? requests(n.children, [...trail, n.name || "Untitled group"])
      : n.type === "http"
        ? [{ item: n, path: trail.join(" › ") }]
        : [],
  );
}

function fromCollection(item: HttpItem): RequestStep {
  return {
    ...(newStep("request") as RequestStep),
    name: item.name,
    method: item.method,
    url: item.url,
    headers: structuredClone(item.headers),
    bodyType: item.bodyType,
    body: item.body,
  };
}

function CollectionPicker({
  anchor,
  onPick,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  onPick: (item: HttpItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState<Found[] | null>(null);
  const [query, setQuery] = useState("");
  useDismiss(ref, onClose, true, anchor);
  useEffect(() => {
    loadWorkspace()
      .then((ws) => setFound(ws ? requests(ws.tree) : []))
      .catch(() => setFound([]));
  }, []);
  const q = query.trim().toLowerCase();
  const shown = (found ?? []).filter(
    (f) => !q || `${f.item.name} ${f.item.url} ${f.path}`.toLowerCase().includes(q),
  );
  return (
    <div ref={ref} className="popover pick" style={{ position: "fixed", ...place(anchor.current, 380) }}>
      <input
        className="input pick__search"
        autoFocus
        placeholder="Find a request"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && shown[0] && onPick(shown[0].item)}
      />
      <div className="pick__list">
        {found === null ? (
          <div className="pick__none">
            <Spinner />
          </div>
        ) : shown.length === 0 ? (
          <div className="pick__none">{found.length ? "Nothing matches" : "No HTTP requests in Collections"}</div>
        ) : (
          shown.map(({ item, path }) => (
            <button key={item.id} className="pick__row" onClick={() => onPick(item)}>
              <span className="method" data-m={item.method}>
                {item.method}
              </span>
              <span className="pick__name">{item.name || item.url || "Untitled"}</span>
              {path && <span className="pick__path">{path}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
