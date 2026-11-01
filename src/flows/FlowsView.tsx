import { useRef, useState } from "react";
import { CircleAlert, Copy, Ellipsis, Plus, Trash, Waypoints, Workflow } from "lucide-react";
import { Empty, ICON, Menu, Spinner, type MenuEntry } from "../ui";
import { message } from "../lib/tauri";
import { uid } from "../collections/model";
import { demoApi } from "../collections/demo";
import { changeFlows, forgetRun, useFlows, useRun } from "./store";
import { DEMO_FLOW_ID, withDemoFlow } from "./demo";
import { flowName, newFlow, type Flow } from "./model";
import { FlowEditor } from "./FlowEditor";
import { menuAt, type MenuAt } from "./menu";
import "./flows.css";

// The open flow, kept while another section is open
let remembered: string | null = null;

export function FlowsView() {
  const { doc, error } = useFlows();
  const [selected, setSelected] = useState<string | null>(remembered);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<MenuAt>(null);
  const [demo, setDemo] = useState<{ busy: string | null; error: string | null }>({ busy: null, error: null });
  const [undo, setUndo] = useState<{ label: string; flows: Flow[] } | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const select = (id: string | null) => {
    remembered = id;
    setSelected(id);
  };

  if (!doc) {
    return (
      <section className="fl">
        <header className="toolbar" data-tauri-drag-region />
        {error && (
          <Empty icon={CircleAlert} title="Couldn't open the flows">
            {error}
          </Empty>
        )}
      </section>
    );
  }

  const flow = doc.flows.find((f) => f.id === selected) ?? doc.flows[0] ?? null;

  const add = () => {
    const f = newFlow();
    changeFlows((d) => ({ ...d, flows: [...d.flows, f] }));
    select(f.id);
  };

  const duplicate = (f: Flow) => {
    const copy: Flow = {
      ...structuredClone(f),
      id: uid(),
      name: f.name ? `${f.name} copy` : "",
      steps: f.steps.map((s) => ({ ...structuredClone(s), id: uid() })),
    };
    changeFlows((d) => {
      const i = d.flows.findIndex((x) => x.id === f.id);
      return { ...d, flows: [...d.flows.slice(0, i + 1), copy, ...d.flows.slice(i + 1)] };
    });
    select(copy.id);
  };

  const remove = (f: Flow) => {
    const before = doc.flows;
    const i = before.findIndex((x) => x.id === f.id);
    changeFlows((d) => ({ ...d, flows: d.flows.filter((x) => x.id !== f.id) }));
    forgetRun(f.id);
    select((before[i + 1] ?? before[i - 1])?.id ?? null);
    clearTimeout(undoTimer.current);
    setUndo({ label: `Deleted ${flowName(f)}`, flows: before });
    undoTimer.current = setTimeout(() => setUndo(null), 6000);
  };

  // Sets up the demo network (the trace demo's), then adds the demo flow or points it there again
  const startDemo = async () => {
    if (demo.busy) return;
    setDemo({ busy: "Setting up the demo network", error: null });
    const unlisten = await demoApi.onProgress((line) => setDemo((d) => (d.busy ? { ...d, busy: line } : d)));
    try {
      const { port } = await demoApi.start();
      changeFlows((d) => withDemoFlow(d, port));
      select(DEMO_FLOW_ID);
      setDemo({ busy: null, error: null });
    } catch (e) {
      setDemo({ busy: null, error: message(e) });
    } finally {
      unlisten();
    }
  };

  const menuFlow = menu && doc.flows.find((f) => f.id === menu.id);
  const menuEntries: MenuEntry[] = menuFlow
    ? [
        { label: "Duplicate", icon: Copy, onSelect: () => duplicate(menuFlow) },
        "separator",
        { label: "Delete", icon: Trash, danger: true, onSelect: () => remove(menuFlow) },
      ]
    : [];

  return (
    <section className="fl">
      <header className="toolbar" data-tauri-drag-region>
        <div className="crumbs" data-tauri-drag-region>
          <Workflow {...ICON} className="icon crumbs__icon" />
          <span className="crumbs__name">Flows</span>
        </div>
        <div className="toolbar__actions">
          {error && (
            <span className="cl__save-error" title={error}>
              <CircleAlert size={14} strokeWidth={1.5} className="icon" />
              Not saved
            </span>
          )}
          <button ref={addRef} className="btn-primary" data-open={adding || undefined} onClick={() => setAdding((a) => !a)}>
            <Plus {...ICON} />
            New
          </button>
        </div>
        {adding && (
          <Menu
            entries={[
              { label: "Flow", icon: Workflow, onSelect: add },
              "separator",
              { label: "Flow demo", icon: Waypoints, onSelect: startDemo },
            ]}
            anchor={addRef}
            onClose={() => setAdding(false)}
            style={{ top: 46, right: 14 }}
          />
        )}
      </header>

      <div className="fl__body">
        <nav className="flist">
          {doc.flows.length === 0 && <div className="flist__none">No flows yet</div>}
          {doc.flows.map((f) => (
            <FlowRow
              key={f.id}
              flow={f}
              active={f.id === flow?.id}
              menuOpen={menu?.id === f.id}
              onSelect={() => select(f.id)}
              onMenu={(e) => setMenu(menuAt(e, f.id))}
            />
          ))}
        </nav>
        <div className="fl__main">
          {flow ? (
            <FlowEditor key={flow.id} flow={flow} />
          ) : (
            <Empty
              icon={Workflow}
              title="No flows yet"
              actions={
                <>
                  <button className="btn" onClick={add}>
                    <Plus {...ICON} />
                    New flow
                  </button>
                  <button className="btn" disabled={!!demo.busy} onClick={startDemo}>
                    <Waypoints {...ICON} />
                    Try the flow demo
                  </button>
                </>
              }
            >
              A flow calls APIs in order, each able to use what the earlier ones answered. Steps can reshape the data
              and write it to a sheet, and each keeps its own log.
            </Empty>
          )}
        </div>
      </div>

      {menu && menuFlow && (
        <Menu
          entries={menuEntries}
          anchor={{ current: menu.anchor }}
          onClose={() => setMenu(null)}
          style={{ position: "fixed", top: menu.top, bottom: menu.bottom, left: menu.left }}
        />
      )}

      {demo.busy ? (
        <div className="cl__toast cl__toast--busy">
          <Spinner />
          <span>{demo.busy}</span>
        </div>
      ) : demo.error ? (
        <div className="cl__toast" data-tone="bad">
          <span className="cl__toast-text" title={demo.error}>
            Couldn't set up the demo: {demo.error}
          </span>
          <button onClick={() => setDemo({ busy: null, error: null })}>Dismiss</button>
        </div>
      ) : (
        undo && (
          <div className="cl__toast">
            <span>{undo.label}</span>
            <button
              onClick={() => {
                changeFlows((d) => ({ ...d, flows: undo.flows }));
                setUndo(null);
              }}
            >
              Undo
            </button>
          </div>
        )
      )}
    </section>
  );
}

function FlowRow({
  flow,
  active,
  menuOpen,
  onSelect,
  onMenu,
}: {
  flow: Flow;
  active: boolean;
  menuOpen: boolean;
  onSelect: () => void;
  onMenu: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  const run = useRun(flow.id);
  const tone = !run ? null : run.status === "running" ? "busy" : run.status === "ok" ? "ok" : "bad";
  return (
    <div
      className="flist__row"
      role="button"
      tabIndex={0}
      data-active={active || undefined}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
    >
      {tone === "busy" ? <Spinner size={12} /> : <span className="flist__dot" data-tone={tone ?? undefined} />}
      <span className="flist__name">{flowName(flow)}</span>
      <span className="flist__count">{flow.steps.length}</span>
      <button className="icon-btn flist__more" data-open={menuOpen || undefined} title="More" onClick={onMenu}>
        <Ellipsis size={14} strokeWidth={1.75} className="icon" />
      </button>
    </div>
  );
}
