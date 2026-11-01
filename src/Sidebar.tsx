import { useRef, useState } from "react";
import { FileDown, FileUp, Layers, Network, Plug, Plus, Trash2, Workflow } from "lucide-react";
import { DEFAULT_NETWORK, docker, type EngineStatus, type NetworkInfo } from "./docker/api";
import { message } from "./lib/tauri";
import { ICON, Menu } from "./ui";
import { Logo } from "./Logo";
import { version } from "../package.json";

export type View = { kind: "network"; name: string } | { kind: "collections" } | { kind: "flows" } | { kind: "mcp" };

export function Sidebar({
  view,
  onView,
  engine,
  networks,
  onNetworkCreated,
  onRemoveNetwork,
  onExportNetwork,
  onImportNetwork,
}: {
  view: View;
  onView: (v: View) => void;
  engine: EngineStatus;
  networks: NetworkInfo[];
  onNetworkCreated: (name: string) => void;
  onRemoveNetwork: (name: string) => void;
  onExportNetwork: (name: string) => void;
  onImportNetwork: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState<{ top: number; left: number } | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Offline, the default network still shows, so its page can say why it's empty
  const names = networks.length ? networks.map((n) => n.name) : [DEFAULT_NETWORK];

  const create = async (raw: string) => {
    setCreating(false);
    const name = raw.trim();
    if (!name) return;
    try {
      await docker.createNetwork(name);
      setError(null);
      onNetworkCreated(name);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <aside className="side">
      <div className="side__top" data-tauri-drag-region />
      <div className="side__scroll">
        <div className="side__group">
          <div className="side__section">
            Networks
            {engine.connected && (
              <button
                ref={addRef}
                className="icon-btn side__add"
                title="New or import a network"
                data-open={adding || undefined}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setAdding((a) => (a ? null : { top: r.bottom + 4, left: Math.max(8, r.right - 180) }));
                }}
              >
                <Plus size={14} strokeWidth={1.75} className="icon" />
              </button>
            )}
          </div>
          {names.map((name) => (
            <button
              key={name}
              className="nav"
              data-active={(view.kind === "network" && view.name === name) || undefined}
              onClick={() => onView({ kind: "network", name })}
              onContextMenu={(e) => {
                if (!engine.connected) return;
                e.preventDefault();
                setMenu({ name, x: e.clientX, y: e.clientY });
              }}
            >
              <Network {...ICON} />
              <span className="nav__label">{name}</span>
            </button>
          ))}
          {creating && (
            <div className="nav nav--input">
              <Network {...ICON} />
              <input
                autoFocus
                placeholder="network-name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") create(e.currentTarget.value);
                  if (e.key === "Escape") setCreating(false);
                }}
                onBlur={(e) => create(e.currentTarget.value)}
              />
            </div>
          )}
          {error && <div className="side__error">{error}</div>}
          {adding && (
            <Menu
              entries={[
                { label: "New network", icon: Plus, onSelect: () => setCreating(true) },
                { label: "Import network…", icon: FileDown, onSelect: onImportNetwork },
              ]}
              onClose={() => setAdding(null)}
              anchor={addRef}
              style={{ position: "fixed", ...adding }}
            />
          )}
          {menu && (
            <Menu
              entries={[
                { label: "Export network…", icon: FileUp, onSelect: () => onExportNetwork(menu.name) },
                "separator",
                { label: "Remove network…", icon: Trash2, danger: true, onSelect: () => onRemoveNetwork(menu.name) },
              ]}
              onClose={() => setMenu(null)}
              style={{ position: "fixed", top: menu.y, left: menu.x }}
            />
          )}
        </div>

        <div className="side__group">
          <div className="side__section">API</div>
          <button
            className="nav"
            data-active={view.kind === "collections" || undefined}
            onClick={() => onView({ kind: "collections" })}
          >
            <Layers {...ICON} />
            <span className="nav__label">Collections</span>
          </button>
          <button className="nav" data-active={view.kind === "flows" || undefined} onClick={() => onView({ kind: "flows" })}>
            <Workflow {...ICON} />
            <span className="nav__label">Flows</span>
          </button>
        </div>

        <div className="side__group">
          <div className="side__section">Agents</div>
          <button className="nav" data-active={view.kind === "mcp" || undefined} onClick={() => onView({ kind: "mcp" })}>
            <Plug {...ICON} />
            <span className="nav__label">MCP server</span>
          </button>
        </div>
      </div>

      <div className="side__foot">
        <Logo size={28} />
        <div className="side__id">
          <div className="side__name">
            UAT <span className="side__version">{version}</span>
          </div>
          <div className="side__engine" title={engine.socket ?? engine.error ?? undefined}>
            <span className="dot" data-state={engine.connected ? "running" : undefined} />
            {engine.connected ? `Docker ${engine.version ?? ""}`.trim() : "Docker engine offline"}
          </div>
        </div>
      </div>
    </aside>
  );
}
