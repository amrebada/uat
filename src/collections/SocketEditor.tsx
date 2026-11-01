import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CircleAlert, Info, Plug, Send, Unplug, Waypoints, X } from "lucide-react";
import { inTauri } from "../lib/tauri";
import { ICON, Spinner } from "../ui";
import { beginTrace, knownEntry, prepareTrace, traceAfter, traceTone, useTrace } from "../trace/api";
import { TracePanel } from "../trace/TraceView";
import { TryDemo } from "./demo";
import { clearLog, connectIo, connectWs, disconnect, emitIo, sendWs, setIoListen, useLive, type LogEntry } from "./live";
import type { IoItem, Item, WsItem } from "./model";

/** How long after a message the services' activity still counts as its */
const MESSAGE_WINDOW = 1500;

export function SocketEditor({ item, onChange }: { item: WsItem | IoItem; onChange: (fn: (n: Item) => Item) => void }) {
  const live = useLive(item.id);
  const isIo = item.type === "socketio";
  const connected = live.status === "open";
  const [preparing, setPreparing] = useState(false);
  const busy = live.status === "connecting" || preparing;
  const [traceKey, setTraceKey] = useState<string | null>(null);
  const traceLabel = live.log.find((e) => e.trace === traceKey);

  // Start watching the network the URL reaches before Connect
  useEffect(() => {
    if (!inTauri || !item.url.trim()) return;
    const t = setTimeout(() => prepareTrace(item.url).catch(() => {}), 800);
    return () => clearTimeout(t);
  }, [item.url]);
  const set = (patch: Partial<WsItem> | Partial<IoItem>) => onChange((n) => ({ ...n, ...patch }) as Item);

  useEffect(() => {
    if (item.type === "socketio") setIoListen(item.id, item.listen);
  }, [item]);

  const toggle = async () => {
    if (connected || busy) {
      disconnect(item.id);
      return;
    }
    if (!item.url.trim()) return;
    const key = `${item.id}:connect:${Date.now()}`;
    setPreparing(true);
    const traced = await beginTrace(key, item.url);
    setPreparing(false);
    const at = Date.now();
    const settled = (ok: boolean, outcome: string) => traced({ label: "Connect", outcome, ok, at, end: Date.now() });
    if (item.type === "ws") connectWs(item, { key, settled });
    else connectIo(item, { key, settled });
  };

  const send = () => {
    const key = `${item.id}:message:${Date.now()}`;
    const event = item.type === "socketio" ? item.event.trim() || "message" : null;
    const ok = event === null ? sendWs(item.id, item.draft, key) : emitIo(item.id, event, item.draft, key);
    if (ok) {
      const at = Date.now();
      const label = event === null ? "Send" : `emit ${event}`;
      traceAfter(key, knownEntry(item.url) ?? null, { label, outcome: "Sent", ok: true, at, end: at }, MESSAGE_WINDOW);
    }
    return ok;
  };

  return (
    <div className="sock">
      <form
        className="urlbar"
        onSubmit={(e) => {
          e.preventDefault();
          toggle();
        }}
      >
        <span className="method urlbar__word" data-m={isIo ? "IO" : "WS"}>
          {isIo ? "IO" : "WS"}
        </span>
        <input
          className="urlbar__url"
          placeholder={isIo ? "http://localhost:3000" : "ws://localhost:8080/drivers/stream"}
          value={item.url}
          spellCheck={false}
          onChange={(e) => set({ url: e.target.value })}
        />
        <button type="submit" className={connected || busy ? "btn" : "btn-primary"} disabled={!item.url.trim()}>
          {busy ? <Spinner /> : connected ? <Unplug {...ICON} /> : <Plug {...ICON} />}
          {connected || busy ? "Disconnect" : "Connect"}
        </button>
      </form>

      {item.type === "socketio" ? (
        <div className="sock__opts">
          <label className="field">
            <span className="field__label">Path</span>
            <input className="input" data-mono value={item.path} onChange={(e) => set({ path: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Auth (JSON)</span>
            <input
              className="input"
              data-mono
              placeholder='{"token": "…"}'
              value={item.auth}
              spellCheck={false}
              onChange={(e) => set({ auth: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field__label">Listen to</span>
            <input
              className="input"
              data-mono
              placeholder="all events"
              defaultValue={item.listen.join(", ")}
              spellCheck={false}
              onBlur={(e) =>
                set({
                  listen: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
      ) : (
        <div className="sock__opts sock__opts--ws">
          <label className="field">
            <span className="field__label">Subprotocols</span>
            <input
              className="input"
              data-mono
              placeholder="none"
              value={item.protocols}
              spellCheck={false}
              onChange={(e) => set({ protocols: e.target.value })}
            />
          </label>
        </div>
      )}

      <div className="sock__log-head">
        <span>Messages</span>
        {live.log.length > 0 && (
          <button className="icon-btn" title="Clear" onClick={() => clearLog(item.id)}>
            <X size={14} strokeWidth={1.5} className="icon" />
          </button>
        )}
      </div>
      <MessageLog entries={live.log} status={live.status} traceKey={traceKey} onTrace={setTraceKey} />
      {traceKey && (
        <div className="sock__trace">
          <div className="sock__trace-head">
            <span>
              Trace
              {traceLabel && (
                <span className="sock__trace-what">
                  {traceLabel.dir === "out" ? (traceLabel.event ? `emit ${traceLabel.event}` : "Send") : "Connect"} at{" "}
                  {time(traceLabel.at)}
                </span>
              )}
            </span>
            <button className="icon-btn" title="Close" onClick={() => setTraceKey(null)}>
              <X size={14} strokeWidth={1.5} className="icon" />
            </button>
          </div>
          <SocketTrace traceKey={traceKey} />
        </div>
      )}

      <div className="composer">
        {item.type === "socketio" && (
          <input
            className="composer__event"
            placeholder="event"
            value={item.event}
            spellCheck={false}
            onChange={(e) => set({ event: e.target.value })}
          />
        )}
        <textarea
          className="composer__text"
          rows={3}
          spellCheck={false}
          placeholder={isIo ? '{"lat": 33.59, "lng": -7.62}' : "Message"}
          value={item.draft}
          onChange={(e) => set({ draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer__foot">
          <span className="field__hint">⌘↵ to {isIo ? "emit" : "send"}</span>
          <button className="btn-primary" disabled={!connected} onClick={send}>
            <Send {...ICON} />
            {isIo ? "Emit" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function SocketTrace({ traceKey }: { traceKey: string }) {
  return <TracePanel state={useTrace(traceKey)} none={<TryDemo />} />;
}

function TraceChip({ traceKey, active, onClick }: { traceKey: string; active: boolean; onClick: () => void }) {
  const state = useTrace(traceKey);
  const tone = traceTone(state);
  if (!state || state.status === "none") return null;
  return (
    <button className="msg__trace" data-active={active || undefined} data-tone={tone ?? undefined} title="Show what this called" onClick={onClick}>
      {tone === "busy" ? <Spinner size={11} /> : <Waypoints size={12} strokeWidth={1.75} className="icon" />}
      Trace
    </button>
  );
}

function MessageLog({
  entries,
  status,
  traceKey,
  onTrace,
}: {
  entries: LogEntry[];
  status: string;
  traceKey: string | null;
  onTrace: (key: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="sock__log sock__log--empty">
        {status === "connecting" ? <Spinner /> : status === "open" ? "Connected. Nothing received yet." : "Not connected"}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="sock__log"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {entries.map((m) => (
        <div key={m.id} className="msg" data-dir={m.dir}>
          <span className="msg__icon">
            {m.dir === "in" ? (
              <ArrowDown size={13} strokeWidth={1.75} className="icon" />
            ) : m.dir === "out" ? (
              <ArrowUp size={13} strokeWidth={1.75} className="icon" />
            ) : m.dir === "err" ? (
              <CircleAlert size={13} strokeWidth={1.75} className="icon" />
            ) : (
              <Info size={13} strokeWidth={1.75} className="icon" />
            )}
          </span>
          <div className="msg__main">
            {m.event && <span className="msg__event">{m.event}</span>}
            <pre className="msg__text selectable">{m.text}</pre>
          </div>
          <span className="msg__side">
            {m.trace && (
              <TraceChip
                traceKey={m.trace}
                active={traceKey === m.trace}
                onClick={() => onTrace(traceKey === m.trace ? null : m.trace!)}
              />
            )}
            <span className="msg__time">{time(m.at)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
