import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { ICON, Spinner } from "../ui";
import { inTauri } from "../lib/tauri";
import { METHODS } from "../collections/model";
import { KVTable } from "../collections/HttpEditor";
import { scopeDeclarations } from "./code/scope";
import type { Kept, RequestStep, SheetStep, Step, TransformStep } from "./model";

// Monaco is big: it loads the first time a transform is opened
const CodeEditor = lazy(() => import("./code/CodeEditor"));

type Change = (fn: (s: Step) => Step) => void;

export function StepSetup({
  step,
  kept,
  values,
  onChange,
  onRun,
}: {
  step: Step;
  /** What earlier steps keep */
  kept: Kept[];
  /** Their values from the last run, where known */
  values: Record<string, unknown>;
  onChange: Change;
  onRun: () => void;
}) {
  const set = (patch: Partial<Step>) => onChange((s) => ({ ...s, ...patch }) as Step);
  const names = kept.map((k) => k.name);
  switch (step.type) {
    case "request":
      return <RequestSetup step={step} kept={names} set={set} />;
    case "transform":
      return <TransformSetup step={step} kept={kept} values={values} set={set} onRun={onRun} />;
    case "sheet":
      return <SheetSetup step={step} kept={names} set={set} />;
  }
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="fp__section">
      <h3 className="fp__h">{title}</h3>
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </section>
  );
}

