//! UAT's MCP server: AI agents (Claude, Codex, Cursor, Antigravity…) drive
//! everything the app does. It listens on 127.0.0.1 (`http`); agents that
//! start a command use `app mcp` (`bridge`), which talks to it. The tools
//! themselves run in the app's window, with the same code as the UI, so the
//! agent's work shows there as it happens and nothing is saved twice.

mod bridge;
mod http;
pub mod install;
mod protocol;

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};

use crate::docker::CmdResult;

pub use bridge::run as stdio;

/// The bundle id: where the settings live
const APP_ID: &str = "dev.uat.desktop";
const DEFAULT_PORT: u16 = 47821;
/// Ports tried after the saved one, when it's taken
const PORT_TRIES: u16 = 10;
/// The longest a tool may run: a flow can take a while
const CALL_TIMEOUT: Duration = Duration::from_secs(600);
/// How long `tools/list` waits for the window to say what it has
const READY_WAIT: Duration = Duration::from_secs(30);
const CALL_EVENT: &str = "mcp://call";

/// Saved as JSON beside the app's other files, readable only by you: the
/// bridge reads the port and token from it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
}

pub fn settings_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join("Library/Application Support").join(APP_ID).join("mcp.json")
}

impl Settings {
    pub fn read(path: &Path) -> Option<Settings> {
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    }

    fn load_or_create(path: &Path) -> CmdResult<Settings> {
        if let Some(s) = Settings::read(path) {
            return Ok(s);
        }
        let s = Settings { enabled: true, port: DEFAULT_PORT, token: token()? };
        s.save(path)?;
        Ok(s)
    }

    fn save(&self, path: &Path) -> CmdResult<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        f.write_all(serde_json::to_string_pretty(self).unwrap_or_default().as_bytes())
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }
}

/// 32 random bytes, as hex
fn token() -> CmdResult<String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| format!("Couldn't make a token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

struct Running {
    port: u16,
    stop: oneshot::Sender<()>,
}

type Reply = Result<Value, String>;

pub struct Mcp {
    /// What the window can do; None until it says
    tools: watch::Sender<Option<Vec<Value>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next: AtomicU64,
    running: Mutex<Option<Running>>,
    /// Why the server isn't running, when it should be
    error: Mutex<Option<String>>,
}

impl Default for Mcp {
    fn default() -> Self {
        Mcp {
            tools: watch::channel(None).0,
            pending: Mutex::default(),
            next: AtomicU64::new(1),
            running: Mutex::default(),
            error: Mutex::default(),
        }
    }
}

/// The tools, run by the app's window
struct Window {
    app: AppHandle,
}

impl protocol::Tools for Window {
    async fn list(&self) -> Result<Vec<Value>, String> {
        let mut rx = self.app.state::<Mcp>().tools.subscribe();
        let ready = tokio::time::timeout(READY_WAIT, rx.wait_for(Option::is_some)).await;
        match ready {
            Ok(Ok(tools)) => Ok(tools.clone().unwrap_or_default()),
            _ => Err("UAT's window isn't ready. Is it open?".into()),
        }
    }

    async fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        let mcp = self.app.state::<Mcp>();
        let id = mcp.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        mcp.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = self.app.emit(CALL_EVENT, json!({ "id": id, "name": name, "arguments": args })) {
            mcp.pending.lock().unwrap().remove(&id);
            return Err(e.to_string());
        }
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("UAT's window went away".into()),
            Err(_) => {
                mcp.pending.lock().unwrap().remove(&id);
                Err(format!("{name} took longer than {} minutes", CALL_TIMEOUT.as_secs() / 60))
            }
        }
    }
}

async fn bind(saved: u16) -> Result<TcpListener, String> {
    let mut last = String::new();
    for port in std::iter::once(saved).chain(DEFAULT_PORT..DEFAULT_PORT + PORT_TRIES) {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => return Ok(l),
            Err(e) => last = format!("port {port}: {e}"),
        }
    }
    Err(format!("Couldn't listen on 127.0.0.1 ({last})"))
}

