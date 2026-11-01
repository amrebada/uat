/** The trace demo: a small network the app sets up on `uat-demo`, and a
 *  group of requests to it. Listing rides lights up blue all the way;
 *  booking one goes red at `payments`, which isn't there. */
import { createContext, useContext } from "react";
import { listen } from "@tauri-apps/api/event";
import { Waypoints } from "lucide-react";
import { ICON, Spinner } from "../ui";
import { call, inTauri } from "../lib/tauri";
import { find, kv, LABEL_COLORS, newItem, update, type Group, type HttpItem, type HttpMethod, type TreeNode, type Workspace } from "./model";

export const DEMO_GROUP_ID = "trace-demo";
export const DEMO_LABEL = "demo";

export type Demo = { network: string; port: number };

export const demoApi = {
  start: () => (inTauri ? call<Demo>("demo_start") : Promise.resolve({ network: "uat-demo", port: 8480 })),
  /** What it's doing, while it sets up */
  onProgress: (cb: (line: string) => void) =>
    inTauri ? listen<string>("demo://progress", (e) => cb(e.payload)) : Promise.resolve(() => {}),
};

export function demoGroup(port: number): Group {
  const request = (name: string, method: HttpMethod, path: string, body?: string): HttpItem => ({
    ...(newItem("http") as HttpItem),
    name,
    method,
    url: `http://localhost:${port}${path}`,
    labels: [DEMO_LABEL],
    ...(body && { headers: [kv("Content-Type", "application/json")], bodyType: "json" as const, body }),
  });
  return {
    id: DEMO_GROUP_ID,
    type: "group",
    name: "Trace demo",
    children: [
      request("List rides", "GET", "/rides"),
      request("Book a ride", "POST", "/rides", '{\n  "from": "Maarif",\n  "to": "Anfa"\n}'),
      request("Get a rider", "GET", "/users/7"),
      request("Health check", "GET", "/health"),
    ],
  };
}

/** The demo's requests, pointed at the gateway's port now; edits kept. */
export function repoint(node: TreeNode, port: number): TreeNode {
  if (node.type === "group") return { ...node, collapsed: false, children: node.children.map((c) => repoint(c, port)) };
  return { ...node, url: node.url.replace(/\/\/localhost:\d+/, `//localhost:${port}`) };
}

/** `w` with the demo's group, pointed at `port`: added first, or updated where it is */
export function withDemo(w: Workspace, port: number): Workspace {
  const moved = repoint(find(w.tree, DEMO_GROUP_ID) ?? demoGroup(port), port);
  return {
    ...w,
    labels: w.labels[DEMO_LABEL] ? w.labels : { ...w.labels, [DEMO_LABEL]: LABEL_COLORS[3] },
    tree: find(w.tree, DEMO_GROUP_ID) ? update(w.tree, DEMO_GROUP_ID, () => moved) : [moved, ...w.tree],
  };
}

export type DemoState = { busy: string | null; error: string | null; start: () => void };

export const DemoContext = createContext<DemoState | null>(null);

/** Offered where a trace has nothing to show. */
export function TryDemo() {
  const demo = useContext(DemoContext);
  if (!demo) return null;
  return (
    <button className="btn" disabled={!!demo.busy} onClick={demo.start}>
      {demo.busy ? <Spinner /> : <Waypoints {...ICON} />}
      {demo.busy ? "Setting up the demo…" : "Try the trace demo"}
    </button>
  );
}
