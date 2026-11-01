/** A tool as UAT defines it, and as MCP describes it: a name, what it does,
 *  the arguments it takes (checked before it runs) and hints for the agent
 *  about what it changes. */

type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export type Prop = {
  type: JsonType | JsonType[];
  description: string;
  enum?: readonly string[];
  items?: { type: JsonType | JsonType[]; description?: string };
};

export type Args = Record<string, unknown>;

export type Tool = {
  name: string;
  title: string;
  description: string;
  props?: Record<string, Prop>;
  required?: string[];
  /** Only reads */
  read?: boolean;
  /** Deletes or replaces something */
  destructive?: boolean;
  /** Reaches past UAT: sends requests, runs commands */
  open?: boolean;
  run: (args: Args) => Promise<unknown>;
};

/** The tool as `tools/list` gives it */
export function describe(tool: Tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: tool.props ?? {},
      ...(tool.required?.length && { required: tool.required }),
      additionalProperties: false,
    },
    annotations: {
      title: tool.title,
      readOnlyHint: !!tool.read,
      destructiveHint: !tool.read && !!tool.destructive,
      idempotentHint: !!tool.read,
      openWorldHint: !!tool.open,
    },
  };
}

function typeOf(v: unknown): JsonType | "null" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v as JsonType;
}

const fits = (v: unknown, type: JsonType) => {
  const t = typeOf(v);
  return t === type || (type === "number" && t === "integer");
};

/** `args` checked against what `tool` takes; an error says what's wrong */
export function checkArgs(tool: Tool, args: unknown): Args {
  if (args === undefined || args === null) args = {};
  if (typeOf(args) !== "object") throw new Error(`${tool.name} takes an object of arguments.`);
  const given = args as Args;
  const props = tool.props ?? {};
  const known = Object.keys(props);
  for (const [key, value] of Object.entries(given)) {
    const prop = props[key];
    if (!prop) {
      const takes = known.length ? `It takes ${known.join(", ")}.` : "It takes none.";
      throw new Error(`${tool.name} has no argument "${key}". ${takes}`);
    }
    // Agents send null for "not given"
    if (value === null || value === undefined) continue;
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    if (!types.some((t) => fits(value, t))) {
      throw new Error(`${key} should be ${types.join(" or ")}, not ${typeOf(value)}.`);
    }
    if (prop.enum && !prop.enum.includes(value as string)) {
      throw new Error(`${key} should be one of ${prop.enum.join(", ")}.`);
    }
  }
  for (const key of tool.required ?? []) {
    if (given[key] === undefined || given[key] === null || given[key] === "") throw new Error(`${key} is required.`);
  }
  return Object.fromEntries(Object.entries(given).filter(([, v]) => v !== null && v !== undefined));
}

/** What a tool returned, as the text the agent reads */
export function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === undefined) return "Done.";
  return JSON.stringify(result, null, 2);
}
