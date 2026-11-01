//! Commands run on the Mac itself (`npm run dev` in a repo), as services on a
//! network. Their output is kept for the log view and streamed as events. A
//! process with ports joins its network through a proxy container
//! (`docker::ensure_proxy`), so containers reach it by name.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::docker::{self, expand_home, folder_name, valid_name, CmdResult, ProxySpec};
use crate::trace;

const LOG_EVENT: &str = "process://log";
const STATUS_EVENT: &str = "process://status";
const MAX_LINES: usize = 5000;
const FILE: &str = "processes.json";
const STOP_GRACE: Duration = Duration::from_secs(5);

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDef {
    id: String,
    name: String,
    network: String,
    cwd: String,
    command: String,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    ports: Vec<u16>,
    #[serde(default)]
    depends_on: Vec<String>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
#[serde(rename_all = "lowercase")]
enum RunState {
    #[default]
    Stopped,
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
}

impl RunState {
    fn active(self) -> bool {
        matches!(self, RunState::Starting | RunState::Running | RunState::Stopping)
    }
}

#[derive(Serialize, Clone)]
pub struct LogLine {
    seq: u64,
    /// Milliseconds since the epoch, when the app read it
    at: u64,
    /// "out" | "err" | "sys" (the app's own notes)
    stream: &'static str,
    text: String,
}

#[derive(Default)]
struct Run {
    state: RunState,
    pid: Option<i32>,
    exit_code: Option<i32>,
    stop_requested: bool,
    network_error: Option<String>,
    logs: VecDeque<LogLine>,
    seq: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    #[serde(flatten)]
    def: ProcessDef,
    state: RunState,
    pid: Option<i32>,
    exit_code: Option<i32>,
    network_error: Option<String>,
}

#[derive(Serialize, Clone)]
struct LogEvent<'a> {
    id: &'a str,
    line: LogLine,
}

/// Definitions are saved; runs live only as long as the app.
#[derive(Default)]
pub struct Processes {
    defs: Mutex<Vec<ProcessDef>>,
    runs: Mutex<HashMap<String, Run>>,
}

fn store<R: Runtime>(app: &AppHandle<R>) -> &Processes {
    app.state::<Processes>().inner()
}

// ---------------------------------------------------------------------------
// Storage

fn file<R: Runtime>(app: &AppHandle<R>) -> CmdResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(FILE))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) {
    let defs = file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    *store(app).defs.lock().unwrap() = defs;
}

fn save<R: Runtime>(app: &AppHandle<R>, defs: &[ProcessDef]) -> CmdResult<()> {
    let path = file(app)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(defs).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn find<R: Runtime>(app: &AppHandle<R>, id: &str) -> CmdResult<ProcessDef> {
    store(app)
        .defs
        .lock()
        .unwrap()
        .iter()
        .find(|d| d.id == id)
        .cloned()
        .ok_or_else(|| "That process no longer exists".to_string())
}

fn snapshot<R: Runtime>(app: &AppHandle<R>, id: &str) -> Option<ProcessInfo> {
    let def = find(app, id).ok()?;
    let runs = store(app).runs.lock().unwrap();
    let run = runs.get(id);
    Some(ProcessInfo {
        def,
        state: run.map(|r| r.state).unwrap_or_default(),
        pid: run.and_then(|r| r.pid),
        exit_code: run.and_then(|r| r.exit_code),
        network_error: run.and_then(|r| r.network_error.clone()),
    })
}

/// A command as the tracer sees it.
#[derive(Clone, Debug)]
pub(crate) struct ProcRef {
    pub id: String,
    pub name: String,
    pub network: String,
    pub ports: Vec<u16>,
    pub running: bool,
}

pub(crate) fn refs<R: Runtime>(app: &AppHandle<R>) -> Vec<ProcRef> {
    let defs = store(app).defs.lock().unwrap().clone();
    let runs = store(app).runs.lock().unwrap();
    defs.into_iter()
        .map(|d| ProcRef {
            running: runs.get(&d.id).is_some_and(|r| r.state.active()),
            id: d.id,
            name: d.name,
            network: d.network,
            ports: d.ports,
        })
        .collect()
}

/// A command's output in [from, to]: (when, stream, text).
pub(crate) fn lines_between<R: Runtime>(app: &AppHandle<R>, id: &str, from: u64, to: u64) -> Vec<(u64, &'static str, String)> {
    let runs = store(app).runs.lock().unwrap();
    let Some(run) = runs.get(id) else { return Vec::new() };
    run.logs
        .iter()
        .filter(|l| (from..=to).contains(&l.at))
        .map(|l| (l.at, l.stream, l.text.clone()))
        .collect()
}

fn emit_status<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(info) = snapshot(app, id) {
        let _ = app.emit(STATUS_EVENT, info);
    }
}

