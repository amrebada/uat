import { invoke, isTauri } from "@tauri-apps/api/core";

/** False when the UI runs in a plain browser (`npm run dev` without Tauri). */
export const inTauri = isTauri();

/** `invoke`, with the Rust side's `Err(String)` turned into an `Error`. */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) {
    throw new Error("This needs the desktop app. Run `npm run tauri dev`.");
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
  }
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
