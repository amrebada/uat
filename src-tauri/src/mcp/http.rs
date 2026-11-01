//! MCP over Streamable HTTP, on 127.0.0.1 only: POST /mcp answers with JSON.
//! There are no sessions and no event stream. Every request needs the token,
//! and browsers are kept out (Host and Origin), so a web page can't drive it.

use std::convert::Infallible;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::protocol::{self, PARSE_ERROR, Tools, VERSIONS};

/// The most a request may carry
const BODY_MAX: usize = 10 * 1024 * 1024;
/// The stateless revision: no `initialize`, so it's only ever seen in the header
const STATELESS_VERSION: &str = "2026-07-28";

pub struct Gate {
    pub port: u16,
    pub token: String,
}

/// Serves until `stop` fires
pub async fn serve<T: Tools + Send + Sync + 'static>(
    listener: TcpListener,
    gate: Arc<Gate>,
    tools: Arc<T>,
    mut stop: oneshot::Receiver<()>,
) {
    loop {
        let stream = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(_) => continue,
            },
            _ = &mut stop => return,
        };
        let (gate, tools) = (gate.clone(), tools.clone());
        tokio::spawn(async move {
            let svc = service_fn(move |req| {
                let (gate, tools) = (gate.clone(), tools.clone());
                async move { Ok::<_, Infallible>(answer(req, &gate, tools.as_ref()).await) }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
        });
    }
}

fn reply(status: StatusCode, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    let mut res = Response::new(Full::new(body.into()));
    *res.status_mut() = status;
    res
}

fn json(status: StatusCode, v: &Value) -> Response<Full<Bytes>> {
    let mut res = reply(status, v.to_string());
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    res
}

fn header<'a>(req: &'a Request<Incoming>, name: &str) -> Option<&'a str> {
    req.headers().get(name).and_then(|v| v.to_str().ok())
}

/// Equal, without stopping at the first difference
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether the request may go on; the response saying why not, if not
pub fn check(gate: &Gate, host: Option<&str>, origin: Option<&str>, auth: Option<&str>) -> Result<(), (StatusCode, &'static str)> {
    const LOCAL: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];
    // DNS rebinding: a page on another name that resolves here
    if !host.is_some_and(|h| LOCAL.iter().any(|n| h == format!("{n}:{}", gate.port))) {
        return Err((StatusCode::FORBIDDEN, "This server answers on 127.0.0.1 only"));
    }
    // A web page's request carries its origin; MCP clients send none
    let local_page = |o: &str| {
        let rest = o.split_once("://").map_or("", |(_, rest)| rest);
        LOCAL.iter().any(|n| rest == *n || rest.starts_with(&format!("{n}:")))
    };
    if origin.is_some_and(|o| !local_page(o)) {
        return Err((StatusCode::FORBIDDEN, "Requests from web pages aren't allowed"));
    }
    let token = auth.and_then(|a| a.strip_prefix("Bearer ")).unwrap_or("");
    if !same(token, &gate.token) {
        return Err((StatusCode::UNAUTHORIZED, "Send the token from UAT → MCP server as `Authorization: Bearer <token>`"));
    }
    Ok(())
}

