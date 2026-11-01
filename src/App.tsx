import { useCallback, useEffect, useState } from "react";
import { Sidebar, type View } from "./Sidebar";
import { DockerView } from "./docker/DockerView";
import { CollectionsView } from "./collections/CollectionsView";
import { FlowsView } from "./flows/FlowsView";
import { McpView } from "./mcp/McpView";
import { RemoveNetwork } from "./docker/RemoveNetwork";
import { ExportNetwork } from "./docker/ExportNetwork";
import { ImportNetwork } from "./docker/ImportNetwork";
import { DEFAULT_NETWORK, docker, type EngineStatus, type NetworkInfo } from "./docker/api";
import { message } from "./lib/tauri";

const OFFLINE: EngineStatus = { connected: false, socket: null, version: null, error: null };

/** Engine status and networks. Checks often while the engine is down, so
 *  the app comes up on its own when Docker starts. */
function useEngine() {
  const [engine, setEngine] = useState<EngineStatus>(OFFLINE);
  const [networks, setNetworks] = useState<NetworkInfo[]>([]);

  const check = useCallback(async () => {
    const status = await docker.status();
    setEngine(status);
    if (status.connected) {
      try {
        setNetworks(await docker.networks());
      } catch (e) {
        setEngine({ ...status, error: message(e) });
      }
    }
    return status.connected;
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const loop = async () => {
      const up = await check().catch(() => false);
      if (!stopped) timer = setTimeout(loop, up ? 15000 : 4000);
    };
    loop();
    // An agent made a network
    const now = () => check().catch(() => {});
    window.addEventListener("uat:networks", now);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("uat:networks", now);
    };
  }, [check]);

  return { engine, networks, refresh: check };
}

const VIEW_KEY = "uat.view";

function isView(v: unknown): v is View {
  const k = (v as View | null)?.kind;
  return k === "collections" || k === "flows" || k === "mcp" || (k === "network" && typeof (v as { name?: unknown }).name === "string");
}

function savedView(): View {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    if (isView(v)) return v;
  } catch {
    // First run or storage blocked
  }
  return { kind: "network", name: DEFAULT_NETWORK };
}

export default function App() {
  const [view, setView] = useState<View>(savedView);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // Remembering the section is a convenience only
    }
  }, [view]);

  // An agent asked to show a section
  useEffect(() => {
    const show = (e: Event) => {
      const v = (e as CustomEvent<unknown>).detail;
      if (isView(v)) setView(v);
    };
    window.addEventListener("uat:show", show);
    return () => window.removeEventListener("uat:show", show);
  }, []);

  const { engine, networks, refresh } = useEngine();
  const [removing, setRemoving] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [importing, setImporting] = useState<{ into?: string } | null>(null);

  // A network went, here or by an agent: off it, unless it's made again
  useEffect(() => {
    const gone = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      refresh().catch(() => {});
      setView((v) => (v.kind === "network" && v.name === name && name !== DEFAULT_NETWORK ? { kind: "network", name: DEFAULT_NETWORK } : v));
    };
    window.addEventListener("uat:network-removed", gone);
    return () => window.removeEventListener("uat:network-removed", gone);
  }, [refresh]);

  return (
    <div className="app">
      <Sidebar
        view={view}
        onView={setView}
        engine={engine}
        networks={networks}
        onNetworkCreated={async (name) => {
          await refresh();
          setView({ kind: "network", name });
        }}
        onRemoveNetwork={setRemoving}
        onExportNetwork={setExporting}
        onImportNetwork={() => setImporting({})}
      />
      <main className="app__main">
        {view.kind === "network" ? (
          <DockerView key={view.name} network={view.name} engine={engine} onRetry={refresh} onRemove={() => setRemoving(view.name)}
            onExport={() => setExporting(view.name)}
            onImport={() => setImporting({ into: view.name })}
          />
        ) : view.kind === "flows" ? (
          <FlowsView />
        ) : view.kind === "mcp" ? (
          <McpView />
        ) : (
          <CollectionsView />
        )}
      </main>
      {removing && <RemoveNetwork network={removing} onClose={() => setRemoving(null)} />}
      {exporting && <ExportNetwork network={exporting} onClose={() => setExporting(null)} />}
      {importing && (
        <ImportNetwork
          into={importing.into}
          onClose={() => setImporting(null)}
          onImported={async (name) => {
            setImporting(null);
            await refresh();
            setView({ kind: "network", name });
          }}
        />
      )}
    </div>
  );
}
