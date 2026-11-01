import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, CircleAlert, FileDown, FileUp, FolderGit2, Link2, Network, Plus, RefreshCw, SquareTerminal, Trash2, Unplug } from "lucide-react";
import { ask } from "@tauri-apps/plugin-dialog";
import { inTauri, message } from "../lib/tauri";
import { Empty, ICON, Spinner } from "../ui";
import { docker, mainPort, onProgress, type AddServiceRequest, type EngineStatus, type Service } from "./api";
import { dependencyColumns } from "./layout";
import { AddService } from "./AddService";
import { Inspector } from "./Inspector";
import { forgetProcess, processes, useProcesses, type ProcessInfo } from "./processes";
import "./docker.css";

/** A service still building or pulling, drawn as a card until it runs. */
export type Pending = {
  name: string;
  dependsOn: string[];
  kind: "dockerfile" | "image";
  lines: string[];
  error?: string;
};

export type Node = {
  key: string;
  name: string;
  dependsOn: string[];
  service?: Service;
  pending?: Pending;
  process?: ProcessInfo;
};

/** The port others on the network use to reach a node. */
function nodePort(n: Node): number | null {
  if (n.service) return mainPort(n.service);
  return n.process?.ports[0] ?? null;
}

const POLL_MS = 3000;

export function DockerView({
  network,
  engine,
  onRetry,
  onRemove,
  onExport,
  onImport,
}: {
  network: string;
  engine: EngineStatus;
  onRetry: () => void;
  /** Asks to remove the network, with what's on it */
  onRemove: () => void;
  /** Writes it to a file to share */
  onExport: () => void;
  /** Adds what a file describes to it */
  onImport: () => void;
}) {
  const [services, setServices] = useState<Service[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const allProcesses = useProcesses();
  const procs = useMemo(() => allProcesses.filter((p) => p.network === network), [allProcesses, network]);

  const refresh = useCallback(async () => {
    try {
      setServices(await docker.services(network));
      setLoadError(null);
    } catch (e) {
      setLoadError(message(e));
    }
  }, [network]);

  useEffect(() => {
    setServices(null);
    setSelected(null);
    if (!engine.connected) return;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [engine.connected, refresh]);

  // Build and pull output, routed to the pending card it belongs to
  useEffect(() => {
    const off = onProgress((p) =>
      setPending((all) => {
        const cur = all[p.service];
        if (!cur) return all;
        return { ...all, [p.service]: { ...cur, lines: [...cur.lines, p.line].slice(-400) } };
      }),
    );
    return () => {
      off.then((f) => f());
    };
  }, []);

  const add = async (req: AddServiceRequest) => {
    setAdding(false);
    const name = req.name.trim().toLowerCase();
    setPending((all) => ({
      ...all,
      [name]: { name, dependsOn: req.dependsOn, kind: req.source.kind, lines: [] },
    }));
    setSelected(`pending:${name}`);
    try {
      const svc = await docker.addService({ ...req, name });
      await refresh();
      setPending(({ [name]: _, ...rest }) => rest);
      setSelected((sel) => (sel === `pending:${name}` ? svc.id : sel));
    } catch (e) {
      setPending((all) => ({ ...all, [name]: { ...all[name], error: message(e) } }));
    }
  };

  const nodes: Node[] = useMemo(() => {
    // A command's proxy container is drawn as the command itself
    const list: Node[] = (services ?? [])
      .filter((s) => s.kind !== "process")
      .map((s) => ({ key: s.id, name: s.name, dependsOn: s.dependsOn, service: s }));
    for (const p of procs) {
      list.push({ key: `proc:${p.id}`, name: p.name, dependsOn: p.dependsOn, process: p });
    }
    for (const p of Object.values(pending)) {
      if (!list.some((n) => n.name === p.name)) {
        list.push({ key: `pending:${p.name}`, name: p.name, dependsOn: p.dependsOn, pending: p });
      }
    }
    return list;
  }, [services, pending, procs]);

  const selectedNode = nodes.find((n) => n.key === selected) ?? null;

  const remove = useCallback(
    async (s: Service) => {
      const verb = s.managed ? "Remove" : "Disconnect";
      const text = s.managed
        ? `Remove ${s.name}? Its container is stopped and deleted. The image stays.`
        : `Disconnect ${s.name} from ${network}? The container itself is left alone.`;
      const ok = inTauri ? await ask(text, { title: `${verb} service`, kind: "warning", okLabel: verb }) : confirm(text);
      if (!ok) return;
      try {
        await docker.remove(s.id, network);
        setSelected(null);
        await refresh();
      } catch (e) {
        setLoadError(message(e));
      }
    },
    [network, refresh],
  );

  const removeProcess = useCallback(async (p: ProcessInfo) => {
    const text = `Remove ${p.name}? It is stopped, and its command and settings are deleted from UAT. The folder is left alone.`;
    const ok = inTauri ? await ask(text, { title: "Remove service", kind: "warning", okLabel: "Remove" }) : confirm(text);
    if (!ok) return;
    try {
      await processes.remove(p.id);
      forgetProcess(p.id);
      setSelected(null);
    } catch (e) {
      setLoadError(message(e));
    }
  }, []);

  const dismissPending = (name: string) => {
    setPending(({ [name]: _, ...rest }) => rest);
    setSelected(null);
  };

  // ⌫ removes the selected service, as on the canvas in the demo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key !== "Backspace" && e.key !== "Delete") return;
      if (selectedNode?.service) remove(selectedNode.service);
      else if (selectedNode?.process) removeProcess(selectedNode.process);
      else if (selectedNode?.pending?.error) dismissPending(selectedNode.name);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNode, remove, removeProcess]);

  const count = nodes.filter((n) => !n.pending).length;

  return (
    <section className="dk">
      <header className="toolbar" data-tauri-drag-region>
        <div className="crumbs" data-tauri-drag-region>
          <Network {...ICON} className="icon crumbs__icon" />
          <span className="crumbs__name">{network}</span>
          {(services || !engine.connected) && (
            <span className="crumbs__meta">
              {count} {count === 1 ? "service" : "services"}
            </span>
          )}
        </div>
        <div className="toolbar__actions">
          {engine.connected && (
            <>
              <button className="icon-btn" title={`Import a network file into ${network}…`} onClick={onImport}>
                <FileDown {...ICON} />
              </button>
              <button className="icon-btn" title="Export network…" onClick={onExport}>
                <FileUp {...ICON} />
              </button>
              <button className="icon-btn" title="Remove network…" onClick={onRemove}>
                <Trash2 {...ICON} />
              </button>
              <button className="icon-btn" title="Refresh" onClick={refresh}>
                <RefreshCw {...ICON} />
              </button>
            </>
          )}
          <button
            ref={addRef}
            className="btn-primary"
            data-open={adding || undefined}
            onClick={() => setAdding((a) => !a)}
          >
            <Plus {...ICON} />
            Add service
          </button>
        </div>
        {adding && (
          <AddService
            network={network}
            engineUp={engine.connected}
            services={nodes.flatMap((n) => (n.service ?? n.process ? [{ name: n.name, id: n.key }] : []))}
            anchor={addRef}
            onClose={() => setAdding(false)}
            onSubmit={add}
            onAttached={async (id) => {
              setAdding(false);
              await refresh();
              setSelected(id);
            }}
            onCreated={(p) => {
              setAdding(false);
              setSelected(`proc:${p.id}`);
            }}
          />
        )}
      </header>

      <div className="dk__body">
        {!engine.connected && nodes.length === 0 ? (
          <div className="dk__canvas">
            <Empty
              icon={Unplug}
              title="Docker engine isn't running"
              actions={
                <>
                  <button className="btn" onClick={onRetry}>
                    <RefreshCw {...ICON} />
                    Try again
                  </button>
                  {inTauri && (
                    <button className="btn" onClick={() => setAdding(true)}>
                      <SquareTerminal {...ICON} />
                      Run a command
                    </button>
                  )}
                </>
              }
            >
              {engine.error ?? "Start Docker Desktop, OrbStack or Colima. UAT connects on its own when the engine is up."}
            </Empty>
          </div>
        ) : engine.connected && services === null && !loadError ? (
          <div className="dk__canvas">
            <Empty icon={Network} title="Loading services…" />
          </div>
        ) : nodes.length === 0 ? (
          <div className="dk__canvas">
            <Empty
              icon={Network}
              title={`No services on ${network} yet`}
              actions={
                <button className="btn-primary" onClick={() => setAdding(true)}>
                  <Plus {...ICON} />
                  Add service
                </button>
              }
            >
              Add one from a repo's Dockerfile, an image, or a command like{" "}
              <span className="mono">npm run dev</span>. Every service here reaches the others by name, like{" "}
              <span className="mono">postgres:5432</span>.
            </Empty>
          </div>
        ) : (
          <div className="dk__main">
            {!engine.connected && (
              <div className="dk__banner">
                <Unplug size={14} strokeWidth={1.5} className="icon" />
                Docker isn't running, so containers are hidden and commands can't join {network}.
                <button className="dk__banner-btn" onClick={onRetry}>
                  Try again
                </button>
              </div>
            )}
            <Canvas nodes={nodes} selected={selected} onSelect={setSelected} />
          </div>
        )}

        {selectedNode && (
          <Inspector
            key={selectedNode.key}
            node={selectedNode}
            network={network}
            nodes={nodes}
            onChanged={refresh}
            onRemove={remove}
            onRemoveProcess={removeProcess}
            onDismiss={() => dismissPending(selectedNode.name)}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
      {loadError && engine.connected && (
        <div className="dk__toast">
          <CircleAlert {...ICON} />
          {loadError}
        </div>
      )}
    </section>
  );
}

type Link = { from: string; to: string; d: string; end: [number, number]; x: number; y: number; label: string };

function Canvas({ nodes, selected, onSelect }: { nodes: Node[]; selected: string | null; onSelect: (k: string | null) => void }) {
  const columns = useMemo(() => dependencyColumns(nodes), [nodes]);
  const contentRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [links, setLinks] = useState<Link[]>([]);

  const measure = useCallback(() => {
    const box = (key: string) => {
      const el = cardRefs.current.get(key);
      if (!el) return null;
      return { l: el.offsetLeft, t: el.offsetTop, r: el.offsetLeft + el.offsetWidth, m: el.offsetTop + el.offsetHeight / 2 };
    };
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const out: Link[] = [];
    for (const n of nodes) {
      for (const depName of n.dependsOn) {
        const dep = byName.get(depName);
        const a = box(n.key);
        const b = dep && box(dep.key);
        if (!dep || !a || !b) continue;
        let d: string;
        let end: [number, number];
        if (b.l >= a.r) {
          const dx = Math.max(30, (b.l - a.r) / 2);
          d = `M${a.r},${a.m} C${a.r + dx},${a.m} ${b.l - dx},${b.m} ${b.l},${b.m}`;
          end = [b.l, b.m];
        } else {
          // Same column: loop out to the right and back in
          const x = Math.max(a.r, b.r) + 36;
          d = `M${a.r},${a.m} C${x},${a.m} ${x},${b.m} ${b.r},${b.m}`;
          end = [b.r, b.m];
        }
        const port = nodePort(dep);
        out.push({
          from: n.key,
          to: dep.key,
          d,
          end,
          x: b.l >= a.r ? (a.r + b.l) / 2 : Math.max(a.r, b.r) + 27,
          y: (a.m + b.m) / 2,
          label: port ? `${dep.name}:${port}` : dep.name,
        });
      }
    }
    setLinks(out);
  }, [nodes]);

  useLayoutEffect(measure, [measure, columns]);
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [measure]);

  const card = (n: Node) => (
    <Card
      key={n.key}
      node={n}
      selected={selected === n.key}
      onSelect={() => onSelect(n.key)}
      ref={(el) => {
        if (el) cardRefs.current.set(n.key, el);
        else cardRefs.current.delete(n.key);
      }}
    />
  );

  return (
    <div className="dk__canvas" onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}>
      <div
        ref={contentRef}
        className="dk__content"
        data-layout={columns ? "columns" : "grid"}
        onPointerDown={(e) => e.target === e.currentTarget && onSelect(null)}
      >
        <svg className="dk__links" aria-hidden>
          {links.map((l) => (
            <path
              key={`${l.from}>${l.to}`}
              d={l.d}
              data-active={selected === l.from || selected === l.to || undefined}
            />
          ))}
          {links.map((l) => (
            <circle
              key={`${l.from}>${l.to}:end`}
              r={3}
              cx={l.end[0]}
              cy={l.end[1]}
              data-active={selected === l.from || selected === l.to || undefined}
            />
          ))}
        </svg>
        {links.map((l) => (
          <span
            key={`${l.from}>${l.to}:label`}
            className="dk__link-label"
            data-active={selected === l.from || selected === l.to || undefined}
            style={{ left: l.x, top: l.y }}
          >
            {l.label}
          </span>
        ))}
        {columns
          ? columns.map((col, i) => (
              <div key={i} className="dk__column">
                {col.map(card)}
              </div>
            ))
          : nodes.map(card)}
      </div>
    </div>
  );
}

