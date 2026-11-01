import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, FolderPlus, Layers, Plus, Waypoints } from "lucide-react";
import { Empty, ICON, Menu, Spinner } from "../ui";
import { message } from "../lib/tauri";
import { useWorkspace } from "./store";
import { ADD_ENTRIES, Tree, type TreeActions } from "./Tree";
import { Editor } from "./Editor";
import { forget } from "./live";
import { DEMO_GROUP_ID, DemoContext, demoApi, demoGroup, repoint, withDemo, type DemoState } from "./demo";
import {
  ancestors,
  clone,
  countItems,
  displayName,
  find,
  insert,
  newItem,
  remove,
  update,
  type TreeNode,
  type Workspace,
} from "./model";
import "./collections.css";

type Undo = { label: string; tree: Workspace["tree"] };

function ids(node: TreeNode): string[] {
  return node.type === "group" ? [node.id, ...node.children.flatMap(ids)] : [node.id];
}

export function CollectionsView() {
  const { ws, change, error } = useWorkspace();
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [demo, setDemo] = useState<{ busy: string | null; error: string | null }>({ busy: null, error: null });

  const node = ws && selected ? find(ws.tree, selected) : null;
  const crumbs = useMemo(() => (ws && selected ? (ancestors(ws.tree, selected) ?? []) : []), [ws, selected]);

  // Open on the first request the first time
  useEffect(() => {
    if (!ws || selected) return;
    const first = (list: TreeNode[]): TreeNode | null => {
      for (const n of list) {
        if (n.type !== "group") return n;
        const hit = first(n.children);
        if (hit) return hit;
      }
      return null;
    };
    setSelected(first(ws.tree)?.id ?? ws.tree[0]?.id ?? null);
  }, [ws, selected]);

  const actions: TreeActions = useMemo(
    () => ({
      select: setSelected,
      toggle: (id) =>
        change((w) => ({
          ...w,
          tree: update(w.tree, id, (n) => (n.type === "group" ? { ...n, collapsed: !n.collapsed } : n)),
        })),
      add: (parentId, type) => {
        const n = newItem(type);
        change((w) => ({ ...w, tree: insert(w.tree, parentId, n) }));
        setSelected(n.id);
        setRenaming(n.id);
      },
      rename: (id, name) => change((w) => ({ ...w, tree: update(w.tree, id, (n) => ({ ...n, name })) })),
      duplicate: (id) => {
        if (!ws) return;
        const src = find(ws.tree, id);
        if (!src) return;
        const copy = clone(src);
        copy.name = src.name ? `${src.name} copy` : "";
        const parent = ancestors(ws.tree, id)?.at(-1)?.id ?? null;
        change((w) => ({ ...w, tree: insert(w.tree, parent, copy, id) }));
        setSelected(copy.id);
      },
      remove: (id) => {
        if (!ws) return;
        const target = find(ws.tree, id);
        if (!target) return;
        const before = ws.tree;
        // Keep the selection nearby: the next sibling, else the parent
        const parent = ancestors(ws.tree, id)?.at(-1);
        const siblings = parent ? parent.children : ws.tree;
        const i = siblings.findIndex((n) => n.id === id);
        const next = siblings[i + 1] ?? siblings[i - 1] ?? parent ?? null;
        change((w) => ({ ...w, tree: remove(w.tree, id) }));
        setSelected(next?.id ?? null);
        forget(ids(target));
        const count = countItems(target);
        clearTimeout(undoTimer.current);
        setUndo({
          label:
            target.type === "group"
              ? `Deleted ${displayName(target)}${count ? ` and ${count} ${count === 1 ? "item" : "items"}` : ""}`
              : `Deleted ${displayName(target)}`,
          tree: before,
        });
        undoTimer.current = setTimeout(() => setUndo(null), 6000);
      },
    }),
    [ws, change],
  );

  // Sets the demo network up, then adds its group, or points the group at it again
  const startDemo = useCallback(async () => {
    if (demo.busy) return;
    setDemo({ busy: "Setting up the trace demo", error: null });
    const unlisten = await demoApi.onProgress((line) => setDemo((d) => (d.busy ? { ...d, busy: line } : d)));
    try {
      const { port } = await demoApi.start();
      const group = (ws && find(ws.tree, DEMO_GROUP_ID)) ?? demoGroup(port);
      const moved = repoint(group, port) as typeof group;
      change((w) => withDemo(w, port));
      const inside = selected !== null && (selected === DEMO_GROUP_ID || find([moved], selected) !== null);
      const first = moved.type === "group" ? moved.children[0] : null;
      if (!inside && first) setSelected(first.id);
      setDemo({ busy: null, error: null });
    } catch (e) {
      setDemo({ busy: null, error: message(e) });
    } finally {
      unlisten();
    }
  }, [demo.busy, ws, selected, change]);

  const demoState: DemoState = useMemo(() => ({ ...demo, start: startDemo }), [demo, startDemo]);

  const restore = useCallback(() => {
    if (!undo) return;
    change((w) => ({ ...w, tree: undo.tree }));
    setUndo(null);
  }, [undo, change]);

  // ⌘Z restores the last delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (undo && e.key === "z" && (e.metaKey || e.ctrlKey) && !(e.target as HTMLElement).closest("input, textarea")) {
        e.preventDefault();
        restore();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, restore]);

  // New items go next to the selection: into the selected group, or the selected item's group
  const addTarget = !ws || !selected ? null : node?.type === "group" ? node.id : (crumbs.at(-1)?.id ?? null);

  if (!ws) {
    return (
      <section className="cl">
        <header className="toolbar" data-tauri-drag-region />
        {error ? (
          <Empty icon={CircleAlert} title="Couldn't open the workspace">
            {error}
          </Empty>
        ) : null}
      </section>
    );
  }

  return (
    <section className="cl">
      <header className="toolbar" data-tauri-drag-region>
        <div className="crumbs" data-tauri-drag-region>
          <Layers {...ICON} className="icon crumbs__icon" />
          <span className="crumbs__name">Collections</span>
        </div>
        <div className="toolbar__actions">
          {error && (
            <span className="cl__save-error" title={error}>
              <CircleAlert size={14} strokeWidth={1.5} className="icon" />
              Not saved
            </span>
          )}
          <button
            ref={addRef}
            className="btn-primary"
            data-open={adding || undefined}
            onClick={() => (addTarget ? setAdding((a) => !a) : actions.add(null, "group"))}
          >
            <Plus {...ICON} />
            {addTarget ? "New" : "New group"}
          </button>
        </div>
        {adding && addTarget && (
          <Menu
            entries={[
              ...ADD_ENTRIES((t) => actions.add(addTarget, t)),
              "separator",
              { label: "Trace demo", icon: Waypoints, onSelect: startDemo },
            ]}
            anchor={addRef}
            onClose={() => setAdding(false)}
            style={{ top: 46, right: 14 }}
          />
        )}
      </header>
      <DemoContext.Provider value={demoState}>
        <div className="cl__body">
          <Tree ws={ws} selected={selected} renaming={renaming} setRenaming={setRenaming} actions={actions} />
          <div className="cl__editor">
            {node ? (
              <Editor
                key={node.id}
                ws={ws}
                node={node}
                crumbs={crumbs}
                onChange={(fn) =>
                  change((w) => ({ ...w, tree: update(w.tree, node.id, fn as (n: TreeNode) => TreeNode) }))
                }
                onAddLabel={(name, color) => change((w) => ({ ...w, labels: { ...w.labels, [name]: color } }))}
                onAdd={actions.add}
              />
            ) : (
              <Empty
                icon={FolderPlus}
                title="Nothing selected"
                actions={
                  <>
                    <button className="btn" onClick={() => actions.add(null, "group")}>
                      <FolderPlus {...ICON} />
                      New group
                    </button>
                    <button className="btn" disabled={!!demo.busy} onClick={startDemo}>
                      <Waypoints {...ICON} />
                      Try the trace demo
                    </button>
                  </>
                }
              >
                Groups hold HTTP requests, WebSockets and Socket.IO connections, and sub-groups inside them.
              </Empty>
            )}
          </div>
        </div>
      </DemoContext.Provider>
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
            <button onClick={restore}>Undo</button>
          </div>
        )
      )}
    </section>
  );
}
