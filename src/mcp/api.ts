/** The MCP server's state and the agents UAT adds itself to, from Rust. In a
 *  plain browser during development, a sample instead. */
import { call, inTauri } from "../lib/tauri";

export type McpStatus = {
  enabled: boolean;
  running: boolean;
  port: number | null;
  url: string | null;
  token: string;
  /** What an agent runs to reach UAT: this app, with `mcp` */
  command: string;
  args: string[];
  tools: number;
  error: string | null;
};

export type McpClient = {
  id: string;
  name: string;
  /** Its config file, with ~ for home */
  config: string;
  detected: boolean;
  state: "installed" | "outdated" | "missing";
  /** What to do after adding UAT to it */
  then: string;
  error: string | null;
};

const sample = !inTauri && import.meta.env.DEV;

const SAMPLE_STATUS: McpStatus = {
  enabled: true,
  running: true,
  port: 47821,
  url: "http://127.0.0.1:47821/mcp",
  token: "3f9c1e7a0b52d84e6a1f0c9d27b3e5a48c61f2d09e7b4a3c5d8e1f6a2b9c0d7e",
  command: "/Applications/UAT.app/Contents/MacOS/app",
  args: ["mcp"],
  tools: 43,
  error: null,
};

const SAMPLE_CLIENTS: McpClient[] = [
  { id: "claude-code", name: "Claude Code", config: "~/.claude.json", detected: true, state: "installed", then: "Start a new Claude Code session; /mcp lists it.", error: null },
  { id: "claude-desktop", name: "Claude Desktop", config: "~/Library/Application Support/Claude/claude_desktop_config.json", detected: true, state: "missing", then: "Quit Claude Desktop and open it again.", error: null },
  { id: "codex", name: "Codex", config: "~/.codex/config.toml", detected: true, state: "outdated", then: "Start a new Codex session; /mcp lists it.", error: null },
  { id: "cursor", name: "Cursor", config: "~/.cursor/mcp.json", detected: false, state: "missing", then: "Check Cursor Settings → MCP; turn uat on if it's off.", error: null },
  { id: "antigravity", name: "Antigravity", config: "~/.gemini/config/mcp_config.json", detected: false, state: "missing", then: "In Antigravity, open MCP Servers → Manage MCP Servers and refresh.", error: null },
];

export const mcpApi = {
  status: () => (sample ? Promise.resolve(SAMPLE_STATUS) : call<McpStatus>("mcp_status")),
  setEnabled: (enabled: boolean) =>
    sample ? Promise.resolve({ ...SAMPLE_STATUS, enabled, running: enabled }) : call<McpStatus>("mcp_set_enabled", { enabled }),
  clients: () => (sample ? Promise.resolve(SAMPLE_CLIENTS) : call<McpClient[]>("mcp_clients")),
  install: (id: string) =>
    sample
      ? Promise.resolve({ ...SAMPLE_CLIENTS.find((c) => c.id === id)!, state: "installed" as const })
      : call<McpClient>("mcp_install", { id }),
  uninstall: (id: string) =>
    sample
      ? Promise.resolve({ ...SAMPLE_CLIENTS.find((c) => c.id === id)!, state: "missing" as const })
      : call<McpClient>("mcp_uninstall", { id }),
};