fn update_run<R: Runtime>(app: &AppHandle<R>, id: &str, f: impl FnOnce(&mut Run)) {
    if let Some(run) = store(app).runs.lock().unwrap().get_mut(id) {
        f(run);
    }
}

fn log<R: Runtime>(app: &AppHandle<R>, id: &str, stream: &'static str, text: String) {
    let line = {
        let mut runs = store(app).runs.lock().unwrap();
        let Some(run) = runs.get_mut(id) else { return };
        run.seq += 1;
        let line = LogLine { seq: run.seq, at: trace::now_ms(), stream, text };
        run.logs.push_back(line.clone());
        if run.logs.len() > MAX_LINES {
            run.logs.pop_front();
        }
        line
    };
    let _ = app.emit(LOG_EVENT, LogEvent { id, line });
}

// ---------------------------------------------------------------------------
// Spawning

fn login_shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into())
}

/// GUI apps on macOS start with a bare PATH. Ask the login shell once for the
/// environment a terminal would have (nvm, Homebrew, asdf, …).
pub(crate) fn shell_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(resolve_shell_env)
}

fn resolve_shell_env() -> HashMap<String, String> {
    const MARK: &str = "__UAT_ENV__";
    let mut env: HashMap<String, String> = std::env::vars().collect();
    let child = Command::new(login_shell())
        .args(["-ilc", &format!("printf {MARK}; env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut resolved = false;
    if let Ok(mut child) = child {
        let mut stdout = child.stdout.take();
        let reader = std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(s) = stdout.as_mut() {
                let _ = s.read_to_end(&mut out);
            }
            out
        });
        // A shell waiting on a prompt must not hang the app
        let deadline = Instant::now() + Duration::from_secs(8);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        let out = reader.join().unwrap_or_default();
        let out = String::from_utf8_lossy(&out);
        if let Some((_, vars)) = out.split_once(MARK) {
            for (k, v) in vars.split('\0').filter_map(|kv| kv.split_once('=')) {
                env.insert(k.to_string(), v.to_string());
                resolved = true;
            }
        }
    }
    if !resolved {
        let path = env.get("PATH").cloned().unwrap_or_default();
        env.insert("PATH".into(), format!("/opt/homebrew/bin:/usr/local/bin:{path}"));
    }
    env
}

/// Runs `command` through the login shell in its own process group, so a
/// stop reaches everything it started (npm → node → esbuild). Calls
/// `on_line` for each line of output and `on_exit` with the exit code.
fn spawn(
    command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
    extra_env: &[String],
    on_line: impl Fn(&'static str, String) + Send + Clone + 'static,
    on_exit: impl FnOnce(Option<i32>) + Send + 'static,
) -> std::io::Result<i32> {
    let mut child = Command::new(login_shell())
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .envs(extra_env.iter().filter_map(|kv| kv.split_once('=')))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()?;
    let pid = child.id() as i32;

    let (done, finished) = mpsc::channel();
    let streams: [(Option<Box<dyn Read + Send>>, &'static str); 2] = [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), "out"),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>), "err"),
    ];
    let mut readers = 0;
    for (stream, name) in streams {
        let Some(stream) = stream else { continue };
        let (on_line, done) = (on_line.clone(), done.clone());
        readers += 1;
        std::thread::spawn(move || {
            read_lines(stream, name, on_line);
            let _ = done.send(());
        });
    }
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        // Let the last lines land before the exit note, unless something it
        // left running still holds the pipes
        for _ in 0..readers {
            if finished.recv_timeout(Duration::from_millis(500)).is_err() {
                break;
            }
        }
        on_exit(code);
    });
    Ok(pid)
}

fn read_lines(stream: impl Read, name: &'static str, on_line: impl Fn(&'static str, String)) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let text = String::from_utf8_lossy(&buf);
        let text = text.trim_end_matches(['\n', '\r']);
        // Spinners redraw one line with \r; keep what it ended as
        on_line(name, text.rsplit('\r').next().unwrap_or("").to_string());
    }
}