async fn answer(req: Request<Incoming>, gate: &Gate, tools: &impl Tools) -> Response<Full<Bytes>> {
    if req.uri().path() != "/mcp" {
        return reply(StatusCode::NOT_FOUND, "UAT's MCP endpoint is /mcp");
    }
    if let Err((status, why)) = check(gate, header(&req, "host"), header(&req, "origin"), header(&req, "authorization")) {
        let mut res = reply(status, why);
        if status == StatusCode::UNAUTHORIZED {
            res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        return res;
    }
    if req.method() != Method::POST {
        // No event stream to GET, no session to DELETE
        let mut res = reply(StatusCode::METHOD_NOT_ALLOWED, "");
        res.headers_mut().insert(header::ALLOW, HeaderValue::from_static("POST"));
        return res;
    }
    if let Some(v) = header(&req, "mcp-protocol-version") {
        if !VERSIONS.contains(&v) && v != STATELESS_VERSION {
            return reply(StatusCode::BAD_REQUEST, format!("Unsupported MCP-Protocol-Version: {v}"));
        }
    }
    let body = match Limited::new(req.into_body(), BODY_MAX).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return reply(StatusCode::PAYLOAD_TOO_LARGE, "The request is too large"),
    };
    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return json(StatusCode::BAD_REQUEST, &protocol::error(Value::Null, PARSE_ERROR, e.to_string())),
    };
    match protocol::handle(msg, tools).await {
        Some(out) => json(StatusCode::OK, &out),
        // Notifications and responses
        None => reply(StatusCode::ACCEPTED, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::protocol::tests::Fake;
    use serde_json::json;

    fn gate() -> Gate {
        Gate { port: 47821, token: "s3cret".into() }
    }

    #[test]
    fn lets_in_local_requests_with_the_token_only() {
        let g = gate();
        assert!(check(&g, Some("127.0.0.1:47821"), None, Some("Bearer s3cret")).is_ok());
        assert!(check(&g, Some("localhost:47821"), Some("http://localhost:3000"), Some("Bearer s3cret")).is_ok());
        assert_eq!(check(&g, Some("127.0.0.1:47821"), None, None).unwrap_err().0, StatusCode::UNAUTHORIZED);
        assert_eq!(check(&g, Some("127.0.0.1:47821"), None, Some("Bearer nope")).unwrap_err().0, StatusCode::UNAUTHORIZED);
        // DNS rebinding and other ports
        assert_eq!(check(&g, Some("evil.example:47821"), None, Some("Bearer s3cret")).unwrap_err().0, StatusCode::FORBIDDEN);
        assert_eq!(check(&g, Some("127.0.0.1:80"), None, Some("Bearer s3cret")).unwrap_err().0, StatusCode::FORBIDDEN);
        assert_eq!(check(&g, None, None, Some("Bearer s3cret")).unwrap_err().0, StatusCode::FORBIDDEN);
        // A web page elsewhere
        let page = check(&g, Some("127.0.0.1:47821"), Some("https://evil.example"), Some("Bearer s3cret"));
        assert_eq!(page.unwrap_err().0, StatusCode::FORBIDDEN);
    }

    /// The server on a free port, and a way to post to it
    async fn start() -> (u16, oneshot::Sender<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel();
        tokio::spawn(serve(listener, Arc::new(Gate { port, token: "t".into() }), Arc::new(Fake), rx));
        (port, tx)
    }

    #[tokio::test]
    async fn speaks_mcp_over_http() {
        let (port, stop) = start().await;
        let url = format!("http://127.0.0.1:{port}/mcp");
        let client = reqwest::Client::new();
        let post = |body: Value| {
            client
                .post(&url)
                .bearer_auth("t")
                .header("accept", "application/json, text/event-stream")
                .json(&body)
                .send()
        };

        let res = post(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } }))
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["content-type"], "application/json");
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["result"]["protocolVersion"], "2025-06-18");

        let res = post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.unwrap();
        assert_eq!(res.status(), 202);
        assert_eq!(res.text().await.unwrap(), "");

        let res = post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "echo", "arguments": { "x": 1 } } }))
            .await
            .unwrap();
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["result"]["content"][0]["text"], r#"{"x":1}"#);

        assert_eq!(client.get(&url).bearer_auth("t").send().await.unwrap().status(), 405);
        assert_eq!(client.post(&url).body("{").bearer_auth("t").send().await.unwrap().status(), 400);
        let unauth = client.post(&url).json(&json!({})).send().await.unwrap();
        assert_eq!(unauth.status(), 401);
        let old = client.post(&url).bearer_auth("t").header("mcp-protocol-version", "1999-01-01").json(&json!({})).send();
        assert_eq!(old.await.unwrap().status(), 400);
        stop.send(()).unwrap();
    }
}
