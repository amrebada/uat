/** Sending an HTTP request from Collections, traced, and the last response
 *  per request. Outside React, so a send keeps going while you look at
 *  something else, and one sent by an AI agent shows in the editor too. */
import { useSyncExternalStore } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { inTauri, message } from "../lib/tauri";
import { beginTrace } from "../trace/api";
import type { HttpItem } from "./model";

export type Result =
  | { ok: true; status: number; statusText: string; ms: number; size: number; headers: [string, string][]; body: string; json: boolean }
  | { ok: false; error: string; ms: number };

// While the app runs
const results = new Map<string, Result>();
const sending = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const useResult = (id: string) => useSyncExternalStore(subscribe, () => results.get(id));
export const useSending = (id: string) => useSyncExternalStore(subscribe, () => sending.has(id));
export const lastResult = (id: string) => results.get(id);

export function withScheme(url: string) {
  const u = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `http://${u}`;
}

/** `http://localhost:3000/rides?x=1` → `/rides?x=1` */
export function pathOf(url: string) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

export function cancelHttp(id: string) {
  sending.get(id)?.abort();
}

/** Sends `item` as it is now; its trace is keyed by the item's id. */
export async function sendHttp(item: HttpItem): Promise<Result> {
  cancelHttp(item.id);
  const ctrl = new AbortController();
  sending.set(item.id, ctrl);
  notify();
  const hasBody = item.method !== "GET" && item.method !== "HEAD";
  const headers = new Headers();
  for (const h of item.headers) if (h.enabled && h.key.trim()) headers.append(h.key.trim(), h.value);
  const body = hasBody && item.bodyType !== "none" ? item.body : undefined;
  if (body !== undefined && item.bodyType === "json" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const url = withScheme(item.url);
  const traced = await beginTrace(item.id, url);
  const sent = Date.now();
  const t0 = performance.now();
  let r: Result;
  try {
    // Through Rust in the app: no CORS, any host
    const res = await (inTauri ? tauriFetch : window.fetch)(url, {
      method: item.method,
      headers,
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    const type = res.headers.get("content-type") ?? "";
    let pretty = text;
    let json = false;
    if (type.includes("json") || /^\s*[[{]/.test(text)) {
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
        json = true;
      } catch {
        // Not JSON after all; show it as sent
      }
    }
    r = {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      ms,
      size: new TextEncoder().encode(text).length,
      headers: [...res.headers.entries()],
      body: pretty,
      json,
    };
  } catch (e) {
    r = { ok: false, error: ctrl.signal.aborted ? "Cancelled" : message(e), ms: Math.round(performance.now() - t0) };
  }
  if (sending.get(item.id) === ctrl) sending.delete(item.id);
  results.set(item.id, r);
  notify();
  traced({
    label: `${item.method} ${pathOf(url)}`,
    outcome: r.ok ? `${r.status} ${r.statusText}`.trim() : r.error,
    ok: r.ok,
    at: sent,
    end: Date.now(),
  });
  return r;
}