fn signal_group(pid: i32, signal: i32) {
    // SAFETY: kill(2) with a negative pid signals that process group only
    unsafe {
        libc::kill(-pid, signal);
    }
}

// ---------------------------------------------------------------------------
// Lifecycle

fn start<R: Runtime>(app: &AppHandle<R>, id: &str) -> CmdResult<()> {
    let def = find(app, id)?;
    let cwd = expand_home(&def.cwd);
    if !cwd.is_dir() {
        return Err(format!("{} is not a folder", cwd.display()));
    }
    {
        let mut runs = store(app).runs.lock().unwrap();
        let run = runs.entry(id.to_string()).or_default();
        if run.state.active() {
            return Err(format!("{} is already running", def.name));
        }
        run.state = RunState::Starting;
        run.pid = None;
        run.exit_code = None;
        run.stop_requested = false;
        run.network_error = None;
    }
    emit_status(app, id);
    tauri::async_runtime::spawn(run(app.clone(), def, cwd));
    Ok(())
}

async fn run<R: Runtime>(app: AppHandle<R>, def: ProcessDef, cwd: PathBuf) {
    let id = def.id.clone();
    let env = tauri::async_runtime::spawn_blocking(|| shell_env().clone()).await.unwrap_or_default();
    log(&app, &id, "sys", format!("$ {}", def.command));

    let on_line = {
        let (app, id) = (app.clone(), id.clone());
        move |stream, text| log(&app, &id, stream, text)
    };
    // Node inside the command reports its calls for traces
    let node_options = def
        .env
        .iter()
        .rev()
        .find_map(|kv| kv.strip_prefix("NODE_OPTIONS="))
        .or(env.get("NODE_OPTIONS").map(String::as_str));
    let mut extra_env = def.env.clone();
    let traced = match trace::hook_env(&id, node_options) {
        Ok((hook, file)) => {
            extra_env.extend(hook);
            Some(file)
        }
        Err(e) => {
            log(&app, &id, "sys", format!("Calls from it won't show in traces: {e}"));
            None
        }
    };
    let done = Arc::new(AtomicBool::new(false));
    let on_exit = {
        let (app, id, done) = (app.clone(), id.clone(), done.clone());
        move |code| {
            done.store(true, Ordering::Release);
            exited(&app, &id, code)
        }
    };
    match spawn(&def.command, &cwd, &env, &extra_env, on_line, on_exit) {
        Ok(pid) => {
            let mut stop_now = false;
            update_run(&app, &id, |r| {
                r.pid = Some(pid);
                if r.stop_requested {
                    stop_now = true;
                } else {
                    r.state = RunState::Running;
                }
            });
            if stop_now {
                signal_group(pid, libc::SIGTERM);
            }
            if let Some(file) = traced {
                trace::follow(id.clone(), file, done);
            }
            emit_status(&app, &id);
        }
        Err(e) => {
            update_run(&app, &id, |r| r.state = RunState::Failed);
            log(&app, &id, "sys", format!("Couldn't start: {e}"));
            emit_status(&app, &id);
            return;
        }
    }

    if def.ports.is_empty() {
        log(&app, &id, "sys", format!("No port set, so containers on {} can't reach it.", def.network));
        return;
    }
    let report = |_: &str, line: String| log(&app, &id, "sys", line);
    let spec = ProxySpec {
        process_id: &id,
        network: &def.network,
        name: &def.name,
        source: &def.cwd,
        ports: &def.ports,
        depends_on: &def.depends_on,
    };
    match docker::ensure_proxy(spec, &report).await {
        Ok(()) => {
            let running = store(&app).runs.lock().unwrap().get(&id).is_some_and(|r| r.state.active());
            if running {
                let at = def.ports.iter().map(|p| format!("{}:{p}", def.name)).collect::<Vec<_>>().join(", ");
                log(&app, &id, "sys", format!("Containers on {} reach it at {at}", def.network));
            } else {
                // It exited while the proxy was coming up
                let _ = docker::remove_proxies(Some(&id)).await;
            }
        }
        Err(e) => {
            log(&app, &id, "sys", format!("Not reachable from containers: {e}"));
            update_run(&app, &id, |r| r.network_error = Some(e));
            emit_status(&app, &id);
        }
    }
}

