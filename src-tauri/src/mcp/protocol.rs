//! MCP's JSON-RPC messages and what the server answers to each, whatever
//! carries them. Tool calls go to `Tools`; in the app, its window runs them.

use std::future::Future;

use serde_json::{Value, json};

/// The protocol versions this server speaks, newest first
pub const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "UAT runs a system on this Mac for acceptance testing. \
Networks are Docker networks; services on a network are containers (from an image or a Dockerfile) \
and commands run on this Mac, all reaching each other by name. Collections hold API calls \
(HTTP, WebSocket, Socket.IO) in nested groups with labels. Flows run steps in order: API calls \
that keep values from their answers, JavaScript transforms (lodash is _), and sheets; the first \
step that fails stops the flow. Calls to a service in UAT are traced: which services they reached \
and what those logged. Start with list_networks, list_collections or list_flows.";

/// What runs the tools
pub trait Tools {
    /// Every tool, as `tools/list` gives them
    fn list(&self) -> impl Future<Output = Result<Vec<Value>, String>> + Send;
    /// Runs one. Ok is a `CallToolResult`; Err is a failure to run it at all.
    fn call(&self, name: &str, args: Value) -> impl Future<Output = Result<Value, String>> + Send;
}

pub const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

pub fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// The answer to `msg`, or None when it needs none (a notification, or a response)
pub async fn handle(msg: Value, tools: &impl Tools) -> Option<Value> {
    let Value::Array(batch) = msg else {
        return one(msg, tools).await;
    };
    // Batches, from 2025-03-26 and before
    let mut out = Vec::new();
    for m in batch {
        if let Some(r) = one(m, tools).await {
            out.push(r);
        }
    }
    (!out.is_empty()).then_some(Value::Array(out))
}

async fn one(msg: Value, tools: &impl Tools) -> Option<Value> {
    let id = msg.get("id").cloned();
    let Some(method) = msg.get("method").and_then(Value::as_str) else {
        // A response to a request of ours (there are none), or not JSON-RPC
        let is_response = msg.get("result").is_some() || msg.get("error").is_some();
        return (!is_response).then(|| error(id.unwrap_or(Value::Null), INVALID_REQUEST, "Not a JSON-RPC request"));
    };
    // Notifications (initialized, cancelled) need no answer
    let id = id?;
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => tools
            .list()
            .await
            .map(|tools| json!({ "tools": tools }))
            .map_err(|e| (INTERNAL_ERROR, e)),
        "tools/call" => call(&params, tools).await,
        _ => Err((METHOD_NOT_FOUND, format!("Method not found: {method}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => error(id, code, message),
    })
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked.filter(|v| VERSIONS.contains(v)).unwrap_or(VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "uat", "title": "UAT", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

async fn call(params: &Value, tools: &impl Tools) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((INVALID_PARAMS, "tools/call needs a tool name".to_string()))?;
    let known = tools.list().await.map_err(|e| (INTERNAL_ERROR, e))?;
    if !known.iter().any(|t| t.get("name").and_then(Value::as_str) == Some(name)) {
        return Err((INVALID_PARAMS, format!("Unknown tool: {name}")));
    }
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    // A tool that fails says so in its result, for the model to read
    Ok(tools.call(name, args).await.unwrap_or_else(|e| {
        json!({ "content": [{ "type": "text", "text": e }], "isError": true })
    }))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Two tools: `echo` answers with its arguments, `boom` can't run
    pub struct Fake;

    impl Tools for Fake {
        async fn list(&self) -> Result<Vec<Value>, String> {
            Ok(vec![
                json!({ "name": "echo", "inputSchema": { "type": "object" } }),
                json!({ "name": "boom", "inputSchema": { "type": "object" } }),
            ])
        }
        async fn call(&self, name: &str, args: Value) -> Result<Value, String> {
            match name {
                "echo" => Ok(json!({ "content": [{ "type": "text", "text": args.to_string() }] })),
                _ => Err("It broke".into()),
            }
        }
    }

    fn req(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    #[tokio::test]
    async fn initializes_with_the_clients_version_when_it_can() {
        let r = handle(req(1, "initialize", json!({ "protocolVersion": "2025-03-26" })), &Fake).await.unwrap();
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "uat");
        assert_eq!(r["result"]["capabilities"]["tools"]["listChanged"], false);

        let r = handle(req(2, "initialize", json!({ "protocolVersion": "1999-01-01" })), &Fake).await.unwrap();
        assert_eq!(r["result"]["protocolVersion"], VERSIONS[0]);
    }

    #[tokio::test]
    async fn answers_requests_but_not_notifications() {
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert_eq!(handle(note, &Fake).await, None);
        assert_eq!(handle(req(3, "ping", Value::Null), &Fake).await.unwrap()["result"], json!({}));
        let r = handle(req(4, "resources/list", Value::Null), &Fake).await.unwrap();
        assert_eq!(r["error"]["code"], METHOD_NOT_FOUND);
        // A response to us is dropped; garbage is answered
        assert_eq!(handle(json!({ "jsonrpc": "2.0", "id": 9, "result": {} }), &Fake).await, None);
        assert_eq!(handle(json!({ "id": 5 }), &Fake).await.unwrap()["error"]["code"], INVALID_REQUEST);
    }

    #[tokio::test]
    async fn lists_and_calls_tools() {
        let r = handle(req(5, "tools/list", Value::Null), &Fake).await.unwrap();
        assert_eq!(r["result"]["tools"][0]["name"], "echo");

        let r = handle(req(6, "tools/call", json!({ "name": "echo", "arguments": { "a": 1 } })), &Fake).await.unwrap();
        assert_eq!(r["result"]["content"][0]["text"], r#"{"a":1}"#);

        let r = handle(req(7, "tools/call", json!({ "name": "boom" })), &Fake).await.unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(r["result"]["content"][0]["text"], "It broke");

        let r = handle(req(8, "tools/call", json!({ "name": "nope" })), &Fake).await.unwrap();
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        assert_eq!(r["error"]["message"], "Unknown tool: nope");
    }

    #[tokio::test]
    async fn answers_a_batch_in_order() {
        let batch = json!([req(1, "ping", Value::Null), { "jsonrpc": "2.0", "method": "x" }, req(2, "ping", Value::Null)]);
        let r = handle(batch, &Fake).await.unwrap();
        assert_eq!(r.as_array().unwrap().iter().map(|m| m["id"].clone()).collect::<Vec<_>>(), [json!(1), json!(2)]);
    }
}
