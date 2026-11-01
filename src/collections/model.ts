/** The API workspace: groups that nest, holding HTTP requests, WebSocket and
 *  Socket.IO connections. Each item has a name and labels. Saved as one JSON
 *  document; shape changes bump `version`. */

export type KV = { id: string; key: string; value: string; enabled: boolean };

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof METHODS)[number];

type Base = { id: string; name: string; labels: string[] };

export type HttpItem = Base & {
  type: "http";
  method: HttpMethod;
  url: string;
  headers: KV[];
  bodyType: "none" | "json" | "text";
  body: string;
};

export type WsItem = Base & {
  type: "ws";
  url: string;
  /** Comma-separated subprotocols */
  protocols: string;
  draft: string;
};

export type IoItem = Base & {
  type: "socketio";
  url: string;
  path: string;
  /** JSON sent as the handshake `auth` */
  auth: string;
  /** Events to show in the log; empty shows every event */
  listen: string[];
  event: string;
  draft: string;
};

export type Item = HttpItem | WsItem | IoItem;
export type ItemType = Item["type"];

export type Group = { id: string; type: "group"; name: string; collapsed?: boolean; children: TreeNode[] };
export type TreeNode = Group | Item;

export type Workspace = {
  version: 1;
  /** Label name → dot color */
  labels: Record<string, string>;
  tree: TreeNode[];
};

export const LABEL_COLORS = ["#e5484d", "#12a594", "#e39b2d", "#2f66e8", "#8e4ec6", "#d6409f", "#0f8b85", "#c27c00"];

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const kv = (key = "", value = ""): KV => ({ id: uid(), key, value, enabled: true });

export function newItem(type: ItemType | "group"): TreeNode {
  const base = { id: uid(), labels: [] as string[] };
  switch (type) {
    case "group":
      return { id: uid(), type: "group", name: "", children: [] };
    case "http":
      return { ...base, type: "http", name: "", method: "GET", url: "", headers: [], bodyType: "none", body: "" };
    case "ws":
      return { ...base, type: "ws", name: "", url: "", protocols: "", draft: "" };
    case "socketio":
      return { ...base, type: "socketio", name: "", url: "", path: "/socket.io", auth: "", listen: [], event: "message", draft: "" };
  }
}

export function sampleWorkspace(): Workspace {
  const realtime: Group = {
    id: uid(),
    type: "group",
    name: "Realtime",
    children: [
      { ...(newItem("ws") as WsItem), name: "Echo socket", url: "wss://echo.websocket.org", labels: ["realtime"] },
    ],
  };
  return {
    version: 1,
    labels: { smoke: LABEL_COLORS[0], realtime: LABEL_COLORS[1] },
    tree: [
      {
        id: uid(),
        type: "group",
        name: "Examples",
        children: [
          {
            ...(newItem("http") as HttpItem),
            name: "Get JSON",
            url: "https://httpbin.org/get",
            labels: ["smoke"],
          },
          {
            ...(newItem("http") as HttpItem),
            name: "Post JSON",
            method: "POST",
            url: "https://httpbin.org/post",
            headers: [kv("Content-Type", "application/json")],
            bodyType: "json",
            body: '{\n  "hello": "uat"\n}',
          },
          realtime,
        ],
      },
    ],
  };
}

// ---- Tree operations (immutable) ----

export function find(tree: TreeNode[], id: string): TreeNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.type === "group") {
      const hit = find(n.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** The groups from the root down to `id`'s parent. */
export function ancestors(tree: TreeNode[], id: string, trail: Group[] = []): Group[] | null {
  for (const n of tree) {
    if (n.id === id) return trail;
    if (n.type === "group") {
      const hit = ancestors(n.children, id, [...trail, n]);
      if (hit) return hit;
    }
  }
  return null;
}

export function update(tree: TreeNode[], id: string, fn: (n: TreeNode) => TreeNode): TreeNode[] {
  return tree.map((n) => {
    if (n.id === id) return fn(n);
    if (n.type === "group") return { ...n, children: update(n.children, id, fn) };
    return n;
  });
}

export function remove(tree: TreeNode[], id: string): TreeNode[] {
  return tree
    .filter((n) => n.id !== id)
    .map((n) => (n.type === "group" ? { ...n, children: remove(n.children, id) } : n));
}

/** Adds `node` to the group `parentId` (or the root when null), after `afterId` when given. */
export function insert(tree: TreeNode[], parentId: string | null, node: TreeNode, afterId?: string): TreeNode[] {
  const place = (list: TreeNode[]) => {
    const i = afterId ? list.findIndex((n) => n.id === afterId) : -1;
    return i < 0 ? [...list, node] : [...list.slice(0, i + 1), node, ...list.slice(i + 1)];
  };
  if (parentId === null) return place(tree);
  return update(tree, parentId, (g) => (g.type === "group" ? { ...g, collapsed: false, children: place(g.children) } : g));
}

/** A deep copy with fresh ids. */
export function clone<T extends TreeNode>(node: T): T {
  if (node.type === "group") return { ...node, id: uid(), children: node.children.map(clone) };
  return { ...structuredClone(node), id: uid() };
}

export function countItems(node: TreeNode): number {
  return node.type === "group" ? node.children.reduce((s, c) => s + countItems(c), 0) : 1;
}

/** Keeps items whose name or labels match, and the groups on their way. */
export function filterTree(tree: TreeNode[], query: string): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return tree;
  const match = (n: TreeNode) =>
    n.name.toLowerCase().includes(q) ||
    (n.type !== "group" && (n.labels.some((l) => l.toLowerCase().includes(q)) || n.url.toLowerCase().includes(q)));
  return tree.flatMap((n): TreeNode[] => {
    if (n.type !== "group") return match(n) ? [n] : [];
    if (match(n)) return [{ ...n, collapsed: false }];
    const children = filterTree(n.children, q);
    return children.length ? [{ ...n, collapsed: false, children }] : [];
  });
}

export const METHOD_WORD: Record<ItemType, string> = { http: "", ws: "WS", socketio: "IO" };

export function methodWord(item: Item): string {
  return item.type === "http" ? item.method : METHOD_WORD[item.type];
}

export function displayName(n: TreeNode): string {
  if (n.name.trim()) return n.name;
  if (n.type === "group") return "Untitled group";
  return n.url.trim() || "Untitled";
}
