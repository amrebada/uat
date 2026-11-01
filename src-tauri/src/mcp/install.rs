//! Puts UAT in AI agents' MCP configs, as the stdio command `app mcp`:
//! Claude Code (through its CLI), Claude Desktop, Codex, Cursor and
//! Antigravity. The agents' other servers and settings stay as they were;
//! the first change to a file keeps a copy of it beside it.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::{Map, Value, json};
use toml_edit::{Array, DocumentMut, Item, Table, value};

use crate::docker::CmdResult;

/// The name agents know the server by
pub const NAME: &str = "uat";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Format {
    /// `{ "mcpServers": { "uat": { "command", "args" } } }`
    Json,
    /// `[mcp_servers.uat]`
    Toml,
    /// `claude mcp add`; read back from `~/.claude.json`
    ClaudeCli,
}

struct Spec {
    id: &'static str,
    name: &'static str,
    format: Format,
    /// Where it's written, from the home folder
    file: &'static str,
    /// Older places the agent may still read; updated when they exist
    also: &'static [&'static str],
    /// Any of these means the agent is on this Mac
    signs: &'static [&'static str],
    /// How the agent picks up the change
    then: &'static str,
}

const SPECS: &[Spec] = &[
    Spec {
        id: "claude-code",
        name: "Claude Code",
        format: Format::ClaudeCli,
        file: ".claude.json",
        also: &[],
        signs: &[".claude.json", ".claude"],
        then: "Start a new Claude Code session; /mcp lists it.",
    },
    Spec {
        id: "claude-desktop",
        name: "Claude Desktop",
        format: Format::Json,
        file: "Library/Application Support/Claude/claude_desktop_config.json",
        also: &[],
        signs: &["/Applications/Claude.app", "Library/Application Support/Claude"],
        then: "Quit Claude Desktop and open it again.",
    },
    Spec {
        id: "codex",
        name: "Codex",
        format: Format::Toml,
        file: ".codex/config.toml",
        also: &[],
        signs: &[".codex", "/Applications/Codex.app"],
        then: "Start a new Codex session; /mcp lists it.",
    },
    Spec {
        id: "cursor",
        name: "Cursor",
        format: Format::Json,
        file: ".cursor/mcp.json",
        also: &[],
        signs: &["/Applications/Cursor.app", ".cursor"],
        then: "Check Cursor Settings → MCP; turn uat on if it's off.",
    },
    Spec {
        id: "antigravity",
        name: "Antigravity",
        format: Format::Json,
        file: ".gemini/config/mcp_config.json",
        also: &[".gemini/antigravity/mcp_config.json"],
        signs: &["/Applications/Antigravity.app", ".gemini/antigravity", ".gemini/config"],
        then: "In Antigravity, open MCP Servers → Manage MCP Servers and refresh.",
    },
];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Client {
    id: &'static str,
    name: &'static str,
    /// The config file, with ~ for home
    config: String,
    /// Whether the agent seems to be on this Mac
    detected: bool,
    /// "installed", "outdated" (another command, from an older copy of UAT) or "missing"
    state: &'static str,
    then: &'static str,
    /// Why its config couldn't be read
    error: Option<String>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn at(home: &Path, rel: &str) -> PathBuf {
    if rel.starts_with('/') { PathBuf::from(rel) } else { home.join(rel) }
}

fn spec(id: &str) -> CmdResult<&'static Spec> {
    SPECS.iter().find(|s| s.id == id).ok_or_else(|| format!("No agent called {id}"))
}

// ---- Reading and writing ----

fn read(path: &Path) -> CmdResult<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Couldn't read {}: {e}", path.display())),
    }
}

/// Replaces `path` whole, keeping a copy of what was there the first time
fn write(path: &Path, text: &str) -> CmdResult<()> {
    let fail = |e: std::io::Error| format!("Couldn't write {}: {e}", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("config");
    let backup = path.with_file_name(format!("{name}.before-uat"));
    if path.exists() && !backup.exists() {
        std::fs::copy(path, &backup).map_err(fail)?;
    }
    let tmp = path.with_file_name(format!(".{name}.uat-tmp"));
    std::fs::write(&tmp, text).map_err(fail)?;
    std::fs::rename(&tmp, path).map_err(fail)
}

fn json_doc(text: Option<&str>, path: &Path) -> CmdResult<Map<String, Value>> {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        return Ok(Map::new());
    };
    match serde_json::from_str(text) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(format!("{} isn't a JSON object", path.display())),
        Err(e) => Err(format!("{} isn't valid JSON ({e}); add UAT to it by hand", path.display())),
    }
}

fn json_command(doc: &Map<String, Value>) -> Option<String> {
    doc.get("mcpServers")?.get(NAME)?.get("command")?.as_str().map(String::from)
}

