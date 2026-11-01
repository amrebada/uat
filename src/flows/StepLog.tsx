import type { ReactNode } from "react";
import { CircleX, ExternalLink, FolderOpen } from "lucide-react";
import { ICON, Spinner } from "../ui";
import { flowsApi } from "./api";
import { stepName, type Flow, type Step } from "./model";
import type { FlowRun, StepRun } from "./engine";
import { BODY_MAX, kind, pretty, size } from "./text";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="lg__block">
      <h3 className="fp__h lg__h">
        {title}
        {aside && <span className="lg__aside">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

export function StepLog({ flow, step, sr, run }: { flow: Flow; step: Step; sr?: StepRun; run?: FlowRun }) {
  if (!run || !sr || sr.status === "pending") {
    return <div className="lg__note">Run the flow to see what this step does.</div>;
  }
  if (sr.status === "skipped") {
    const failed = flow.steps.find((s) => s.id === run.failed);
    return (
      <div className="lg__note">
        Skipped: {run.status === "stopped" ? "the run was stopped before it" : `${failed ? stepName(failed) : "a step"} failed before it`}.
      </div>
    );
  }
  return (
    <div className="lg">
      <div className="lg__meta">
        {sr.at && clock(sr.at)}
        {sr.status === "running" ? " · running" : ` · ${sr.ms ?? 0} ms`}
      </div>
      {sr.status === "failed" && (
        <div className="lg__error">
          <CircleX size={15} strokeWidth={1.75} className="icon" />
          <span className="selectable">{sr.error}</span>
        </div>
      )}

      {step.type === "request" && sr.sent && (
        <Block title="Sent">
          <div className="lg__line selectable">
            <span className="method" data-m={sr.sent.method}>
              {sr.sent.method}
            </span>
            {sr.sent.url}
          </div>
          {sr.sent.headers.length > 0 && (
            <div className="lg__headers selectable">
              {sr.sent.headers.map(([k, v], i) => (
                <div key={i}>
                  <span>{k}:</span> {v}
                </div>
              ))}
            </div>
          )}
          {sr.sent.body !== undefined && <pre className="lg__pre selectable">{pretty(sr.sent.body)}</pre>}
        </Block>
      )}

      {step.type === "request" &&
        (sr.answer ? (
          <Block
            title="Answer"
            aside={
              <>
                <span className="trace__status" data-class={String(sr.answer.status)[0]}>
                  {sr.answer.status} {sr.answer.statusText}
                </span>
                <span>{sr.answer.ms} ms</span>
                <span>{size(new TextEncoder().encode(sr.answer.body).length)}</span>
              </>
            }
          >
            {sr.answer.headers.length > 0 && (
              <details className="lg__details">
                <summary>Headers ({sr.answer.headers.length})</summary>
                <div className="lg__headers selectable">
                  {sr.answer.headers.map(([k, v], i) => (
                    <div key={i}>
                      <span>{k}:</span> {v}
                    </div>
                  ))}
                </div>
              </details>
            )}
            <pre className="lg__pre selectable">{pretty(sr.answer.body) || " "}</pre>
          </Block>
        ) : (
          sr.status === "running" && (
            <Block title="Answer">
              <div className="lg__wait">
                <Spinner /> Waiting for the answer
              </div>
            </Block>
          )
        ))}

      {step.type === "transform" && (
        <Block title="Log">
          {sr.lines?.length ? (
            <pre className="lg__pre selectable">{sr.lines.join("\n")}</pre>
          ) : (
            <div className="lg__faint">Nothing logged</div>
          )}
        </Block>
      )}

      {step.type === "sheet" && sr.sheet && (
        <Block
          title="Sheet"
          aside={`${sr.sheet.total} ${sr.sheet.total === 1 ? "row" : "rows"} · ${sr.sheet.columns.length} columns`}
        >
          <div className="lg__file">
            <span className="mono selectable">{sr.sheet.path}</span>
            <button className="btn" onClick={() => flowsApi.open(sr.sheet!.path, false)}>
              <ExternalLink {...ICON} />
              Open
            </button>
            <button className="btn" onClick={() => flowsApi.open(sr.sheet!.path, true)}>
              <FolderOpen {...ICON} />
              Show in Finder
            </button>
          </div>
          <div className="lg__table">
            <table>
              <thead>
                <tr>
                  {sr.sheet.columns.map((c, i) => (
                    <th key={i}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sr.sheet.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} data-num={typeof cell === "number" || undefined}>
                        {cell === null ? "" : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sr.sheet.total > sr.sheet.rows.length && (
            <div className="field__hint">
              The first {sr.sheet.rows.length} of {sr.sheet.total} rows.
            </div>
          )}
        </Block>
      )}

      {sr.kept && sr.kept.length > 0 && (
        <Block title="Kept">
          <div className="vals">
            {sr.kept.map((k) => (
              <Value key={k.name} name={k.name} value={k.value} />
            ))}
          </div>
        </Block>
      )}
    </div>
  );
}

/** A kept value: its name, what it is, and all of it on a click */
export function Value({ name, value }: { name: string; value: unknown }) {
  const full = value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const line = value === undefined ? "undefined" : JSON.stringify(value);
  return (
    <details className="val">
      <summary>
        <span className="val__name">{name}</span>
        <span className="val__kind">{kind(value)}</span>
        <span className="val__line">{line.length > 160 ? `${line.slice(0, 160)}…` : line}</span>
      </summary>
      <pre className="lg__pre selectable">{full.length > BODY_MAX ? `${full.slice(0, BODY_MAX)}…` : full}</pre>
    </details>
  );
}