fn exited<R: Runtime>(app: &AppHandle<R>, id: &str, code: Option<i32>) {
    let mut stopped = false;
    update_run(app, id, |r| {
        stopped = r.stop_requested;
        r.pid = None;
        r.exit_code = code;
        r.state = if stopped { RunState::Stopped } else { RunState::Exited };
    });
    let note = match (stopped, code) {
        (true, _) => "Stopped".to_string(),
        (false, Some(c)) => format!("Exited with code {c}"),
        (false, None) => "Exited on a signal".to_string(),
    };
    log(app, id, "sys", note);
    emit_status(app, id);
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = docker::remove_proxies(Some(&id)).await;
    });
}

fn stop<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let mut pid = None;
    update_run(app, id, |r| {
        if matches!(r.state, RunState::Starting | RunState::Running) {
            r.stop_requested = true;
            r.state = RunState::Stopping;
            pid = r.pid;
        }
    });
    emit_status(app, id);
    let Some(pid) = pid else { return };
    signal_group(pid, libc::SIGTERM);
    // Anything that ignores SIGTERM gets SIGKILL after a grace period
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(STOP_GRACE);
        if store(&app).runs.lock().unwrap().get(&id).is_some_and(|r| r.pid == Some(pid)) {
            signal_group(pid, libc::SIGKILL);
        }
    });
}

fn is_active<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    store(app).runs.lock().unwrap().get(id).is_some_and(|r| r.state.active())
}

