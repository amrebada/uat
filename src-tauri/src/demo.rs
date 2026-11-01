//! A small network to try call traces on. `gateway`, published on a free
//! port of this Mac, calls `orders` and `users`; `orders` uses `redis` and,
//! when a ride is booked, calls `payments`, which isn't there. Each service
//! is `demo.sh` behind socat; DEMO_ROLE says which one it is.

use std::net::TcpListener;
use std::ops::Range;

use bollard::query_parameters::RemoveContainerOptionsBuilder;
use bollard::Docker;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::docker::{self, err, AddServiceRequest, CmdResult, PortRequest, Report, ServiceSource};
use crate::trace;

pub const NETWORK: &str = "uat-demo";
const PROGRESS_EVENT: &str = "demo://progress";

const IMAGE: &str = "uat/demo:1";
const DOCKERFILE: &str = r#"FROM alpine:3.20
RUN apk add --no-cache socat
COPY demo.sh /demo.sh
EXPOSE 8080
CMD ["sh", "-c", "echo \"$DEMO_ROLE listening on :8080\" >&2; exec socat TCP-LISTEN:8080,reuseaddr,fork EXEC:/demo.sh"]
"#;
const SCRIPT: &str = include_str!("demo.sh");
const REDIS: &str = "redis:7-alpine";

/// Where on this Mac the gateway is published
const PORTS: Range<u16> = 8480..8580;
/// In the order they start, with what each one calls
const SERVICES: [(&str, &[&str]); 4] =
    [("redis", &[]), ("users", &[]), ("orders", &["redis"]), ("gateway", &["orders", "users"])];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Demo {
    network: String,
    /// The gateway, on localhost
    port: u16,
}

/// Sets the demo up, or starts it again if it's there, and watches it so
/// the first call is traced.
#[tauri::command]
pub async fn demo_start(app: AppHandle) -> CmdResult<Demo> {
    let report = |_: &str, line: String| {
        let _ = app.emit(PROGRESS_EVENT, line);
    };
    let port = set_up(&docker::docker().await?, NETWORK, &report).await?;
    report("", "Watching the network".into());
    // The trace says it if watching fails; the demo still works without it
    let _ = trace::watch(NETWORK).await;
    Ok(Demo { network: NETWORK.into(), port })
}