/// Starts the server if it's on and not running yet
async fn start(app: &AppHandle) -> CmdResult<()> {
    let mcp = app.state::<Mcp>();
    if mcp.running.lock().unwrap().is_some() {
        return Ok(());
    }
    let path = settings_path();
    let mut settings = Settings::load_or_create(&path)?;
    if !settings.enabled {
        return Ok(());
    }
    let listener = bind(settings.port).await?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    if port != settings.port {
        settings.port = port;
        settings.save(&path)?;
    }
    let (stop, rx) = oneshot::channel();
    let gate = Arc::new(http::Gate { port, token: settings.token.clone() });
    tauri::async_runtime::spawn(http::serve(listener, gate, Arc::new(Window { app: app.clone() }), rx));
    *mcp.running.lock().unwrap() = Some(Running { port, stop });
    Ok(())
}

fn stop(app: &AppHandle) {
    if let Some(r) = app.state::<Mcp>().running.lock().unwrap().take() {
        let _ = r.stop.send(());
    }
}

/// At launch
pub fn setup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let failed = start(&app).await.err();
        *app.state::<Mcp>().error.lock().unwrap() = failed;
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    running: bool,
    port: Option<u16>,
    url: Option<String>,
    token: String,
    /// What agents run: this app, with `mcp`
    command: String,
    args: Vec<String>,
    tools: usize,
    error: Option<String>,
}

/// The command agents run, from this binary
pub fn command() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

fn status(app: &AppHandle) -> Status {
    let mcp = app.state::<Mcp>();
    let settings = Settings::read(&settings_path());
    let port = mcp.running.lock().unwrap().as_ref().map(|r| r.port);
    let tools = mcp.tools.borrow().as_ref().map_or(0, Vec::len);
    Status {
        enabled: settings.as_ref().is_some_and(|s| s.enabled),
        running: port.is_some(),
        port,
        url: port.map(|p| format!("http://127.0.0.1:{p}/mcp")),
        token: settings.map(|s| s.token).unwrap_or_default(),
        command: command(),
        args: vec!["mcp".into()],
        tools,
        error: mcp.error.lock().unwrap().clone(),
    }
}

/// The window says which tools it has (again after a reload)
#[tauri::command]
pub fn mcp_register(app: AppHandle, tools: Vec<Value>) {
    app.state::<Mcp>().tools.send_replace(Some(tools));
}

/// The window's answer to a call
#[tauri::command]
pub fn mcp_reply(app: AppHandle, id: u64, result: Option<Value>, error: Option<String>) {
    let tx = app.state::<Mcp>().pending.lock().unwrap().remove(&id);
    if let Some(tx) = tx {
        let _ = tx.send(match (result, error) {
            (_, Some(e)) => Err(e),
            (Some(r), None) => Ok(r),
            (None, None) => Err("The tool returned nothing".into()),
        });
    }
}

#[tauri::command]
pub fn mcp_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub async fn mcp_set_enabled(app: AppHandle, enabled: bool) -> CmdResult<Status> {
    let path = settings_path();
    let mut settings = Settings::load_or_create(&path)?;
    settings.enabled = enabled;
    settings.save(&path)?;
    if enabled {
        let failed = start(&app).await.err();
        *app.state::<Mcp>().error.lock().unwrap() = failed;
    } else {
        stop(&app);
        *app.state::<Mcp>().error.lock().unwrap() = None;
    }
    Ok(status(&app))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// Each agent UAT can add itself to, and whether it has
#[tauri::command]
pub async fn mcp_clients() -> CmdResult<Vec<install::Client>> {
    blocking(|| Ok(install::clients(&command()))).await
}

#[tauri::command]
pub async fn mcp_install(id: String) -> CmdResult<install::Client> {
    blocking(move || install::install(&id, &command())).await
}

#[tauri::command]
pub async fn mcp_uninstall(id: String) -> CmdResult<install::Client> {
    blocking(move || install::uninstall(&id, &command())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_settings_private() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("uat-mcp-settings-{}/mcp.json", std::process::id()));
        let s = Settings::load_or_create(&path).unwrap();
        assert!(s.enabled);
        assert_eq!(s.port, DEFAULT_PORT);
        assert_eq!(s.token.len(), 64);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        // The same token next time
        assert_eq!(Settings::load_or_create(&path).unwrap().token, s.token);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