fn toml_doc(text: Option<&str>, path: &Path) -> CmdResult<DocumentMut> {
    text.unwrap_or_default()
        .parse()
        .map_err(|e| format!("{} isn't valid TOML ({e}); add UAT to it by hand", path.display()))
}

fn toml_command(doc: &DocumentMut) -> Option<String> {
    doc.get("mcp_servers")?.get(NAME)?.get("command")?.as_str().map(String::from)
}

/// The command a config has for UAT, if any
fn installed(format: Format, path: &Path) -> CmdResult<Option<String>> {
    let text = read(path)?;
    Ok(match format {
        Format::Json | Format::ClaudeCli => json_command(&json_doc(text.as_deref(), path)?),
        Format::Toml => toml_command(&toml_doc(text.as_deref(), path)?),
    })
}

fn put_json(path: &Path, command: Option<&str>) -> CmdResult<()> {
    let mut doc = json_doc(read(path)?.as_deref(), path)?;
    let servers = doc.entry("mcpServers").or_insert_with(|| json!({}));
    let Value::Object(servers) = servers else {
        return Err(format!("mcpServers in {} isn't an object", path.display()));
    };
    match command {
        Some(cmd) => {
            servers.insert(NAME.into(), json!({ "command": cmd, "args": ["mcp"] }));
        }
        None => {
            servers.remove(NAME);
        }
    }
    write(path, &(serde_json::to_string_pretty(&doc).unwrap_or_default() + "\n"))
}

fn put_toml(path: &Path, command: Option<&str>) -> CmdResult<()> {
    let mut doc = toml_doc(read(path)?.as_deref(), path)?;
    let servers = doc.entry("mcp_servers").or_insert_with(|| {
        let mut t = Table::new();
        // Only [mcp_servers.uat] shows, not an empty [mcp_servers]
        t.set_implicit(true);
        Item::Table(t)
    });
    let servers = servers
        .as_table_mut()
        .ok_or_else(|| format!("mcp_servers in {} isn't a table", path.display()))?;
    match command {
        Some(cmd) => {
            let mut t = Table::new();
            t["command"] = value(cmd);
            t["args"] = value(Array::from_iter(["mcp"]));
            // UAT may need opening first, and a flow can run for minutes
            t["startup_timeout_sec"] = value(60);
            t["tool_timeout_sec"] = value(600);
            servers.insert(NAME, Item::Table(t));
        }
        None => {
            servers.remove(NAME);
        }
    }
    write(path, &doc.to_string())
}

// ---- Claude Code's CLI ----

/// `claude`, found the way a terminal would
fn claude_cli() -> Option<String> {
    let out = Command::new("/bin/zsh").args(["-lic", "command -v claude"]).output().ok()?;
    let found = String::from_utf8_lossy(&out.stdout).lines().last()?.trim().to_string();
    found.starts_with('/').then_some(found)
}

