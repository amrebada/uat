//! `app mcp`: MCP over stdio, for agents that start a command. It answers
//! the handshake itself, so an agent starts at once, and passes tool calls
//! to the running app over its HTTP endpoint, opening UAT first if it isn't
//! running.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use super::Settings;
use super::protocol::{self, PARSE_ERROR, Tools};

/// How long a call waits for UAT to open
const LAUNCH_WAIT: Duration = Duration::from_secs(45);

/// The app, reached over HTTP
pub struct Remote {
    client: reqwest::Client,
    settings: PathBuf,
    /// The .app to open when it isn't running; none outside a bundle
    bundle: Option<PathBuf>,
    launched: AtomicBool,
}

impl Remote {
    pub fn new(settings: PathBuf, bundle: Option<PathBuf>) -> Self {
        Remote { client: reqwest::Client::new(), settings, bundle, launched: AtomicBool::new(false) }
    }

    /// The .app this binary is in
    pub fn own_bundle() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
        exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(PathBuf::from)
    }

    fn launch(&self) -> Result<(), String> {
        let Some(bundle) = &self.bundle else {
            return Err("UAT isn't running. Open it, then try again.".into());
        };
        if !self.launched.swap(true, Ordering::SeqCst) {
            // In the background: the agent's window keeps the focus
            std::process::Command::new("open")
                .arg("-g")
                .arg(bundle)
                .status()
                .map_err(|e| format!("Couldn't open UAT: {e}"))?;
        }
        Ok(())
    }

    /// Sends one request to the app and returns its result
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let deadline = Instant::now() + LAUNCH_WAIT;
        loop {
            if let Some(s) = Settings::read(&self.settings) {
                if !s.enabled {
                    return Err("UAT's MCP server is off. Turn it on in UAT → MCP server.".into());
                }
                let sent = self
                    .client
                    .post(format!("http://127.0.0.1:{}/mcp", s.port))
                    .bearer_auth(&s.token)
                    .header("accept", "application/json, text/event-stream")
                    .json(&body)
                    .send()
                    .await;
                match sent {
                    Ok(res) => {
                        let status = res.status();
                        let text = res.text().await.map_err(|e| e.to_string())?;
                        if !status.is_success() {
                            return Err(format!("UAT answered {status}: {text}"));
                        }
                        let reply: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                        if let Some(err) = reply.get("error") {
                            return Err(err["message"].as_str().unwrap_or("UAT couldn't do it").to_string());
                        }
                        return Ok(reply["result"].clone());
                    }
                    Err(e) if !e.is_connect() => return Err(e.to_string()),
                    // Not running (yet)
                    Err(_) => {}
                }
            }
            self.launch()?;
            if Instant::now() > deadline {
                return Err("UAT didn't open in time. Open it, then try again.".into());
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }
}

impl Tools for Remote {
    async fn list(&self) -> Result<Vec<Value>, String> {
        let result = self.request("tools/list", json!({})).await?;
        result["tools"].as_array().cloned().ok_or_else(|| "UAT sent no tools".into())
    }

    async fn call(&self, name: &str, args: Value) -> Result<Value, String> {
        self.request("tools/call", json!({ "name": name, "arguments": args })).await
    }
}

/// Reads JSON-RPC messages, one per line, and writes the answers as they're
/// ready: a long call doesn't hold up the others.
pub async fn pump<T: Tools + Send + Sync + 'static>(
    input: impl AsyncBufRead + Unpin,
    mut output: impl AsyncWrite + Unpin + Send + 'static,
    tools: Arc<T>,
) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            let written = async {
                output.write_all(line.as_bytes()).await?;
                output.write_all(b"\n").await?;
                output.flush().await
            };
            if written.await.is_err() {
                break;
            }
        }
    });
    let mut lines = input.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let (tx, tools) = (tx.clone(), tools.clone());
        tokio::spawn(async move {
            let out = match serde_json::from_str::<Value>(&line) {
                Ok(msg) => protocol::handle(msg, tools.as_ref()).await,
                Err(e) => Some(protocol::error(Value::Null, PARSE_ERROR, e.to_string())),
            };
            if let Some(out) = out {
                let _ = tx.send(out.to_string());
            }
        });
    }
    // The agent closed stdin: let answers already on their way out go
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(5), writer).await;
}

pub fn run() {
    let remote = Arc::new(Remote::new(super::settings_path(), Remote::own_bundle()));
    tauri::async_runtime::block_on(pump(tokio::io::BufReader::new(tokio::io::stdin()), tokio::io::stdout(), remote));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::http::{Gate, serve};
    use crate::mcp::protocol::tests::Fake;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    async fn exchange(remote: Remote, lines: &[Value]) -> Vec<Value> {
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let (out, mut read) = tokio::io::duplex(1 << 20);
        pump(input.as_bytes(), out, Arc::new(remote)).await;
        let mut text = String::new();
        read.read_to_string(&mut text).await.unwrap();
        let mut replies: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        replies.sort_by_key(|r| r["id"].as_i64());
        replies
    }

    fn settings_file(name: &str, s: &Settings) -> PathBuf {
        let path = std::env::temp_dir().join(format!("uat-mcp-{name}-{}.json", std::process::id()));
        std::fs::write(&path, serde_json::to_string(s).unwrap()).unwrap();
        path
    }

    #[tokio::test]
    async fn passes_tool_calls_to_the_app() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, rx) = oneshot::channel();
        tokio::spawn(serve(listener, Arc::new(Gate { port, token: "t".into() }), Arc::new(Fake), rx));
        let path = settings_file("on", &Settings { enabled: true, port, token: "t".into() });

        let replies = exchange(
            Remote::new(path.clone(), None),
            &[
                json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }),
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
                json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "echo", "arguments": { "n": 7 } } }),
                json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "boom" } }),
            ],
        )
        .await;
        assert_eq!(replies.len(), 4, "{replies:?}");
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], "uat");
        assert_eq!(replies[1]["result"]["tools"][1]["name"], "boom");
        assert_eq!(replies[2]["result"]["content"][0]["text"], r#"{"n":7}"#);
        assert_eq!(replies[3]["result"]["isError"], true);
        stop.send(()).unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn says_why_when_the_app_cant_be_reached() {
        // Nothing listens on the port, and there's no bundle to open
        let free = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        let closed = settings_file("closed", &Settings { enabled: true, port: free, token: "t".into() });
        let off = settings_file("off", &Settings { enabled: false, port: free, token: "t".into() });
        let list = [
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        ];

        let replies = exchange(Remote::new(closed.clone(), None), &list).await;
        // The handshake still works; the tools need the app
        assert_eq!(replies[0]["result"]["serverInfo"]["name"], "uat");
        assert_eq!(replies[1]["error"]["message"], "UAT isn't running. Open it, then try again.");

        let replies = exchange(Remote::new(off.clone(), None), &list).await;
        assert_eq!(replies[1]["error"]["message"], "UAT's MCP server is off. Turn it on in UAT → MCP server.");
        std::fs::remove_file(closed).unwrap();
        std::fs::remove_file(off).unwrap();
    }
}
