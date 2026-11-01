import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Play, RefreshCw, RotateCw, Square, Trash, Unplug, X } from "lucide-react";
import { message } from "../lib/tauri";
import { ICON, Spinner } from "../ui";
import { docker, parsePorts, type Service } from "./api";
import { processDot, processStatus, type Node } from "./DockerView";
import { processes, useProcessLogs, type LogLine, type ProcessInfo } from "./processes";

export function Inspector({
  node,
  network,
  nodes,
  onChanged,
  onRemove,
  onRemoveProcess,
  onDismiss,
  onClose,
}: {
  node: Node;
  network: string;
  nodes: Node[];
  onChanged: () => void;
  onRemove: (s: Service) => void;
  onRemoveProcess: (p: ProcessInfo) => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  const { service: s, pending: p, process: proc } = node;
  return (
    <aside className="insp">
      <div className="insp__head">
        <div className="insp__title">{node.name}</div>
        <button className="icon-btn" title="Close" onClick={onClose}>
          <X {...ICON} />
        </button>
      </div>
      {proc ? (
        <ProcessDetails process={proc} network={network} nodes={nodes} onRemove={onRemoveProcess} />
      ) : s ? (
        <ServiceDetails service={s} network={network} nodes={nodes} onChanged={onChanged} onRemove={onRemove} />
      ) : (
        p && (
          <>
            <div className="insp__status">
              {p.error ? (
                <span className="error-text">{p.error}</span>
              ) : (
                <>
                  <Spinner size={12} />
                  {p.kind === "dockerfile" ? "Building image" : "Pulling image"}
                </>
              )}
            </div>
            <Log text={p.lines.join("\n")} follow />
            {p.error && (
              <div className="insp__actions">
                <button className="btn" onClick={onDismiss}>
                  Dismiss
                </button>
              </div>
            )}
          </>
        )
      )}
    </aside>
  );
}

function ServiceDetails({
  service: s,
  network,
  nodes,
  onChanged,
  onRemove,
}: {
  service: Service;
  network: string;
  nodes: Node[];
  onChanged: () => void;
  onRemove: (s: Service) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const running = s.state === "running";

  const loadLogs = useCallback(async () => {
    try {
      setLogs(await docker.logs(s.id));
    } catch (e) {
      setLogs(message(e));
    }
  }, [s.id]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs, s.state]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const usedBy = nodes.filter((o) => o.dependsOn.includes(s.name)).map((o) => o.name);
  const reach = s.ports.length ? s.ports.map((p) => `${s.name}:${p.container}`) : [s.name];
  const published = s.ports.filter((p) => p.host).map((p) => `localhost:${p.host}`);

  return (
    <>
      <div className="insp__status">
        <span className="dot" data-state={s.state} />
        {s.status || s.state}
      </div>

      <dl className="insp__facts">
        <dt>On the network</dt>
        <dd>
          {reach.map((r) => (
            <CopyText key={r} text={r} />
          ))}
        </dd>
        {published.length > 0 && (
          <>
            <dt>From this Mac</dt>
            <dd>
              {published.map((r) => (
                <CopyText key={r} text={r} />
              ))}
            </dd>
          </>
        )}
        <dt>Image</dt>
        <dd className="mono selectable">{s.image}</dd>
        {s.kind === "dockerfile" && s.source && (
          <>
            <dt>Built from</dt>
            <dd className="mono selectable">{s.source}</dd>
          </>
        )}
        {s.dependsOn.length > 0 && (
          <>
            <dt>Connects to</dt>
            <dd>{s.dependsOn.join(", ")}</dd>
          </>
        )}
        {usedBy.length > 0 && (
          <>
            <dt>Used by</dt>
            <dd>{usedBy.join(", ")}</dd>
          </>
        )}
        <dt>Container</dt>
        <dd className="mono selectable">{s.containerName}</dd>
      </dl>

      <div className="insp__actions">
        {running ? (
          <button className="btn" disabled={busy} onClick={() => act(() => docker.stop(s.id))}>
            <Square {...ICON} />
            Stop
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={() => act(() => docker.start(s.id))}>
            <Play {...ICON} />
            Start
          </button>
        )}
        <button className="btn" data-danger disabled={busy} onClick={() => onRemove(s)}>
          {s.managed ? <Trash {...ICON} /> : <Unplug {...ICON} />}
          {s.managed ? "Remove" : `Disconnect from ${network}`}
        </button>
        {busy && <Spinner />}
      </div>
      {error && <div className="error-text insp__error">{error}</div>}

      <div className="insp__logs-head">
        <span>Logs</span>
        <button className="icon-btn" title="Reload logs" onClick={loadLogs}>
          <RefreshCw size={14} strokeWidth={1.5} className="icon" />
        </button>
      </div>
      <Log text={logs ?? ""} follow />
    </>
  );
}

const envText = (env: string[]) => env.join("\n");

function ProcessDetails({
  process: p,
  network,
  nodes,
  onRemove,
}: {
  process: ProcessInfo;
  network: string;
  nodes: Node[];
  onRemove: (p: ProcessInfo) => void;
}) {
  const logs = useProcessLogs(p.id);
  const [command, setCommand] = useState(p.command);
  const [ports, setPorts] = useState(p.ports.join(", "));
  const [env, setEnv] = useState(envText(p.env));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = p.state === "running" || p.state === "starting" || p.state === "stopping";
  const dirty = command.trim() !== p.command || ports !== p.ports.join(", ") || env.trim() !== envText(p.env);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      const parsed = parsePorts(ports);
      if (parsed.error || parsed.ports.some((x) => x.host !== null)) {
        throw new Error("Ports are the ones the command listens on, like 3000, 9229.");
      }
      await processes.update(p.id, {
        command: command.trim(),
        ports: parsed.ports.map((x) => x.container),
        env: env.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
      });
      setPorts(parsed.ports.map((x) => x.container).join(", "));
      // Settings apply on start
      if (active) await processes.restart(p.id);
    });

  const reach = p.ports.map((port) => `${p.name}:${port}`);
  const local = p.ports.map((port) => `localhost:${port}`);
  const usedBy = nodes.filter((o) => o.dependsOn.includes(p.name)).map((o) => o.name);
  // What it connects to, as this Mac reaches them: their published ports
  const deps = p.dependsOn.map((name) => {
    const dep = nodes.find((n) => n.name === name);
    const port = dep?.service?.ports.find((x) => x.host)?.host ?? dep?.process?.ports[0];
    return { name, at: port ? `localhost:${port}` : null };
  });

  return (
    <>
      <div className="insp__status">
        {p.state === "starting" || p.state === "stopping" ? (
          <Spinner size={12} />
        ) : (
          <span className="dot" data-state={processDot(p)} />
        )}
        {processStatus(p)}
      </div>

      <dl className="insp__facts">
        <dt>On {network}</dt>
        <dd>
          {reach.length === 0 ? (
            <span className="insp__muted">No port, so containers can't reach it</span>
          ) : p.networkError ? (
            <span className="insp__warn">{p.networkError}</span>
          ) : (
            reach.map((r) => <CopyText key={r} text={r} />)
          )}
        </dd>
        {local.length > 0 && (
          <>
            <dt>From this Mac</dt>
            <dd>
              {local.map((r) => (
                <CopyText key={r} text={r} />
              ))}
            </dd>
          </>
        )}
        <dt>Folder</dt>
        <dd className="mono selectable">{p.cwd}</dd>
        {deps.length > 0 && (
          <>
            <dt>Connects to</dt>
            <dd>
              {deps.map((d) =>
                d.at ? (
                  <CopyText key={d.name} text={d.at} label={d.name} />
                ) : (
                  <span key={d.name} title="Publish a host port to reach it from this Mac">
                    {d.name} <span className="insp__muted">· not published</span>
                  </span>
                ),
              )}
            </dd>
          </>
        )}
        {usedBy.length > 0 && (
          <>
            <dt>Used by</dt>
            <dd>{usedBy.join(", ")}</dd>
          </>
        )}
      </dl>

      <div className="insp__edit">
        <label className="field">
          <span className="field__label">Command</span>
          <input
            className="input"
            data-mono
            spellCheck={false}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Ports</span>
          <input
            className="input"
            data-mono
            placeholder="none"
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Environment</span>
          <textarea
            className="textarea"
            data-mono
            rows={2}
            spellCheck={false}
            placeholder="KEY=value"
            value={env}
            onChange={(e) => setEnv(e.target.value)}
          />
        </label>
      </div>

      <div className="insp__actions">
        {dirty ? (
          <button className="btn-primary" disabled={busy || !command.trim()} onClick={save}>
            {active ? "Save & restart" : "Save"}
          </button>
        ) : active ? (
          <>
            <button className="btn" disabled={busy || p.state === "stopping"} onClick={() => act(() => processes.stop(p.id))}>
              <Square {...ICON} />
              Stop
            </button>
            <button className="btn" disabled={busy} onClick={() => act(() => processes.restart(p.id))}>
              <RotateCw {...ICON} />
              Restart
            </button>
          </>
        ) : (
          <button className="btn" disabled={busy} onClick={() => act(() => processes.start(p.id))}>
            <Play {...ICON} />
            Start
          </button>
        )}
        <button className="btn" data-danger disabled={busy} onClick={() => onRemove(p)}>
          <Trash {...ICON} />
          Remove
        </button>
        {busy && <Spinner />}
      </div>
      {error && <div className="error-text insp__error">{error}</div>}

      <div className="insp__logs-head">
        <span>Output</span>
        {logs.length > 0 && (
          <button className="icon-btn" title="Clear" onClick={() => processes.clearLogs(p.id)}>
            <X size={14} strokeWidth={1.5} className="icon" />
          </button>
        )}
      </div>
      <ProcessLog lines={logs} />
    </>
  );
}

function ProcessLog({ lines }: { lines: LogLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div
      ref={ref}
      className="insp__log selectable"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length === 0 ? (
        <span className="insp__log-empty">No output yet</span>
      ) : (
        lines.map((l) => (
          <div key={l.seq} className="insp__line" data-stream={l.stream}>
            {l.text.replace(ANSI, "") || "\u00a0"}
          </div>
        ))
      )}
    </div>
  );
}

function CopyText({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="insp__copy"
      title="Copy"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {label && <span>{label}</span>}
      <span className="mono">{text}</span>
      <Copy size={12} strokeWidth={1.5} className="icon" data-copied={copied || undefined} />
    </button>
  );
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function Log({ text, follow }: { text: string; follow?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, follow]);
  return (
    <pre ref={ref} className="insp__log selectable">
      {text.replace(ANSI, "") || <span className="insp__log-empty">No output yet</span>}
    </pre>
  );
}