/** What earlier steps kept, to use as {{name}}. Click one to copy it. */
function Kept({ names }: { names: string[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!names.length) return null;
  return (
    <div className="kept">
      <span className="kept__label">Kept before this step</span>
      {names.map((n) => (
        <button
          key={n}
          className="kept__name"
          title="Copy"
          onClick={() => {
            navigator.clipboard?.writeText(`{{${n}}}`).catch(() => {});
            setCopied(n);
            setTimeout(() => setCopied((c) => (c === n ? null : c)), 1200);
          }}
        >
          {copied === n ? "Copied" : `{{${n}}}`}
        </button>
      ))}
    </div>
  );
}

const FILL_HINT = (
  <>
    <code>{"{{name}}"}</code> fills in a value kept earlier, like <code>{"{{rides[0].id}}"}</code>. Text goes in as it
    is; lists and objects as JSON.
  </>
);

function RequestSetup({ step, kept, set }: { step: RequestStep; kept: string[]; set: (p: Partial<RequestStep>) => void }) {
  const hasBody = step.method !== "GET" && step.method !== "HEAD";
  return (
    <>
      <section className="fp__section">
        <div className="urlbar fp__url">
          <select
            className="urlbar__method method"
            data-m={step.method}
            value={step.method}
            onChange={(e) => set({ method: e.target.value as RequestStep["method"] })}
          >
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input
            className="urlbar__url"
            placeholder="{{base}}/rides"
            value={step.url}
            spellCheck={false}
            onChange={(e) => set({ url: e.target.value })}
          />
        </div>
        <Kept names={kept} />
        <div className="field__hint">{FILL_HINT}</div>
      </section>

      <Section title="Headers">
        <KVTable rows={step.headers} onChange={(headers) => set({ headers })} keyHint="Header" />
      </Section>

      {hasBody && (
        <Section title="Body">
          <div className="segmented">
            {(["none", "json", "text"] as const).map((t) => (
              <button key={t} data-active={step.bodyType === t || undefined} onClick={() => set({ bodyType: t })}>
                {t === "none" ? "None" : t === "json" ? "JSON" : "Text"}
              </button>
            ))}
          </div>
          {step.bodyType !== "none" && (
            <textarea
              className="textarea fp__code fp__code--body"
              data-mono
              spellCheck={false}
              value={step.body}
              placeholder={step.bodyType === "json" ? '{\n  "ride": "{{ride.id}}"\n}' : ""}
              onChange={(e) => set({ body: e.target.value })}
              onKeyDown={indent((body) => set({ body }))}
            />
          )}
        </Section>
      )}

      <Section
        title="Keep from the answer"
        hint={
          <>
            Paths start at the answer: <code>status</code>, <code>{'headers["x-request-id"]'}</code>,{" "}
            <code>body.rides[0].id</code>, <code>body.rides[*].id</code>. Later steps use each as{" "}
            <code>{"{{name}}"}</code>.
          </>
        }
      >
        <KVTable rows={step.keep} onChange={(keep) => set({ keep })} keyHint="Name" valueHint="Path, like body.rides" />
      </Section>

      <label className="fp__check">
        <input type="checkbox" checked={step.expectOk} onChange={(e) => set({ expectOk: e.target.checked })} />
        Stop the flow unless it answers 2xx
      </label>
    </>
  );
}

function TransformSetup({
  step,
  kept,
  values,
  set,
  onRun,
}: {
  step: TransformStep;
  kept: Kept[];
  values: Record<string, unknown>;
  set: (p: Partial<TransformStep>) => void;
  onRun: () => void;
}) {
  const declarations = useMemo(() => scopeDeclarations(kept, values), [kept, values]);
  return (
    <>
      <Section title="Keep the result as">
        <input
          className="input"
          data-mono
          placeholder="result"
          value={step.as}
          spellCheck={false}
          onChange={(e) => set({ as: e.target.value })}
        />
      </Section>
      <Section
        title="Code"
        hint={
          <>
            What earlier steps kept is in scope by name, and in <code>vars</code>; lodash is <code>_</code>. Return
            what to keep; <code>log()</code> writes to this step's log. Suggestions know each value's shape from the
            last run.
          </>
        }
      >
        <Suspense
          fallback={
            <div className="cedit cedit--loading">
              <Spinner /> Loading the editor
            </div>
          }
        >
          <CodeEditor
            id={step.id}
            value={step.code}
            declarations={declarations}
            onChange={(code) => set({ code })}
            onRun={onRun}
          />
        </Suspense>
        <Kept names={kept.map((k) => k.name)} />
      </Section>
    </>
  );
}

function SheetSetup({ step, kept, set }: { step: SheetStep; kept: string[]; set: (p: Partial<SheetStep>) => void }) {
  const choose = async () => {
    const file = await save({
      defaultPath: step.file.includes("{{") ? undefined : step.file.split("/").pop(),
      filters: [
        { name: "Excel", extensions: ["xlsx"] },
        { name: "CSV", extensions: ["csv"] },
      ],
    }).catch(() => null);
    if (file) set({ file });
  };
  return (
    <>
      <Section title="Rows from" hint="A list kept earlier, like rides, open or body.items[*].">
        <input
          className="input"
          data-mono
          placeholder="rides"
          value={step.from}
          spellCheck={false}
          onChange={(e) => set({ from: e.target.value })}
        />
        <Kept names={kept} />
      </Section>
      <Section title="Columns" hint="A header, and the path to its value in each row. With none, every field of the rows.">
        <KVTable rows={step.columns} onChange={(columns) => set({ columns })} keyHint="Header" valueHint="Path, like from" />
      </Section>
      <Section
        title="File"
        hint={
          <>
            An .xlsx or .csv file, replaced on each run. A name alone goes in ~/Documents/UAT, and{" "}
            <code>{"{{name}}"}</code> works here too.
          </>
        }
      >
        <div className="fp__file">
          <input
            className="input"
            data-mono
            placeholder="~/Documents/UAT/rides.xlsx"
            value={step.file}
            spellCheck={false}
            onChange={(e) => set({ file: e.target.value })}
          />
          <button className="btn" disabled={!inTauri} onClick={choose}>
            <FolderOpen {...ICON} />
            Choose…
          </button>
        </div>
      </Section>
    </>
  );
}

/** Tab indents by two spaces instead of leaving the field */
function indent(write: (text: string) => void) {
  return (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value } = el;
    write(`${value.slice(0, a)}  ${value.slice(b)}`);
    requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
  };
}
