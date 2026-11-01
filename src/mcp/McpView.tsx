import { useCallback, useEffect, useState } from "react";
import { Check, CircleAlert, Copy, Eye, EyeOff, Plug } from "lucide-react";
import { message } from "../lib/tauri";
import { ICON, Spinner } from "../ui";
import { mcpApi, type McpClient, type McpStatus } from "./api";
import { useActivity, type Activity } from "./bridge";
import { TOOL_GROUPS } from "./tools";
import "./mcp.css";

const POLL_MS = 4000;

const STATE_WORD: Record<McpClient["state"], string> = {
  installed: "Added",
  outdated: "Points at another copy of UAT",
  missing: "Not added",
};

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      className="icon-btn"
      title={label}
      onClick={() => navigator.clipboard.writeText(text).then(() => setDone(true), () => {})}
    >
      {done ? <Check {...ICON} /> : <Copy {...ICON} />}
    </button>
  );
}

function ClientRow({ client, onChange }: { client: McpClient; onChange: (c: McpClient) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const act = async (install: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await (install ? mcpApi.install(client.id) : mcpApi.uninstall(client.id)));
      setAdded(install);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const problem = error ?? client.error;
  return (
    <li className="mcp-client" data-state={client.state}>
      <div className="mcp-client__main">
        <div className="mcp-client__name">
          {client.name}
          {!client.detected && client.state === "missing" && <span className="mcp-client__aside">Not found on this Mac</span>}
        </div>
        <div className="mcp-client__config mono">{client.config}</div>
        {added && client.state === "installed" && <div className="mcp-client__then">{client.then}</div>}
        {problem && (
          <div className="mcp-client__error">
            <CircleAlert size={13} strokeWidth={1.75} className="icon" />
            {problem}
          </div>
        )}
      </div>
      <span className="mcp-pill" data-state={client.state}>
        {STATE_WORD[client.state]}
      </span>
      {client.state === "installed" ? (
        <button className="btn" disabled={busy} onClick={() => act(false)}>
          {busy && <Spinner />}
          Remove
        </button>
      ) : (
        <button className={client.detected ? "btn-primary" : "btn"} disabled={busy} onClick={() => act(true)}>
          {busy && <Spinner />}
          {client.state === "outdated" ? "Update" : "Add"}
        </button>
      )}
    </li>
  );
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function ActivityRow({ a }: { a: Activity }) {
  const state = a.ok === undefined ? "connecting" : a.ok ? "running" : "error";
  return (
    <li className="mcp-call">
      <span className="dot" data-state={state} />
      <span className="mcp-call__at">{clock(a.at)}</span>
      <div className="mcp-call__main">
        <div className="mcp-call__head">
          <span className="mcp-call__title">{a.title}</span>
          {a.args && <span className="mcp-call__args mono">{a.args}</span>}
        </div>
        {a.result && <div className="mcp-call__result" data-ok={a.ok || undefined}>{a.result}</div>}
      </div>
      <span className="mcp-call__ms">{a.ms === undefined ? <Spinner size={12} /> : `${a.ms} ms`}</span>
    </li>
  );
}

export function McpView() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [clients, setClients] = useState<McpClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const activity = useActivity();

  const refresh = useCallback(() => {
    mcpApi.status().then(setStatus, (e) => setError(message(e)));
  }, []);

  useEffect(() => {
    refresh();
    mcpApi.clients().then(setClients, (e) => setError(message(e)));
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const toggle = async () => {
    if (!status) return;
    setToggling(true);
    try {
      setStatus(await mcpApi.setEnabled(!status.enabled));
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setToggling(false);
    }
  };

  const meta = !status
    ? ""
    : status.running
      ? `Listening on 127.0.0.1:${status.port}`
      : status.enabled
        ? "Not running"
        : "Off";

  // The args on one line, as people write it
  const snippet = status
    ? JSON.stringify({ mcpServers: { uat: { command: status.command, args: status.args } } }, null, 2).replace(
        /\[\s+([^\]]*?)\s+\]/g,
        (_, inner: string) => `[${inner.replace(/\s*\n\s*/g, " ")}]`,
      )
    : "";
  const token = status?.token ?? "";
  const header = `Authorization: Bearer ${token}`;

  return (
    <section className="mcp">
      <header className="toolbar" data-tauri-drag-region>
        <div className="crumbs" data-tauri-drag-region>
          <Plug {...ICON} className="icon crumbs__icon" />
          <span className="crumbs__name">MCP server</span>
          {meta && <span className="crumbs__meta">{meta}</span>}
        </div>
        <div className="toolbar__actions">
          {status && (
            <button
              className="mcp-switch"
              role="switch"
              aria-checked={status.enabled}
              aria-label="MCP server"
              disabled={toggling}
              onClick={toggle}
            >
              <span className="mcp-switch__knob" />
            </button>
          )}
        </div>
      </header>

      <div className="mcp__scroll">
        <div className="mcp__page">
          <p className="mcp__lead">
            AI agents use UAT through its MCP server: they run and stop services, read their logs, save and send
            requests, follow their traces, build and run flows, and read their reports. What an agent does shows here
            as it happens.
          </p>

          {(error || status?.error) && (
            <div className="mcp__error">
              <CircleAlert size={14} strokeWidth={1.75} className="icon" />
              {error ?? status?.error}
            </div>
          )}

          <h2 className="mcp__h">Agents</h2>
          {clients ? (
            <ul className="mcp-card mcp-clients">
              {clients.map((c) => (
                <ClientRow key={c.id} client={c} onChange={(n) => setClients((all) => all?.map((x) => (x.id === n.id ? n : x)) ?? null)} />
              ))}
            </ul>
          ) : (
            <div className="mcp-card mcp__loading">
              <Spinner /> Looking for agents…
            </div>
          )}

          <h2 className="mcp__h">Any other agent</h2>
          <div className="mcp-card mcp-snippets">
            <div className="mcp-snippet">
              <div className="mcp-snippet__head">
                <span className="mcp-snippet__title">Runs a command</span>
                <span className="mcp-snippet__hint">stdio · opens UAT when it isn't running</span>
                <CopyButton text={snippet} />
              </div>
              <pre className="mcp-snippet__code mono selectable">{snippet}</pre>
            </div>
            <div className="mcp-snippet">
              <div className="mcp-snippet__head">
                <span className="mcp-snippet__title">Connects to a URL</span>
                <span className="mcp-snippet__hint">Streamable HTTP · while UAT is open</span>
                <CopyButton text={status?.url ?? ""} label="Copy URL" />
              </div>
              <pre className="mcp-snippet__code mono selectable">{status?.url ?? "Not running"}</pre>
              <div className="mcp-snippet__head">
                <span className="mcp-snippet__hint">With this header. Keep it private: it lets anything on this Mac use UAT.</span>
                <button className="icon-btn" title={showToken ? "Hide" : "Show"} onClick={() => setShowToken((s) => !s)}>
                  {showToken ? <EyeOff {...ICON} /> : <Eye {...ICON} />}
                </button>
                <CopyButton text={header} label="Copy header" />
              </div>
              <pre className="mcp-snippet__code mono selectable">
                {showToken ? header : `Authorization: Bearer ${"•".repeat(24)}`}
              </pre>
            </div>
          </div>

          <h2 className="mcp__h">
            Activity <span className="mcp__count">{activity.length || ""}</span>
          </h2>
          {activity.length ? (
            <ul className="mcp-card mcp-calls">
              {activity.map((a) => (
                <ActivityRow key={a.id} a={a} />
              ))}
            </ul>
          ) : (
            <div className="mcp-card mcp__none">No calls yet. Add UAT to an agent, then ask it to list UAT's services.</div>
          )}

          <h2 className="mcp__h">
            Tools <span className="mcp__count">{TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0)}</span>
          </h2>
          <div className="mcp-tools">
            {TOOL_GROUPS.map((g) => (
              <div key={g.name} className="mcp-card mcp-tools__group">
                <div className="mcp-tools__name">{g.name}</div>
                <ul>
                  {g.tools.map((t) => (
                    <li key={t.name} title={t.description}>
                      <span className="mcp-tools__title">{t.title}</span>
                      <span className="mono mcp-tools__id">{t.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
