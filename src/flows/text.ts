/** How the log and the report write values: bodies, sizes, kinds. */

/** How much of a body or value is shown */
export const BODY_MAX = 100_000;

/** JSON indented, anything else as it is; cut at BODY_MAX */
export function pretty(text: string): string {
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON: as sent
  }
  return clip(out);
}

export function clip(text: string): string {
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX)}\n… ${text.length - BODY_MAX} more characters` : text;
}

export function size(bytes: number) {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** "list of 3", "object", "string" */
export function kind(value: unknown): string {
  if (Array.isArray(value)) return `list of ${value.length}`;
  if (value === null) return "null";
  return typeof value;
}