/// Makes sure the demo runs on `network`. Returns the gateway's port.
async fn set_up(docker: &Docker, network: &str, report: Report<'_>) -> CmdResult<u16> {
    let mut found = Vec::new();
    for (name, _) in SERVICES {
        if let Ok(c) = docker.inspect_container(&format!("{network}-{name}"), None).await {
            found.push((name, c));
        }
    }
    if found.len() == SERVICES.len() {
        for (name, c) in &found {
            if !c.state.as_ref().and_then(|s| s.running).unwrap_or(false) {
                report("start", format!("Starting {name}"));
                docker.start_container(c.id.as_deref().unwrap_or_default(), None).await.map_err(err)?;
            }
        }
        let gateway = &found.last().expect("four").1;
        return gateway
            .host_config
            .as_ref()
            .and_then(|h| h.port_bindings.as_ref())
            .and_then(|b| b.get("8080/tcp").cloned().flatten())
            .and_then(|b| b.first().and_then(|b| b.host_port.as_deref()?.parse().ok()))
            .ok_or_else(|| "The demo's gateway isn't published; remove it and try again".into());
    }

    // Half there from an earlier try: start over
    for (_, c) in found {
        let force = RemoveContainerOptionsBuilder::default().force(true).build();
        docker.remove_container(c.id.as_deref().unwrap_or_default(), Some(force)).await.map_err(err)?;
    }
    report("build", "Building the demo image".into());
    let files = [("Dockerfile", DOCKERFILE), ("demo.sh", SCRIPT)];
    docker::ensure_image(docker, IMAGE, &files, "demo", &|_, _| {}).await?;
    let port = PORTS
        .into_iter()
        .find(|p| TcpListener::bind(("0.0.0.0", *p)).is_ok())
        .ok_or_else(|| format!("No free port between {} and {} for the gateway", PORTS.start, PORTS.end - 1))?;

    for (name, calls) in SERVICES {
        let (source, env, container) = match name {
            "redis" => {
                report("pull", format!("Getting {REDIS}"));
                (ServiceSource::Image { image: REDIS.into() }, vec![], 6379)
            }
            _ => (ServiceSource::Image { image: IMAGE.into() }, vec![format!("DEMO_ROLE={name}")], 8080),
        };
        report("start", format!("Starting {name}"));
        let req = AddServiceRequest {
            network: network.into(),
            name: name.into(),
            source,
            env,
            ports: vec![PortRequest { container, host: (name == "gateway").then_some(port) }],
            depends_on: calls.iter().map(|c| c.to_string()).collect(),
        };
        docker::add_service(docker, req, &|_, _| {}).await?;
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process;
    use crate::trace::{now_ms, remove_sniffers, trace_logs, trace_prepare, trace_query};
    use bollard::query_parameters::{ListContainersOptionsBuilder, LogsOptions};
    use futures_util::StreamExt;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::time::Duration;

    fn send(port: u16, method: &str, path: &str, body: &str) -> String {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connects");
        s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
        write!(
            s,
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    /// Sets the demo up on a network of its own, then checks each request's
    /// trace: blue all the way for a list, red at `payments` for a booking.
    /// Run with `cargo test -- --ignored --nocapture live_`.
    #[test]
    #[ignore = "needs a running Docker engine and the redis image"]
    fn live_demo_traces_its_calls() {
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().identifier = "dev.uat.test".into();
        let app = tauri::test::mock_builder().manage(process::Processes::default()).build(ctx).unwrap();
        let app = app.handle().clone();
        let network = format!("uat-demo-test-{}", std::process::id());

        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                tauri::async_runtime::block_on(async {
                    let _ = remove_sniffers().await;
                    if let Ok(docker) = docker::docker().await {
                        let mut filters = HashMap::new();
                        filters.insert("network", vec![self.0.as_str()]);
                        let options = ListContainersOptionsBuilder::new().all(true).filters(&filters).build();
                        for c in docker.list_containers(Some(options)).await.unwrap_or_default() {
                            let force = RemoveContainerOptionsBuilder::default().force(true).build();
                            let _ = docker.remove_container(c.id.as_deref().unwrap_or_default(), Some(force)).await;
                        }
                        let _ = docker.remove_network(&self.0).await;
                    }
                });
            }
        }
        let _cleanup = Cleanup(network.clone());

        let outcome = tauri::async_runtime::block_on(async {
            let docker = docker::docker().await?;
            let port = set_up(&docker, &network, &|stage, line| println!("{stage}: {line}")).await?;
            // A second time finds it running
            assert_eq!(set_up(&docker, &network, &|_, _| {}).await?, port);
            for name in ["users", "orders", "gateway"] {
                let id = format!("{network}-{name}");
                for _ in 0..40 {
                    if docker.logs(&id, Some(LogsOptions { stderr: true, ..Default::default() })).count().await > 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }

            let entry = trace_prepare(app.clone(), format!("http://localhost:{port}/rides")).await?.ok_or("no entry")?;
            let entry = serde_json::to_value(&entry).unwrap();
            assert_eq!(entry, json!({ "network": network, "service": "gateway", "kind": "container", "watching": true }));

            // Each call's hops, as from → to: state, the requests' statuses
            let traced = |method: &'static str, path: &'static str, body: &'static str| {
                let app = app.clone();
                let network = network.clone();
                async move {
                    let t0 = now_ms();
                    let reply = tokio::task::spawn_blocking(move || send(port, method, path, body)).await.unwrap();
                    let t1 = now_ms();
                    tokio::time::sleep(Duration::from_millis(900)).await;
                    let trace = trace_query(app.clone(), network.clone(), "gateway".into(), t0, t1 + 700).await?;
                    let trace = serde_json::to_value(&trace).unwrap();
                    let mut hops: HashMap<String, Value> = HashMap::new();
                    for h in trace["hops"].as_array().unwrap() {
                        let statuses: Vec<_> = h["requests"].as_array().unwrap().iter().map(|r| r["status"].clone()).collect();
                        println!("{method} {path}: {} → {} {} {} {:?}", h["from"], h["to"], h["state"], h["error"], statuses);
                        hops.insert(
                            format!("{} → {}", h["from"].as_str().unwrap(), h["to"].as_str().unwrap()),
                            json!({ "state": h["state"], "error": h["error"], "statuses": statuses }),
                        );
                    }
                    let logs = trace_logs(app, network, vec!["gateway".into(), "orders".into()], t0, t1 + 700).await?;
                    let logs = serde_json::to_value(&logs).unwrap().to_string();
                    Ok::<_, String>((reply, hops, logs))
                }
            };

            let (reply, hops, logs) = traced("GET", "/rides", "").await?;
            assert!(reply.starts_with("HTTP/1.1 200") && reply.contains("\"rides\""), "{reply}");
            assert_eq!(hops["gateway → orders"], json!({ "state": "ok", "error": null, "statuses": [200] }));
            assert_eq!(hops["gateway → users"], json!({ "state": "ok", "error": null, "statuses": [200] }));
            assert_eq!(hops["orders → redis"]["state"], "ok");
            assert_eq!(hops.len(), 3, "{hops:?}");
            assert!(logs.contains("GET /orders?rider=7"), "{logs}");

            let (reply, hops, logs) = traced("POST", "/rides", r#"{"from":"Maarif","to":"Anfa"}"#).await?;
            assert!(reply.starts_with("HTTP/1.1 502"), "{reply}");
            assert_eq!(hops["gateway → orders"], json!({ "state": "ok", "error": null, "statuses": [502] }));
            assert_eq!(hops["orders → redis"]["state"], "ok");
            let payments = &hops["orders → payments"];
            assert_eq!((&payments["state"], &payments["error"]), (&json!("unresolved"), &json!(format!("Not found on {network}"))));
            assert!(logs.contains("✕ POST http://payments:8080/charges"), "{logs}");

            let (reply, hops, _) = traced("GET", "/health", "").await?;
            assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
            assert!(hops.is_empty(), "{hops:?}");
            Ok::<_, String>(())
        });

        outcome.expect("the demo's calls are traced");
    }
}
