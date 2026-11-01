import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ChevronRight,
  Copy,
  Ellipsis,
  Folder,
  FolderPlus,
  Globe,
  PencilLine,
  Plug,
  Plus,
  Radio,
  Search,
  Trash,
} from "lucide-react";
import { ICON, Menu, type MenuEntry } from "../ui";
import { displayName, filterTree, methodWord, type ItemType, type TreeNode, type Workspace } from "./model";
import { useOpenIds } from "./live";

export type TreeActions = {
  select: (id: string) => void;
  toggle: (id: string) => void;
  add: (parentId: string | null, type: ItemType | "group") => void;
  rename: (id: string, name: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
};

type MenuState = { id: string; kind: "add" | "more"; top: number; left: number } | null;

const SHORT: Record<string, string> = { DELETE: "DEL", OPTIONS: "OPT" };

export const ADD_ENTRIES = (onPick: (t: ItemType | "group") => void): MenuEntry[] => [
  { label: "HTTP request", icon: Globe, onSelect: () => onPick("http") },
  { label: "WebSocket", icon: Plug, onSelect: () => onPick("ws") },
  { label: "Socket.IO", icon: Radio, onSelect: () => onPick("socketio") },
  "separator",
  { label: "Sub-group", icon: FolderPlus, onSelect: () => onPick("group") },
];

export function Tree({
  ws,
  selected,
  renaming,
  setRenaming,
  actions,
}: {
  ws: Workspace;
  selected: string | null;
  renaming: string | null;
  setRenaming: (id: string | null) => void;
  actions: TreeActions;
}) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuState>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const open = useOpenIds();

  const nodes = useMemo(() => filterTree(ws.tree, query), [ws.tree, query]);

  // The rows in screen order, for arrow keys
  const visible = useMemo(() => {
    const out: TreeNode[] = [];
    const walk = (list: TreeNode[]) =>
      list.forEach((n) => {
        out.push(n);
        if (n.type === "group" && !n.collapsed) walk(n.children);
      });
    walk(nodes);
    return out;
  }, [nodes]);

  useEffect(() => {
    if (!selected) return;
    rowsRef.current?.querySelector(`[data-id="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const openMenu = (e: React.MouseEvent<HTMLElement>, id: string, kind: "add" | "more") => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    menuAnchor.current = e.currentTarget;
    setMenu({ id, kind, top: r.bottom + 4, left: Math.min(r.left, window.innerWidth - 200) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (renaming || (e.target as HTMLElement).tagName === "INPUT") return;
    const i = visible.findIndex((n) => n.id === selected);
    const cur = visible[i];
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) actions.select(next.id);
        break;
      }
      case "ArrowRight":
      case "ArrowLeft":
        if (cur?.type === "group" && !!cur.collapsed === (e.key === "ArrowRight")) actions.toggle(cur.id);
        break;
      case "Enter":
        if (cur) {
          e.preventDefault();
          setRenaming(cur.id);
        }
        break;
      case "Backspace":
      case "Delete":
        if (cur) actions.remove(cur.id);
        break;
    }
  };

  const row = (n: TreeNode, depth: number) => {
    const isGroup = n.type === "group";
    const word = isGroup ? "" : methodWord(n);
    return (
      <div key={n.id}>
        <div
          className="row"
          role="treeitem"
          aria-selected={selected === n.id}
          aria-expanded={isGroup ? !n.collapsed : undefined}
          data-id={n.id}
          data-selected={selected === n.id || undefined}
          data-menu={menu?.id === n.id || undefined}
          onClick={() => {
            actions.select(n.id);
            rowsRef.current?.focus();
          }}
          onDoubleClick={() => setRenaming(n.id)}
        >
          {Array.from({ length: depth }, (_, i) => (
            <span key={i} className="row__indent" />
          ))}
          {isGroup ? (
            <>
              <button
                className="row__chev"
                tabIndex={-1}
                aria-label={n.collapsed ? "Expand" : "Collapse"}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.toggle(n.id);
                }}
              >
                <ChevronRight size={14} strokeWidth={1.75} className="icon" data-open={!n.collapsed || undefined} />
              </button>
              <Folder {...ICON} className="icon row__folder" />
            </>
          ) : (
            <span className="method" data-m={word}>
              {SHORT[word] ?? word}
            </span>
          )}
          {renaming === n.id ? (
            <RenameInput
              initial={n.name}
              placeholder={isGroup ? "Group name" : "Name"}
              onDone={(name) => {
                setRenaming(null);
                if (name !== null) actions.rename(n.id, name);
                rowsRef.current?.focus();
              }}
            />
          ) : (
            <span className="row__name" data-group={isGroup || undefined} data-untitled={!n.name.trim() || undefined}>
              {displayName(n)}
            </span>
          )}
          {!isGroup && open.has(n.id) && <span className="dot" data-state="open" title="Connected" />}
          <span className="row__end">
            {!isGroup &&
              n.labels.slice(0, 2).map((l) => (
                <span key={l} className="row__label" title={l} style={{ "--dot": ws.labels[l] } as CSSProperties}>
                  <span className="label__dot" />
                  {l}
                </span>
              ))}
            {!isGroup && n.labels.length > 2 && <span className="row__more">+{n.labels.length - 2}</span>}
            <span className="row__actions">
              {isGroup && (
                <button
                  className="icon-btn row__btn"
                  tabIndex={-1}
                  title="Add to group"
                  data-open={(menu?.id === n.id && menu.kind === "add") || undefined}
                  onClick={(e) => openMenu(e, n.id, "add")}
                >
                  <Plus size={14} strokeWidth={1.75} className="icon" />
                </button>
              )}
              <button
                className="icon-btn row__btn"
                tabIndex={-1}
                title="More"
                data-open={(menu?.id === n.id && menu.kind === "more") || undefined}
                onClick={(e) => openMenu(e, n.id, "more")}
              >
                <Ellipsis size={14} strokeWidth={1.75} className="icon" />
              </button>
            </span>
          </span>
        </div>
        {isGroup && !n.collapsed && (
          <div role="group">
            {n.children.map((c) => row(c, depth + 1))}
            {n.children.length === 0 && (
              <div className="row row--empty">
                {Array.from({ length: depth + 1 }, (_, i) => (
                  <span key={i} className="row__indent" />
                ))}
                <span>Empty. Use + to add a request.</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const menuEntries = (m: NonNullable<MenuState>): MenuEntry[] =>
    m.kind === "add"
      ? ADD_ENTRIES((t) => actions.add(m.id, t))
      : [
          { label: "Rename", icon: PencilLine, onSelect: () => setRenaming(m.id) },
          { label: "Duplicate", icon: Copy, onSelect: () => actions.duplicate(m.id) },
          "separator",
          { label: "Delete", icon: Trash, danger: true, onSelect: () => actions.remove(m.id) },
        ];

  return (
    <div className="ctree">
      <div className="tree__head">
        <label className="tree__search">
          <Search size={14} strokeWidth={1.5} className="icon" />
          <input placeholder="Filter by name, label or URL" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button className="icon-btn" title="New group" onClick={() => actions.add(null, "group")}>
          <FolderPlus {...ICON} />
        </button>
      </div>
      <div ref={rowsRef} className="tree__rows" role="tree" tabIndex={0} onKeyDown={onKeyDown}>
        {nodes.map((n) => row(n, 0))}
        {nodes.length === 0 && (
          <div className="tree__none">{query ? `Nothing matches "${query}"` : "No groups yet"}</div>
        )}
      </div>
      {menu && (
        <Menu
          entries={menuEntries(menu)}
          anchor={menuAnchor}
          onClose={() => setMenu(null)}
          style={{ position: "fixed", top: menu.top, left: menu.left }}
        />
      )}
    </div>
  );
}

function RenameInput({
  initial,
  placeholder,
  onDone,
}: {
  initial: string;
  placeholder: string;
  onDone: (name: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="row__rename"
      autoFocus
      value={value}
      placeholder={placeholder}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value.trim());
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value.trim())}
    />
  );
}