function Card({
  node,
  selected,
  onSelect,
  ref,
}: {
  node: Node;
  selected: boolean;
  onSelect: () => void;
  ref: (el: HTMLButtonElement | null) => void;
}) {
  const { service: s, pending: p, process: proc } = node;
  const kind = proc ? "process" : (s?.kind ?? p?.kind ?? "image");
  const Icon = kind === "dockerfile" ? FolderGit2 : kind === "external" ? Link2 : kind === "process" ? SquareTerminal : Box;
  const state = proc ? processDot(proc) : p ? (p.error ? "error" : "building") : (s?.state ?? "");

  let meta: string;
  if (proc) meta = `${proc.command}${proc.ports.length ? ` · ${proc.ports[0]}` : ""}`;
  else if (p) meta = p.error ? "Failed. Select to see why" : (p.lines.at(-1) ?? (p.kind === "dockerfile" ? "Building…" : "Pulling…"));
  else {
    const port = s!.ports[0];
    const portText = port ? (port.host ? ` · ${port.host}→${port.container}` : ` · ${port.container}`) : "";
    meta = `${s!.image.replace(/:latest$/, "")}${portText}`;
  }

  return (
    <button ref={ref} className="svc" data-kind={kind} data-selected={selected || undefined} data-state={state} onClick={onSelect}>
      <span className="svc__tile">
        <Icon {...ICON} />
      </span>
      <span className="svc__lines">
        <span className="svc__head">
          <span className="svc__name">{node.name}</span>
          {state === "building" ? (
            <Spinner size={12} />
          ) : (
            <span className="dot" data-state={state} title={proc ? processStatus(proc) : (s?.status ?? state)} />
          )}
        </span>
        <span className="svc__meta">{meta}</span>
      </span>
      {state === "building" && <span className="svc__progress" />}
    </button>
  );
}

/** The status dot's color for a command. */
export function processDot(p: ProcessInfo): string {
  switch (p.state) {
    case "running":
      return p.networkError ? "paused" : "running";
    case "starting":
    case "stopping":
      return "restarting";
    case "failed":
      return "error";
    case "exited":
      return p.exitCode === 0 ? "exited" : "error";
    default:
      return "exited";
  }
}

export function processStatus(p: ProcessInfo): string {
  switch (p.state) {
    case "running":
      return p.pid ? `Running · pid ${p.pid}` : "Running";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Couldn't start";
    case "exited":
      return p.exitCode === null ? "Exited on a signal" : `Exited with code ${p.exitCode}`;
    default:
      return "Stopped";
  }
}