/// Stops every process when the app quits, so none outlive it.
pub fn kill_all<R: Runtime>(app: &AppHandle<R>) {
    let pids: Vec<i32> = store(app).runs.lock().unwrap().values().filter_map(|r| r.pid).collect();
    for &pid in &pids {
        signal_group(pid, libc::SIGTERM);
    }
    if !pids.is_empty() {
        std::thread::sleep(Duration::from_millis(400));
        for pid in pids {
            signal_group(pid, libc::SIGKILL);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProcess {
    network: String,
    name: String,
    cwd: String,
    command: String,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    ports: Vec<u16>,
    #[serde(default)]
    depends_on: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessPatch {
    cwd: Option<String>,
    command: Option<String>,
    env: Option<Vec<String>>,
    ports: Option<Vec<u16>>,
    depends_on: Option<Vec<String>>,
}

#[tauri::command]
pub fn process_list<R: Runtime>(app: AppHandle<R>) -> Vec<ProcessInfo> {
    let ids: Vec<String> = store(&app).defs.lock().unwrap().iter().map(|d| d.id.clone()).collect();
    ids.iter().filter_map(|id| snapshot(&app, id)).collect()
}

/// Saves a new process and starts it.
#[tauri::command]
pub fn process_create<R: Runtime>(app: AppHandle<R>, def: NewProcess) -> CmdResult<ProcessInfo> {
    let name = def.name.trim().to_lowercase();
    if !valid_name(&name) {
        return Err("Name must start with a letter or digit and use only a-z, 0-9, - _ .".into());
    }
    if def.command.trim().is_empty() {
        return Err("Enter the command to run, like npm run dev.".into());
    }
    let cwd = expand_home(&def.cwd);
    if !cwd.is_dir() {
        return Err(format!("{} is not a folder", cwd.display()));
    }
    let id = format!("{:x}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
    {
        let mut defs = store(&app).defs.lock().unwrap();
        if defs.iter().any(|d| d.network == def.network && d.name == name) {
            return Err(format!("{name} is already on {}", def.network));
        }
        defs.push(ProcessDef {
            id: id.clone(),
            name,
            network: def.network,
            cwd: cwd.display().to_string(),
            command: def.command.trim().to_string(),
            env: def.env,
            ports: def.ports,
            depends_on: def.depends_on,
        });
        save(&app, &defs)?;
    }
    start(&app, &id)?;
    snapshot(&app, &id).ok_or_else(|| "Saved, but couldn't read it back".into())
}

/// Changes take effect on the next start.
#[tauri::command]
pub fn process_update<R: Runtime>(app: AppHandle<R>, id: String, patch: ProcessPatch) -> CmdResult<ProcessInfo> {
    {
        let mut defs = store(&app).defs.lock().unwrap();
        let def = defs.iter_mut().find(|d| d.id == id).ok_or("That process no longer exists")?;
        if let Some(cwd) = patch.cwd {
            def.cwd = expand_home(&cwd).display().to_string();
        }
        if let Some(command) = patch.command {
            def.command = command.trim().to_string();
        }
        if let Some(env) = patch.env {
            def.env = env;
        }
        if let Some(ports) = patch.ports {
            def.ports = ports;
        }
        if let Some(depends_on) = patch.depends_on {
            def.depends_on = depends_on;
        }
        save(&app, &defs)?;
    }
    emit_status(&app, &id);
    snapshot(&app, &id).ok_or_else(|| "Saved, but couldn't read it back".into())
}

#[tauri::command]
pub async fn process_delete<R: Runtime>(app: AppHandle<R>, id: String) -> CmdResult<()> {
    stop(&app, &id);
    {
        let mut defs = store(&app).defs.lock().unwrap();
        defs.retain(|d| d.id != id);
        save(&app, &defs)?;
    }
    store(&app).runs.lock().unwrap().remove(&id);
    // Docker may be off; the proxy is cleared at the next launch then
    let _ = docker::remove_proxies(Some(&id)).await;
    Ok(())
}

#[tauri::command]
pub fn process_start<R: Runtime>(app: AppHandle<R>, id: String) -> CmdResult<()> {
    start(&app, &id)
}

#[tauri::command]
pub fn process_stop<R: Runtime>(app: AppHandle<R>, id: String) {
    stop(&app, &id);
}

#[tauri::command]
pub async fn process_restart<R: Runtime>(app: AppHandle<R>, id: String) -> CmdResult<()> {
    stop(&app, &id);
    let deadline = Instant::now() + STOP_GRACE + Duration::from_secs(2);
    while is_active(&app, &id) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    start(&app, &id)
}

#[tauri::command]
pub fn process_logs<R: Runtime>(app: AppHandle<R>, id: String) -> Vec<LogLine> {
    store(&app).runs.lock().unwrap().get(&id).map(|r| r.logs.iter().cloned().collect()).unwrap_or_default()
}

#[tauri::command]
pub fn process_clear_logs<R: Runtime>(app: AppHandle<R>, id: String) {
    update_run(&app, &id, |r| r.logs.clear());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    exists: bool,
    suggested_name: String,
    /// Likely commands, best first
    commands: Vec<String>,
    /// From `PORT=` in the folder's .env files
    ports: Vec<u16>,
}

/// `PORT=3000` (or `export PORT="3000"`) in the usual .env files.
fn env_ports(dir: &Path) -> Vec<u16> {
    let mut ports = Vec::new();
    for file in [".env", ".env.local", ".env.development", ".env.development.local"] {
        let Ok(text) = std::fs::read_to_string(dir.join(file)) else { continue };
        for line in text.lines() {
            let line = line.trim().trim_start_matches("export ").trim();
            let Some(value) = line.strip_prefix("PORT=") else { continue };
            let value = value.split('#').next().unwrap_or("").trim().trim_matches(['"', '\'']);
            if let Ok(port) = value.parse::<u16>() {
                if port > 0 && !ports.contains(&port) {
                    ports.push(port);
                }
            }
        }
    }
    ports
}

/// Guesses how a repo is started, from its package.json scripts and the like.
#[tauri::command]
pub fn process_inspect_folder(cwd: String) -> FolderInfo {
    let dir = expand_home(&cwd);
    let mut commands = Vec::new();
    if let Ok(text) = std::fs::read_to_string(dir.join("package.json")) {
        let pm = if dir.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if dir.join("yarn.lock").exists() {
            "yarn"
        } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
            "bun"
        } else {
            "npm"
        };
        let scripts: Vec<String> = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("scripts")?.as_object().map(|o| o.keys().cloned().collect()))
            .unwrap_or_default();
        let preferred = ["dev", "start", "serve", "start:dev", "watch"];
        let mut ordered: Vec<&String> = preferred.iter().filter_map(|p| scripts.iter().find(|s| s == p)).collect();
        ordered.extend(scripts.iter().filter(|s| !preferred.contains(&s.as_str())));
        commands.extend(ordered.into_iter().take(5).map(|s| format!("{pm} run {s}")));
    }
    if dir.join("Cargo.toml").exists() {
        commands.push("cargo run".into());
    }
    if dir.join("go.mod").exists() {
        commands.push("go run .".into());
    }
    if dir.join("manage.py").exists() {
        commands.push("python manage.py runserver".into());
    }
    FolderInfo { exists: dir.is_dir(), suggested_name: folder_name(&dir), commands, ports: env_ports(&dir) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn run_and_collect(command: &str) -> (Vec<(String, String)>, Option<i32>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let sink = lines.clone();
        spawn(
            command,
            &std::env::temp_dir(),
            &std::env::vars().collect(),
            &["GREETING=hello".to_string()],
            move |stream, text| sink.lock().unwrap().push((stream.to_string(), text)),
            move |code| tx.send(code).unwrap(),
        )
        .unwrap();
        let code = rx.recv_timeout(Duration::from_secs(10)).expect("process to exit");
        let lines = lines.lock().unwrap().clone();
        (lines, code)
    }

    #[test]
    fn captures_both_streams_env_and_exit_code() {
        let (lines, code) = run_and_collect("echo \"$GREETING out\"; echo err >&2; printf 'a\\rb\\n'; exit 3");
        assert_eq!(code, Some(3));
        assert!(lines.contains(&("out".into(), "hello out".into())), "{lines:?}");
        assert!(lines.contains(&("err".into(), "err".into())), "{lines:?}");
        assert!(lines.contains(&("out".into(), "b".into())), "{lines:?}");
    }

    #[test]
    fn stopping_reaches_the_whole_process_group() {
        let (tx, rx) = mpsc::channel();
        let pid = spawn(
            "sleep 30 & sleep 30",
            &std::env::temp_dir(),
            &std::env::vars().collect(),
            &[],
            |_, _| {},
            move |code| tx.send(code).unwrap(),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(200));
        signal_group(pid, libc::SIGTERM);
        // Exits on the signal (no code), and the backgrounded sleep is gone too
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).expect("exit"), None);
        let alive = unsafe { libc::kill(-pid, 0) } == 0;
        assert!(!alive, "process group {pid} still has members");
    }

    #[test]
    fn suggests_package_scripts_with_the_repo_package_manager() {
        let dir = std::env::temp_dir().join(format!("uat-folder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"build":"x","dev":"y","start":"z"}}"#).unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        std::fs::write(dir.join(".env"), "APP_PORT=1\nexport PORT=\"4000\" # api\n").unwrap();
        std::fs::write(dir.join(".env.local"), "PORT=4000\nPORT=9229\n").unwrap();
        let info = process_inspect_folder(dir.display().to_string());
        assert!(info.exists);
        assert_eq!(info.commands, vec!["pnpm run dev", "pnpm run start", "pnpm run build"]);
        assert_eq!(info.ports, vec![4000, 9229]);
    }

    fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// The whole lifecycle in Tauri's mock runtime, against the local engine:
    /// `cargo test -- --ignored --nocapture live_`. A python server on this Mac
    /// joins a throwaway network, a container fetches from it by name, then
    /// it is stopped and removed.
    #[test]
    #[ignore]
    fn live_command_lifecycle() {
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().identifier = "dev.uat.test".into();
        let app = tauri::test::mock_builder().manage(Processes::default()).build(ctx).unwrap();
        let app = app.handle().clone();
        let data_dir = app.path().app_data_dir().unwrap();

        let pid = std::process::id();
        let network = format!("uat-ctest-{pid}");
        let name = format!("web-{pid}");
        let port = 19000 + (pid % 1000) as u16;
        let dir = std::env::temp_dir().join(format!("uat-cmd-{pid}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("marker.txt"), "served by a command").unwrap();

        let info = process_create(
            app.clone(),
            NewProcess {
                network: network.clone(),
                name: name.clone(),
                cwd: dir.display().to_string(),
                command: format!("python3 -m http.server {port} --bind 127.0.0.1"),
                env: vec![],
                ports: vec![port],
                depends_on: vec![],
            },
        )
        .unwrap();
        let id = info.def.id.clone();
        let output = || process_logs(app.clone(), id.clone()).into_iter().map(|l| l.text).collect::<Vec<_>>();

        wait_for("the proxy", Duration::from_secs(60), || output().iter().any(|l| l.contains("reach it at")));
        assert_eq!(snapshot(&app, &id).unwrap().state, RunState::Running);

        let fetched = tauri::async_runtime::block_on(async {
            let client = format!("{network}-client");
            let docker = docker::docker().await?;
            let body = bollard::models::ContainerCreateBody {
                image: Some("redis:7-alpine".into()),
                entrypoint: Some(vec!["sh".into(), "-c".into()]),
                cmd: Some(vec![format!(
                    "for i in $(seq 1 20); do wget -qO- http://{name}:{port}/marker.txt && exit 0; sleep 0.5; done; exit 1"
                )]),
                host_config: Some(bollard::models::HostConfig {
                    network_mode: Some(network.clone()),
                    ..Default::default()
                }),
                ..Default::default()
            };
            let options = bollard::query_parameters::CreateContainerOptionsBuilder::new().name(&client).build();
            docker.create_container(Some(options), body).await.map_err(|e| e.to_string())?;
            docker.start_container(&client, None).await.map_err(|e| e.to_string())?;
            use futures_util::StreamExt;
            let _ = docker.wait_container(&client, None).next().await;
            let logs = docker::docker_logs(client.clone(), Some(20)).await;
            let options = bollard::query_parameters::RemoveContainerOptionsBuilder::default().force(true).build();
            let _ = docker.remove_container(&client, Some(options)).await;
            logs
        });

        // The server's request log arrives on stderr
        wait_for("the request in the output", Duration::from_secs(5), || {
            output().iter().any(|l| l.contains("GET /marker.txt"))
        });

        process_stop(app.clone(), id.clone());
        wait_for("the stop", Duration::from_secs(10), || snapshot(&app, &id).unwrap().state == RunState::Stopped);
        assert!(output().iter().any(|l| l == "Stopped"));

        tauri::async_runtime::block_on(async {
            let _ = process_delete(app.clone(), id.clone()).await;
            let _ = docker::docker().await.unwrap().remove_network(&network).await;
        });
        let _ = std::fs::remove_dir_all(&data_dir);

        assert!(fetched.expect("client ran").contains("served by a command"));
        assert!(process_list(app.clone()).is_empty());
    }

    #[test]
    fn resolves_a_login_shell_path() {
        let env = resolve_shell_env();
        assert!(env.get("PATH").is_some_and(|p| p.contains("/usr/bin")));
    }
}