fn claude(args: &[&str]) -> CmdResult<()> {
    let cli = claude_cli().ok_or("Claude Code's `claude` command wasn't found")?;
    let out = Command::new(&cli).args(args).output().map_err(|e| format!("Couldn't run claude: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("claude {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

// ---- Agents ----

fn client(s: &Spec, home: &Path, command: &str) -> Client {
    let path = at(home, s.file);
    let mut paths = vec![path.clone()];
    paths.extend(s.also.iter().map(|a| at(home, a)).filter(|p| p.exists()));
    let mut found = Ok(None);
    for p in &paths {
        match installed(s.format, p) {
            Ok(Some(cmd)) => {
                found = Ok(Some(cmd));
                break;
            }
            Ok(None) => {}
            Err(e) => found = Err(e),
        }
    }
    let (state, error) = match found {
        Ok(Some(cmd)) if cmd == command => ("installed", None),
        Ok(Some(_)) => ("outdated", None),
        Ok(None) => ("missing", None),
        Err(e) => ("missing", Some(e)),
    };
    Client {
        id: s.id,
        name: s.name,
        config: path.display().to_string().replacen(&home.display().to_string(), "~", 1),
        detected: s.signs.iter().any(|sign| at(home, sign).exists()),
        state,
        then: s.then,
        error,
    }
}

fn put(s: &Spec, home: &Path, command: Option<&str>) -> CmdResult<()> {
    match s.format {
        Format::ClaudeCli => {
            // Replace whatever is there, at user scope
            let _ = claude(&["mcp", "remove", "--scope", "user", NAME]);
            match command {
                Some(cmd) => claude(&["mcp", "add", "--transport", "stdio", "--scope", "user", NAME, "--", cmd, "mcp"]),
                None => Ok(()),
            }
        }
        Format::Json | Format::Toml => {
            let main = at(home, s.file);
            let older = s.also.iter().map(|a| at(home, a)).filter(|p| p.exists());
            for path in std::iter::once(main).chain(older) {
                if s.format == Format::Json {
                    put_json(&path, command)?;
                } else {
                    put_toml(&path, command)?;
                }
            }
            Ok(())
        }
    }
}

pub fn clients(command: &str) -> Vec<Client> {
    let home = home();
    SPECS.iter().map(|s| client(s, &home, command)).collect()
}

pub fn install(id: &str, command: &str) -> CmdResult<Client> {
    let s = spec(id)?;
    let home = home();
    put(s, &home, Some(command))?;
    Ok(client(s, &home, command))
}

pub fn uninstall(id: &str, command: &str) -> CmdResult<Client> {
    let s = spec(id)?;
    let home = home();
    put(s, &home, None)?;
    Ok(client(s, &home, command))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = "/Applications/UAT.app/Contents/MacOS/app";

    fn home(name: &str) -> PathBuf {
        let h = std::env::temp_dir().join(format!("uat-install-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&h);
        std::fs::create_dir_all(&h).unwrap();
        h
    }

    #[test]
    fn adds_itself_to_a_json_config_keeping_the_rest() {
        let h = home("json");
        let cursor = spec("cursor").unwrap();
        let path = h.join(".cursor/mcp.json");
        assert_eq!(client(cursor, &h, CMD).state, "missing");

        // A new file
        put(cursor, &h, Some(CMD)).unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc, json!({ "mcpServers": { "uat": { "command": CMD, "args": ["mcp"] } } }));
        assert_eq!(client(cursor, &h, CMD).state, "installed");
        assert_eq!(client(cursor, &h, "/elsewhere/app").state, "outdated");

        // One with other servers and settings, in their order
        std::fs::write(&path, r#"{"theme":"dark","mcpServers":{"zeta":{"command":"z"},"alpha":{"url":"http://a"}}}"#).unwrap();
        put(cursor, &h, Some(CMD)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        let order: Vec<_> = ["\"theme\"", "\"zeta\"", "\"alpha\"", "\"uat\""].iter().map(|k| text.find(k).unwrap()).collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "{text}");
        // The first copy of what was there is kept
        assert!(h.join(".cursor/mcp.json.before-uat").exists());

        put(cursor, &h, None).unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"].as_object().unwrap().keys().collect::<Vec<_>>(), ["zeta", "alpha"]);
        assert_eq!(client(cursor, &h, CMD).state, "missing");
        std::fs::remove_dir_all(h).unwrap();
    }

    #[test]
    fn leaves_a_config_it_cant_read() {
        let h = home("bad");
        let desktop = spec("claude-desktop").unwrap();
        let path = at(&h, desktop.file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ not json").unwrap();
        let err = put(desktop, &h, Some(CMD)).unwrap_err();
        assert!(err.contains("isn't valid JSON"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
        assert!(client(desktop, &h, CMD).error.is_some());
        std::fs::remove_dir_all(h).unwrap();
    }

    #[test]
    fn adds_itself_to_codex_keeping_comments_and_tables() {
        let h = home("toml");
        let codex = spec("codex").unwrap();
        let path = h.join(".codex/config.toml");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "# my settings\nmodel = \"gpt-5\"\n\n[mcp_servers.docs]\ncommand = \"npx\"\nargs = [\"docs-mcp\"]\n").unwrap();

        put(codex, &h, Some(CMD)).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("# my settings\nmodel = \"gpt-5\"\n"), "{text}");
        assert!(text.contains("[mcp_servers.docs]\ncommand = \"npx\""), "{text}");
        assert!(
            text.contains(&format!(
                "[mcp_servers.uat]\ncommand = \"{CMD}\"\nargs = [\"mcp\"]\nstartup_timeout_sec = 60\ntool_timeout_sec = 600\n"
            )),
            "{text}"
        );
        assert_eq!(client(codex, &h, CMD).state, "installed");

        put(codex, &h, None).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("uat"), "{text}");
        assert!(text.contains("[mcp_servers.docs]"));

        // An empty config gets only the uat table
        std::fs::remove_file(&path).unwrap();
        put(codex, &h, Some(CMD)).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().starts_with("[mcp_servers.uat]\n"));
        std::fs::remove_dir_all(h).unwrap();
    }

    #[test]
    fn writes_antigravitys_older_config_too_when_it_has_one() {
        let h = home("ag");
        let ag = spec("antigravity").unwrap();
        let older = h.join(".gemini/antigravity/mcp_config.json");
        std::fs::create_dir_all(older.parent().unwrap()).unwrap();
        std::fs::write(&older, "{}").unwrap();
        put(ag, &h, Some(CMD)).unwrap();
        for p in [h.join(".gemini/config/mcp_config.json"), older] {
            let doc: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            assert_eq!(doc["mcpServers"]["uat"]["command"], CMD, "{}", p.display());
        }
        let c = client(ag, &h, CMD);
        assert_eq!((c.state, c.detected), ("installed", true));
        assert_eq!(c.config, "~/.gemini/config/mcp_config.json");
        std::fs::remove_dir_all(h).unwrap();
    }
}
