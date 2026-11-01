import { useEffect, useState } from "react";
import { Send, X } from "lucide-react";
import { inTauri } from "../lib/tauri";
import { ICON, Spinner } from "../ui";
import { prepareTrace, traceTone, useTrace, type TraceState } from "../trace/api";
import { TracePanel } from "../trace/TraceView";
import { TryDemo } from "./demo";
import { kv, METHODS, type HttpItem, type Item, type KV } from "./model";
import { cancelHttp, sendHttp, useResult, useSending, withScheme, type Result } from "./send";

function size(bytes: number) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

export function HttpEditor({ item, onChange }: { item: HttpItem; onChange: (fn: (n: Item) => Item) => void }) {
  const [tab, setTab] = useState<"headers" | "body">(item.bodyType === "none" ? "headers" : "body");
  const result = useResult(item.id);
  const sending = useSending(item.id);
  const trace = useTrace(item.id);
  const set = (patch: Partial<HttpItem>) => onChange((n) => ({ ...n, ...patch }) as Item);
  const enabledHeaders = item.headers.filter((h) => h.enabled && h.key.trim()).length;
  const hasBody = item.method !== "GET" && item.method !== "HEAD";

  // Start watching the network the URL reaches before Send, so the first
  // call's trace is whole
  useEffect(() => {
    if (!inTauri || !item.url.trim()) return;
    const t = setTimeout(() => prepareTrace(withScheme(item.url)).catch(() => {}), 800);
    return () => clearTimeout(t);
  }, [item.url]);

  const send = () => {
    if (sending) cancelHttp(item.id);
    else if (item.url.trim()) sendHttp(item);
  };

  return (
    <div className="req">
      <form
        className="urlbar"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <select
          className="urlbar__method method"
          data-m={item.method}
          value={item.method}
          onChange={(e) => set({ method: e.target.value as HttpItem["method"] })}
        >
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input
          className="urlbar__url"
          placeholder="https://api.example.com/v1/rides"
          value={item.url}
          spellCheck={false}
          onChange={(e) => set({ url: e.target.value })}
        />
        <button type="submit" className="btn-primary" disabled={!item.url.trim()}>
          {sending ? <Spinner /> : <Send {...ICON} />}
          {sending ? "Cancel" : "Send"}
        </button>
      </form>

      <div className="tabs req__tabs">
        <button data-active={tab === "headers" || undefined} onClick={() => setTab("headers")}>
          Headers
          {enabledHeaders > 0 && <span className="tabs__count">{enabledHeaders}</span>}
        </button>
        <button data-active={tab === "body" || undefined} onClick={() => setTab("body")}>
          Body
        </button>
      </div>

      <div className="req__pane">
        {tab === "headers" ? (
          <KVTable rows={item.headers} onChange={(headers) => set({ headers })} keyHint="Header" />
        ) : (
          <div className="req__body">
            <div className="segmented">
              {(["none", "json", "text"] as const).map((t) => (
                <button key={t} data-active={item.bodyType === t || undefined} onClick={() => set({ bodyType: t })}>
                  {t === "none" ? "None" : t === "json" ? "JSON" : "Text"}
                </button>
              ))}
            </div>
            {item.bodyType !== "none" && (
              <textarea
                className="textarea req__textarea"
                data-mono
                spellCheck={false}
                value={item.body}
                placeholder={item.bodyType === "json" ? '{\n  "pickup": "Ain Diab"\n}' : ""}
                onChange={(e) => set({ body: e.target.value })}
              />
            )}
            {!hasBody && item.bodyType !== "none" && (
              <div className="field__hint">{item.method} requests are sent without a body.</div>
            )}
          </div>
        )}
      </div>

      <Response result={result} sending={sending} trace={trace} />
    </div>
  );
}

