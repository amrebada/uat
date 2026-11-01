import { useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { ICON } from "../ui";
import { ADD_ENTRIES } from "./Tree";
import { HttpEditor } from "./HttpEditor";
import { SocketEditor } from "./SocketEditor";
import { countItems, LABEL_COLORS, type Group, type Item, type ItemType, type TreeNode, type Workspace } from "./model";

export function Editor({
  ws,
  node,
  crumbs,
  onChange,
  onAddLabel,
  onAdd,
}: {
  ws: Workspace;
  node: TreeNode;
  crumbs: Group[];
  onChange: (fn: (n: TreeNode) => TreeNode) => void;
  onAddLabel: (name: string, color: string) => void;
  onAdd: (parentId: string, type: ItemType | "group") => void;
}) {
  return (
    <div className="ed">
      <div className="ed__head">
        <div className="ed__crumb">
          {crumbs.length ? crumbs.map((g) => g.name || "Untitled group").join("  ›  ") : "Collections"}
        </div>
        <input
          className="ed__title"
          value={node.name}
          placeholder={node.type === "group" ? "Untitled group" : "Untitled"}
          onChange={(e) => {
            const name = e.target.value;
            onChange((n) => ({ ...n, name }));
          }}
        />
        {node.type !== "group" && (
          <Labels
            ws={ws}
            labels={node.labels}
            onChange={(labels) => onChange((n) => ({ ...n, labels }))}
            onAddLabel={onAddLabel}
          />
        )}
      </div>
      {node.type === "group" ? (
        <GroupOverview group={node} onAdd={(t) => onAdd(node.id, t)} />
      ) : node.type === "http" ? (
        <HttpEditor key={node.id} item={node} onChange={onChange as (fn: (n: Item) => Item) => void} />
      ) : (
        <SocketEditor key={node.id} item={node} onChange={onChange as (fn: (n: Item) => Item) => void} />
      )}
    </div>
  );
}

function Labels({
  ws,
  labels,
  onChange,
  onAddLabel,
}: {
  ws: Workspace;
  labels: string[];
  onChange: (labels: string[]) => void;
  onAddLabel: (name: string, color: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const known = Object.keys(ws.labels).filter((l) => !labels.includes(l));

  const commit = () => {
    const name = value.trim().toLowerCase();
    setValue("");
    setAdding(false);
    if (!name || labels.includes(name)) return;
    if (!ws.labels[name]) onAddLabel(name, LABEL_COLORS[Object.keys(ws.labels).length % LABEL_COLORS.length]);
    onChange([...labels, name]);
  };

  return (
    <div className="ed__labels">
      {labels.map((l) => (
        <span key={l} className="label ed__label" style={{ "--dot": ws.labels[l] } as CSSProperties}>
          <span className="label__dot" />
          {l}
          <button className="ed__label-x" title={`Remove ${l}`} onClick={() => onChange(labels.filter((x) => x !== l))}>
            <X size={11} strokeWidth={2} className="icon" />
          </button>
        </span>
      ))}
      {adding ? (
        <span className="label ed__label-field">
          <span className="label__dot" />
          <input
            autoFocus
            list="uat-labels"
            value={value}
            placeholder="label"
            size={Math.max(5, value.length + 1)}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setValue("");
                setAdding(false);
              }
            }}
            onBlur={commit}
          />
          <datalist id="uat-labels">
            {known.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </span>
      ) : (
        <button className="label ed__label-add" onClick={() => setAdding(true)}>
          <span className="label__dot" />
          Add label…
        </button>
      )}
    </div>
  );
}

function GroupOverview({ group, onAdd }: { group: Group; onAdd: (t: ItemType | "group") => void }) {
  const items = countItems(group);
  const subgroups = group.children.filter((c) => c.type === "group").length;
  const entries = ADD_ENTRIES(onAdd).flatMap((e) => (e === "separator" ? [] : [e]));
  return (
    <div className="ed__group">
      <div className="ed__group-meta">
        {items} {items === 1 ? "item" : "items"}
        {subgroups > 0 && ` · ${subgroups} ${subgroups === 1 ? "sub-group" : "sub-groups"}`}
      </div>
      <div className="ed__group-add">
        {entries.map((e) => (
          <button key={e.label} className="btn" onClick={e.onSelect}>
            {e.icon && <e.icon {...ICON} />}
            {e.label}
          </button>
        ))}
      </div>
    </div>
  );
}
