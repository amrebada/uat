/** Flows in the app: kept on disk by Rust, requests sent through it (no
 *  CORS, any host) and traced like Collections' calls, sheets and reports
 *  written by it. */
import { documentDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { call, inTauri, message } from "../lib/tauri";
import { beginTrace, traceState } from "../trace/api";
import type { Cell, Deps, FlowRun } from "./engine";
import type { FlowsDoc } from "./model";
import { report, reportFile, type ReportFormat } from "./report";

const LOCAL_KEY = "uat.flows";

export const flowsApi = {
  load: async (): Promise<FlowsDoc | null> => {
    if (inTauri) return call<FlowsDoc | null>("flows_load");
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      return raw ? (JSON.parse(raw) as FlowsDoc) : null;
    } catch {
      return null;
    }
  },
  save: async (doc: FlowsDoc) => {
    if (inTauri) return call<void>("flows_save", { flows: doc });
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(doc));
    } catch {
      // Browser preview only
    }
  },
  writeSheet: (sheet: { path: string; columns: string[]; rows: Cell[][] }) =>
    inTauri ? call<string>("flow_write_sheet", { sheet }) : Promise.resolve(sheet.path.replace(/^~/, "/Users/you")),
  /** Opens the file, or shows it in Finder */
  open: (path: string, reveal: boolean) => (inTauri ? call<void>("flow_open", { path, reveal }) : Promise.resolve()),
};

/** The trace of one step's call */
export const traceKey = (flowId: string, stepId: string) => `flow:${flowId}:${stepId}`;

const REPORT_FILTER: Record<ReportFormat, { name: string; extensions: string[] }> = {
  html: { name: "HTML report", extensions: ["html"] },
  md: { name: "Markdown", extensions: ["md"] },
};

/** Saves a report of `run` where the person chooses, `~/Documents/UAT` to
 *  start with. Returns where it went, or null if they cancelled. In a plain
 *  browser, downloads it. */
export async function exportReport(run: FlowRun, format: ReportFormat, secrets: boolean): Promise<string | null> {
  const text = report(run, format, { secrets, trace: (stepId) => traceState(traceKey(run.flowId, stepId)) });
  const name = reportFile(run, format);
  if (!inTauri) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: format === "html" ? "text/html" : "text/markdown" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return name;
  }
  const docs = await documentDir().catch(() => null);
  const path = await save({
    defaultPath: docs ? await join(docs, "UAT", name) : name,
    filters: [REPORT_FILTER[format]],
  });
  return path ? call<string>("flow_write_report", { path, text }) : null;
}

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export function appDeps(flowId: string): Deps {
  return {
    send: async (stepId, req, signal) => {
      const traced = await beginTrace(traceKey(flowId, stepId), req.url);
      const label = `${req.method} ${pathOf(req.url)}`;
      const at = Date.now();
      const t0 = performance.now();
      try {
        const res = await (inTauri ? tauriFetch : window.fetch)(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal,
        });
        const body = await res.text();
        traced({ label, outcome: `${res.status} ${res.statusText}`.trim(), ok: true, at, end: Date.now() });
        return {
          status: res.status,
          statusText: res.statusText,
          headers: [...res.headers.entries()],
          body,
          ms: Math.round(performance.now() - t0),
        };
      } catch (e) {
        traced({ label, outcome: message(e), ok: false, at, end: Date.now() });
        throw e;
      }
    },
    writeSheet: flowsApi.writeSheet,
  };
}