export function KVTable({
  rows,
  onChange,
  keyHint,
  valueHint = "Value",
}: {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyHint: string;
  valueHint?: string;
}) {
  // A blank row at the end that becomes real when typed into
  const [blank, setBlank] = useState(() => kv());
  const all = [...rows, blank];
  const edit = (id: string, patch: Partial<KV>) => {
    if (id === blank.id) {
      onChange([...rows, { ...blank, ...patch }]);
      setBlank(kv());
    } else onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  return (
    <div className="kv">
      {all.map((r) => {
        const isBlank = r.id === blank.id;
        return (
          <div key={r.id} className="kv__row" data-off={!r.enabled || undefined}>
            <input
              type="checkbox"
              checked={r.enabled}
              disabled={isBlank}
              onChange={(e) => edit(r.id, { enabled: e.target.checked })}
            />
            <input
              className="kv__cell"
              placeholder={keyHint}
              value={r.key}
              spellCheck={false}
              onChange={(e) => edit(r.id, { key: e.target.value })}
            />
            <input
              className="kv__cell"
              placeholder={valueHint}
              value={r.value}
              spellCheck={false}
              onChange={(e) => edit(r.id, { value: e.target.value })}
            />
            {!isBlank ? (
              <button className="icon-btn" title="Remove" onClick={() => onChange(rows.filter((x) => x.id !== r.id))}>
                <X size={14} strokeWidth={1.5} className="icon" />
              </button>
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </div>
  );
}

function TraceTab({ trace, active, onSelect }: { trace: TraceState | undefined; active: boolean; onSelect: () => void }) {
  const tone = traceTone(trace);
  return (
    <button data-active={active || undefined} onClick={onSelect}>
      Trace
      {tone === "busy" ? <Spinner size={11} /> : tone && <span className="trace-dot" data-tone={tone} />}
    </button>
  );
}

function Response({ result, sending, trace }: { result?: Result; sending: boolean; trace?: TraceState }) {
  const [tab, setTab] = useState<"body" | "headers" | "trace">("body");
  if (!result) {
    return (
      <div className="resp resp--empty">
        {sending ? <Spinner /> : <span>Send the request to see its response here.</span>}
      </div>
    );
  }
  const showTrace = tab === "trace" && trace;
  return (
    <div className="resp" data-stale={(sending && !showTrace) || undefined}>
      <div className="resp__bar">
        {result.ok ? (
          <>
            <span className="resp__status" data-class={String(result.status)[0]}>
              {result.status} {result.statusText}
            </span>
            <span className="resp__meta">{result.ms} ms</span>
            <span className="resp__meta">{size(result.size)}</span>
            <div className="tabs resp__tabs">
              <button data-active={tab === "body" || undefined} onClick={() => setTab("body")}>
                Body
              </button>
              <button data-active={tab === "headers" || undefined} onClick={() => setTab("headers")}>
                Headers<span className="tabs__count">{result.headers.length}</span>
              </button>
              {trace && <TraceTab trace={trace} active={tab === "trace"} onSelect={() => setTab("trace")} />}
            </div>
          </>
        ) : (
          <>
            <span className="resp__status" data-class="x">
              Failed
            </span>
            <span className="resp__meta">{result.ms} ms</span>
            {trace && (
              <div className="tabs resp__tabs">
                <button data-active={tab !== "trace" || undefined} onClick={() => setTab("body")}>
                  Error
                </button>
                <TraceTab trace={trace} active={tab === "trace"} onSelect={() => setTab("trace")} />
              </div>
            )}
          </>
        )}
      </div>
      {showTrace ? (
        <TracePanel state={trace} none={<TryDemo />} />
      ) : !result.ok ? (
        <pre className="resp__body selectable resp__error">{result.error}</pre>
      ) : tab !== "headers" ? (
        <pre className="resp__body selectable" data-json={result.json || undefined}>
          {result.body || <span className="resp__none">Empty body</span>}
        </pre>
      ) : (
        <div className="resp__body resp__headers selectable">
          {result.headers.map(([k, v], i) => (
            <div key={i} className="resp__header">
              <span>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
