//! Docker engine access over its local socket (bollard), so the app works
//! without the `docker` CLI on PATH, which macOS GUI apps don't inherit.
//!
//! Every service the app adds joins one user-defined bridge network with an
//! alias equal to its service name, so the containers on that network reach
//! each other by name (`postgres:5432`, `redis:6379`).

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use bollard::models::{
    ContainerCreateBody, ContainerSummary, EndpointSettings, HostConfig, NetworkConnectRequest,
    NetworkCreateRequest, NetworkingConfig, PortBinding,
};
use bollard::query_parameters::{
    BuildImageOptionsBuilder, CreateContainerOptionsBuilder, CreateImageOptionsBuilder,
    ListContainersOptionsBuilder, ListNetworksOptionsBuilder, LogsOptionsBuilder,
    RemoveContainerOptionsBuilder, StopContainerOptionsBuilder,
};
use bollard::{body_full, Docker, API_DEFAULT_VERSION};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const DEFAULT_NETWORK: &str = "uat-net";
const PROGRESS_EVENT: &str = "docker://progress";

pub(crate) const LABEL_MANAGED: &str = "uat.managed";
pub(crate) const LABEL_SERVICE: &str = "uat.service";
pub(crate) const LABEL_KIND: &str = "uat.kind";
pub(crate) const LABEL_SOURCE: &str = "uat.source";
/// The Dockerfile a service was built from, inside its context, when not ./Dockerfile
pub(crate) const LABEL_DOCKERFILE: &str = "uat.dockerfile";
pub(crate) const LABEL_DEPENDS_ON: &str = "uat.depends_on";

pub(crate) type CmdResult<T> = Result<T, String>;

pub(crate) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// `~/code/app` → `/Users/me/code/app`; the dialog gives absolute paths, people type `~`.
pub(crate) fn expand_home(path: &str) -> PathBuf {
    let path = path.trim();
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with('/') => {
            PathBuf::from(home).join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(path),
    }
}

// ---------------------------------------------------------------------------
// Connection

fn socket_candidates() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(host) = std::env::var("DOCKER_HOST") {
        if let Some(path) = host.strip_prefix("unix://") {
            out.push(path.to_string());
        }
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for rel in [
            ".docker/run/docker.sock",
            ".orbstack/run/docker.sock",
            ".colima/default/docker.sock",
            ".rd/docker.sock",
        ] {
            out.push(home.join(rel).to_string_lossy().into_owned());
        }
    }
    out.push("/var/run/docker.sock".to_string());
    out
}

async fn connect() -> CmdResult<(Docker, String)> {
    let path = socket_candidates()
        .into_iter()
        .find(|p| Path::new(p).exists())
        .ok_or_else(|| "Docker engine not found. Start Docker Desktop, OrbStack or Colima.".to_string())?;
    let docker = Docker::connect_with_socket(&path, 120, API_DEFAULT_VERSION).map_err(err)?;
    // Talk the daemon's API version, not ours, so older engines still answer.
    let docker = docker.negotiate_version().await.map_err(|e| {
        format!("Docker engine at {path} is not responding: {e}")
    })?;
    Ok((docker, path))
}

pub(crate) async fn docker() -> CmdResult<Docker> {
    connect().await.map(|(d, _)| d)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    connected: bool,
    socket: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn docker_status() -> EngineStatus {
    match connect().await {
        Ok((docker, socket)) => {
            let version = docker.version().await.ok().and_then(|v| v.version);
            EngineStatus { connected: true, socket: Some(socket), version, error: None }
        }
        Err(e) => EngineStatus { connected: false, socket: None, version: None, error: Some(e) },
    }
}

// ---------------------------------------------------------------------------
// Networks

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    id: String,
    name: String,
    driver: String,
    managed: bool,
}

#[tauri::command]
pub async fn docker_networks() -> CmdResult<Vec<NetworkInfo>> {
    let docker = docker().await?;
    ensure_network(&docker, DEFAULT_NETWORK).await?;
    let networks = docker
        .list_networks(Some(ListNetworksOptionsBuilder::new().build()))
        .await
        .map_err(err)?;
    let mut out: Vec<NetworkInfo> = networks
        .into_iter()
        .filter_map(|n| {
            let name = n.name?;
            // The engine's own networks can't take aliases; only list user-defined bridges.
            if matches!(name.as_str(), "bridge" | "host" | "none") {
                return None;
            }
            let managed = n.labels.as_ref().is_some_and(|l| l.contains_key(LABEL_MANAGED));
            Some(NetworkInfo {
                id: n.id.unwrap_or_default(),
                name,
                driver: n.driver.unwrap_or_default(),
                managed,
            })
        })
        .collect();
    out.sort_by(|a, b| (b.name == DEFAULT_NETWORK).cmp(&(a.name == DEFAULT_NETWORK)).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[tauri::command]
pub async fn docker_create_network(name: String) -> CmdResult<()> {
    let docker = docker().await?;
    ensure_network(&docker, name.trim()).await
}

async fn ensure_network(docker: &Docker, name: &str) -> CmdResult<()> {
    if name.is_empty() {
        return Err("Network name is empty".into());
    }
    let mut filters = HashMap::new();
    filters.insert("name", vec![name]);
    let existing = docker
        .list_networks(Some(ListNetworksOptionsBuilder::new().filters(&filters).build()))
        .await
        .map_err(err)?;
    // The name filter matches substrings; check for the exact one.
    if existing.iter().any(|n| n.name.as_deref() == Some(name)) {
        return Ok(());
    }
    docker
        .create_network(NetworkCreateRequest {
            name: name.to_string(),
            driver: Some("bridge".into()),
            attachable: Some(true),
            labels: Some(HashMap::from([(LABEL_MANAGED.to_string(), "true".to_string())])),
            ..Default::default()
        })
        .await
        .map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Services (containers on a network)

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub(crate) container: u16,
    pub(crate) host: Option<u16>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub(crate) id: String,
    pub(crate) name: String,
    container_name: String,
    image: String,
    pub(crate) state: String,
    status: String,
    pub(crate) ports: Vec<PortInfo>,
    depends_on: Vec<String>,
    /// "dockerfile" | "image" | "external" (attached, not created by the app)
    kind: String,
    source: Option<String>,
    managed: bool,
}

fn to_service(c: ContainerSummary) -> Service {
    let labels = c.labels.unwrap_or_default();
    let container_name = c
        .names
        .and_then(|n| n.into_iter().next())
        .map(|n| n.trim_start_matches('/').to_string())
        .unwrap_or_default();
    let name = labels.get(LABEL_SERVICE).cloned().unwrap_or_else(|| container_name.clone());
    let mut seen = BTreeSet::new();
    let ports = c
        .ports
        .unwrap_or_default()
        .into_iter()
        // IPv4 and IPv6 bindings come back as two entries for one port.
        .filter(|p| seen.insert((p.private_port, p.public_port)))
        .map(|p| PortInfo { container: p.private_port, host: p.public_port })
        .collect();
    let depends_on = labels
        .get(LABEL_DEPENDS_ON)
        .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    Service {
        id: c.id.unwrap_or_default(),
        name,
        container_name,
        image: c.image.unwrap_or_default(),
        state: c.state.map(|s| s.to_string()).unwrap_or_default(),
        status: c.status.unwrap_or_default(),
        ports,
        depends_on,
        kind: labels.get(LABEL_KIND).cloned().unwrap_or_else(|| "external".into()),
        source: labels.get(LABEL_SOURCE).cloned(),
        managed: labels.contains_key(LABEL_MANAGED),
    }
}

#[tauri::command]
pub async fn docker_services(network: String) -> CmdResult<Vec<Service>> {
    let docker = docker().await?;
    let mut filters = HashMap::new();
    filters.insert("network", vec![network.as_str()]);
    let list = docker
        .list_containers(Some(ListContainersOptionsBuilder::new().all(true).filters(&filters).build()))
        .await
        .map_err(err)?;
    let mut out: Vec<Service> = list.into_iter().map(to_service).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Containers not on `network`, for attaching ones started elsewhere (compose, CLI).
#[tauri::command]
pub async fn docker_other_containers(network: String) -> CmdResult<Vec<Service>> {
    let docker = docker().await?;
    let list = docker
        .list_containers(Some(ListContainersOptionsBuilder::new().all(true).build()))
        .await
        .map_err(err)?;
    let mut out: Vec<Service> = list
        .into_iter()
        .filter(|c| {
            !c.network_settings
                .as_ref()
                .and_then(|n| n.networks.as_ref())
                .is_some_and(|n| n.contains_key(&network))
        })
        .map(to_service)
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortRequest {
    pub(crate) container: u16,
    pub(crate) host: Option<u16>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ServiceSource {
    #[serde(rename_all = "camelCase")]
    Dockerfile { context: String, dockerfile: Option<String> },
    #[serde(rename_all = "camelCase")]
    Image { image: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddServiceRequest {
    pub(crate) network: String,
    pub(crate) name: String,
    pub(crate) source: ServiceSource,
    #[serde(default)]
    pub(crate) env: Vec<String>,
    #[serde(default)]
    pub(crate) ports: Vec<PortRequest>,
    #[serde(default)]
    pub(crate) depends_on: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    service: &'a str,
    stage: &'a str,
    line: String,
}

/// Where build and pull output goes: `(stage, line)`. The app sends it to
/// the window as events; tests just print it.
pub(crate) type Report<'a> = &'a (dyn Fn(&str, String) + Sync);

pub(crate) fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Builds (or pulls) the image, then creates and starts the container on the
/// network. Build and pull output streams as `docker://progress` events.
#[tauri::command]
pub async fn docker_add_service(app: AppHandle, req: AddServiceRequest) -> CmdResult<Service> {
    let name = req.name.trim().to_lowercase();
    let report = |stage: &str, line: String| {
        let _ = app.emit(PROGRESS_EVENT, Progress { service: &name, stage, line });
    };
    add_service(&docker().await?, req, &report).await
}

pub(crate) async fn add_service(docker: &Docker, req: AddServiceRequest, report: Report<'_>) -> CmdResult<Service> {
    let name = req.name.trim().to_lowercase();
    if !valid_name(&name) {
        return Err("Service name must start with a letter or digit and use only a-z, 0-9, - _ .".into());
    }
    ensure_network(docker, &req.network).await?;

    let mut dockerfile_label = None;
    let (image, kind, source) = match &req.source {
        ServiceSource::Dockerfile { context, dockerfile } => {
            let tag = format!("uat/{name}:latest");
            let context = expand_home(context);
            build_image(report, docker, &context, dockerfile.as_deref(), &tag).await?;
            dockerfile_label = dockerfile.as_deref().map(str::trim).filter(|d| !d.is_empty() && *d != "Dockerfile").map(String::from);
            (tag, "dockerfile", context.display().to_string())
        }
        ServiceSource::Image { image } => {
            let image = image.trim().to_string();
            pull_if_missing(report, docker, &image).await?;
            (image.clone(), "image", image)
        }
    };

    report("create", format!("Creating container on {}", req.network));
    let container_name = format!("{}-{}", req.network, name);
    let mut port_bindings = HashMap::new();
    let mut exposed = Vec::new();
    for p in &req.ports {
        let key = format!("{}/tcp", p.container);
        exposed.push(key.clone());
        if let Some(host) = p.host {
            port_bindings.insert(
                key,
                Some(vec![PortBinding { host_ip: None, host_port: Some(host.to_string()) }]),
            );
        }
    }
    let mut labels = HashMap::from([
        (LABEL_MANAGED.to_string(), "true".to_string()),
        (LABEL_SERVICE.to_string(), name.clone()),
        (LABEL_KIND.to_string(), kind.to_string()),
        (LABEL_SOURCE.to_string(), source),
    ]);
    if !req.depends_on.is_empty() {
        labels.insert(LABEL_DEPENDS_ON.to_string(), req.depends_on.join(","));
    }
    if let Some(d) = dockerfile_label {
        labels.insert(LABEL_DOCKERFILE.to_string(), d);
    }
    let body = ContainerCreateBody {
        image: Some(image),
        env: Some(req.env.into_iter().filter(|e| e.contains('=')).collect()),
        labels: Some(labels),
        exposed_ports: (!exposed.is_empty()).then_some(exposed),
        host_config: Some(HostConfig {
            network_mode: Some(req.network.clone()),
            port_bindings: (!port_bindings.is_empty()).then_some(port_bindings),
            ..Default::default()
        }),
        networking_config: Some(NetworkingConfig {
            endpoints_config: Some(HashMap::from([(
                req.network.clone(),
                EndpointSettings { aliases: Some(vec![name.clone()]), ..Default::default() },
            )])),
        }),
        ..Default::default()
    };
    let created = docker
        .create_container(Some(CreateContainerOptionsBuilder::new().name(&container_name).build()), body)
        .await
        .map_err(err)?;

    report("start", "Starting".into());
    docker.start_container(&created.id, None).await.map_err(err)?;
    report("done", "Running".into());

    let mut filters = HashMap::new();
    filters.insert("id", vec![created.id.as_str()]);
    docker
        .list_containers(Some(ListContainersOptionsBuilder::new().all(true).filters(&filters).build()))
        .await
        .map_err(err)?
        .into_iter()
        .next()
        .map(to_service)
        .ok_or_else(|| "Container was created but could not be found".to_string())
}

async fn build_image(
    report: Report<'_>,
    docker: &Docker,
    context_dir: &Path,
    dockerfile: Option<&str>,
    tag: &str,
) -> CmdResult<()> {
    let dockerfile = dockerfile.filter(|d| !d.is_empty()).unwrap_or("Dockerfile").to_string();
    if !context_dir.join(&dockerfile).is_file() {
        return Err(format!("No {dockerfile} in {}", context_dir.display()));
    }
    report("context", format!("Packing build context {}", context_dir.display()));
    let dir = context_dir.to_path_buf();
    let tar = tauri::async_runtime::spawn_blocking(move || pack_context(&dir))
        .await
        .map_err(err)??;
    build_from_tar(report, docker, tar, &dockerfile, tag).await
}

async fn build_from_tar(
    report: Report<'_>,
    docker: &Docker,
    tar: Vec<u8>,
    dockerfile: &str,
    tag: &str,
) -> CmdResult<()> {
    report("build", format!("Sending {} of context to the engine", human_size(tar.len())));
    let options = BuildImageOptionsBuilder::default().dockerfile(dockerfile).t(tag).rm(true).build();
    let mut stream = docker.build_image(options, None, Some(body_full(tar.into())));
    while let Some(item) = stream.next().await {
        let info = item.map_err(err)?;
        if let Some(detail) = info.error_detail {
            return Err(detail.message.unwrap_or_else(|| "Build failed".into()));
        }
        if let Some(line) = info.stream.or(info.status) {
            let line = line.trim_end();
            if !line.is_empty() {
                report("build", line.to_string());
            }
        }
    }
    Ok(())
}

/// Tars the build context the way the docker CLI does, honoring `.dockerignore`.
fn pack_context(dir: &Path) -> CmdResult<Vec<u8>> {
    let mut builder = tar::Builder::new(Vec::new());
    builder.follow_symlinks(false);
    let walker = ignore::WalkBuilder::new(dir)
        .standard_filters(false)
        .hidden(false)
        .add_custom_ignore_filename(".dockerignore")
        .build();
    for entry in walker {
        let entry = entry.map_err(err)?;
        let path = entry.path();
        let rel = path.strip_prefix(dir).map_err(err)?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let file_type = entry.file_type();
        if file_type.is_some_and(|t| t.is_dir()) {
            builder.append_dir(rel, path).map_err(err)?;
        } else {
            builder.append_path_with_name(path, rel).map_err(err)?;
        }
    }
    builder.into_inner().map_err(err)
}

pub(crate) fn human_size(bytes: usize) -> String {
    match bytes {
        b if b >= 1 << 20 => format!("{:.1} MB", b as f64 / (1 << 20) as f64),
        b if b >= 1 << 10 => format!("{:.1} kB", b as f64 / (1 << 10) as f64),
        b => format!("{b} B"),
    }
}

async fn pull_if_missing(report: Report<'_>, docker: &Docker, image: &str) -> CmdResult<()> {
    if image.is_empty() {
        return Err("Image is empty".into());
    }
    if docker.inspect_image(image).await.is_ok() {
        return Ok(());
    }
    report("pull", format!("Pulling {image}"));
    let options = CreateImageOptionsBuilder::new().from_image(image).build();
    let mut stream = docker.create_image(Some(options), None, None);
    while let Some(item) = stream.next().await {
        let info = item.map_err(err)?;
        if let Some(detail) = info.error_detail {
            return Err(detail.message.unwrap_or_else(|| "Pull failed".into()));
        }
        if let Some(status) = info.status {
            let line = match info.id {
                Some(id) => format!("{id}: {status}"),
                None => status,
            };
            report("pull", line);
        }
    }
    Ok(())
}

/// Puts an existing container on the network, reachable by `alias`.
#[tauri::command]
pub async fn docker_attach(container: String, network: String, alias: String) -> CmdResult<()> {
    let docker = docker().await?;
    ensure_network(&docker, &network).await?;
    let alias = alias.trim();
    docker
        .connect_network(
            &network,
            NetworkConnectRequest {
                container,
                endpoint_config: Some(EndpointSettings {
                    aliases: (!alias.is_empty()).then(|| vec![alias.to_string()]),
                    ..Default::default()
                }),
            },
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn docker_start(id: String) -> CmdResult<()> {
    docker().await?.start_container(&id, None).await.map_err(err)
}

#[tauri::command]
pub async fn docker_stop(id: String) -> CmdResult<()> {
    let options = StopContainerOptionsBuilder::new().t(5).build();
    docker().await?.stop_container(&id, Some(options)).await.map_err(err)
}

/// Removes a container the app created. Attached containers are only
/// disconnected from the network, never deleted.
#[tauri::command]
pub async fn docker_remove(id: String, network: String) -> CmdResult<()> {
    let docker = docker().await?;
    let mut filters = HashMap::new();
    filters.insert("id", vec![id.as_str()]);
    let managed = docker
        .list_containers(Some(ListContainersOptionsBuilder::new().all(true).filters(&filters).build()))
        .await
        .map_err(err)?
        .first()
        .and_then(|c| c.labels.as_ref())
        .is_some_and(|l| l.contains_key(LABEL_MANAGED));
    if managed {
        let options = RemoveContainerOptionsBuilder::default().force(true).build();
        docker.remove_container(&id, Some(options)).await.map_err(err)
    } else {
        docker
            .disconnect_network(
                &network,
                bollard::models::NetworkDisconnectRequest { container: id, force: Some(false) },
            )
            .await
            .map_err(err)
    }
}

#[tauri::command]
pub async fn docker_logs(id: String, tail: Option<u32>) -> CmdResult<String> {
    let docker = docker().await?;
    let tail = tail.unwrap_or(300).to_string();
    let options = LogsOptionsBuilder::new().stdout(true).stderr(true).tail(&tail).build();
    let mut stream = docker.logs(&id, Some(options));
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        out.push_str(&item.map_err(err)?.to_string());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Proxies: a command running on the Mac joins a network through a small
// container that holds its name there and forwards each port to the host.

const PROXY_IMAGE: &str = "uat/proxy:1";
const PROXY_DOCKERFILE: &str = "FROM alpine:3.20\nRUN apk add --no-cache socat\n";
const LABEL_PROCESS: &str = "uat.process";

pub(crate) struct ProxySpec<'a> {
    pub process_id: &'a str,
    pub network: &'a str,
    pub name: &'a str,
    pub source: &'a str,
    pub ports: &'a [u16],
    pub depends_on: &'a [String],
}

/// Starts (or replaces) the proxy that makes `spec.name:port` on the network
/// forward to `port` on the Mac.
pub(crate) async fn ensure_proxy(spec: ProxySpec<'_>, report: Report<'_>) -> CmdResult<()> {
    let docker = docker().await?;
    ensure_network(&docker, spec.network).await?;
    ensure_image(&docker, PROXY_IMAGE, &[("Dockerfile", PROXY_DOCKERFILE)], "network proxy", report).await?;

    // The name must be free on the network, except for this process's own old proxy
    let services = docker_services(spec.network.to_string()).await?;
    if let Some(taken) = services.iter().find(|s| s.name == spec.name && s.kind != "process") {
        return Err(format!("{} is already taken on {} by {}", spec.name, spec.network, taken.container_name));
    }
    let container_name = format!("{}-{}", spec.network, spec.name);
    if let Ok(existing) = docker.inspect_container(&container_name, None).await {
        let is_proxy = existing
            .config
            .and_then(|c| c.labels)
            .is_some_and(|l| l.get(LABEL_KIND).map(String::as_str) == Some("process"));
        if !is_proxy {
            return Err(format!("A container named {container_name} already exists"));
        }
        let options = RemoveContainerOptionsBuilder::default().force(true).build();
        docker.remove_container(&container_name, Some(options)).await.map_err(err)?;
    }

    let forward = spec
        .ports
        .iter()
        .map(|p| format!("socat tcp-listen:{p},fork,reuseaddr tcp-connect:host.docker.internal:{p} &"))
        .collect::<Vec<_>>()
        .join(" ");
    let mut labels = HashMap::from([
        (LABEL_MANAGED.to_string(), "true".to_string()),
        (LABEL_SERVICE.to_string(), spec.name.to_string()),
        (LABEL_KIND.to_string(), "process".to_string()),
        (LABEL_SOURCE.to_string(), spec.source.to_string()),
        (LABEL_PROCESS.to_string(), spec.process_id.to_string()),
    ]);
    if !spec.depends_on.is_empty() {
        labels.insert(LABEL_DEPENDS_ON.to_string(), spec.depends_on.join(","));
    }
    let body = ContainerCreateBody {
        image: Some(PROXY_IMAGE.into()),
        entrypoint: Some(vec!["sh".into(), "-c".into()]),
        cmd: Some(vec![format!("{forward} wait")]),
        labels: Some(labels),
        exposed_ports: Some(spec.ports.iter().map(|p| format!("{p}/tcp")).collect()),
        host_config: Some(HostConfig {
            network_mode: Some(spec.network.to_string()),
            extra_hosts: Some(vec!["host.docker.internal:host-gateway".into()]),
            ..Default::default()
        }),
        networking_config: Some(NetworkingConfig {
            endpoints_config: Some(HashMap::from([(
                spec.network.to_string(),
                EndpointSettings { aliases: Some(vec![spec.name.to_string()]), ..Default::default() },
            )])),
        }),
        ..Default::default()
    };
    let created = docker
        .create_container(Some(CreateContainerOptionsBuilder::new().name(&container_name).build()), body)
        .await
        .map_err(err)?;
    docker.start_container(&created.id, None).await.map_err(err)
}

/// Builds one of the app's own small images from files held in the app (a
/// `Dockerfile` and what it copies), unless it's there already.
pub(crate) async fn ensure_image(
    docker: &Docker,
    tag: &str,
    files: &[(&str, &str)],
    what: &str,
    report: Report<'_>,
) -> CmdResult<()> {
    if docker.inspect_image(tag).await.is_ok() {
        return Ok(());
    }
    report("build", format!("Building the {what} image (first time only)"));
    let mut tar = tar::Builder::new(Vec::new());
    for (name, text) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(text.len() as u64);
        header.set_mode(if name.ends_with(".sh") { 0o755 } else { 0o644 });
        header.set_cksum();
        tar.append_data(&mut header, name, text.as_bytes()).map_err(err)?;
    }
    let tar = tar.into_inner().map_err(err)?;
    build_from_tar(report, docker, tar, "Dockerfile", tag).await
}

/// Removes the proxies of one process, or of every process when `None`.
pub(crate) async fn remove_proxies(process_id: Option<&str>) -> CmdResult<()> {
    let process = process_id.map(|id| format!("{LABEL_PROCESS}={id}"));
    remove_kind("process", process.as_deref()).await
}

/// Removes the app's helper containers of one `uat.kind`, narrowed by one
/// more `label=value` when given.
pub(crate) async fn remove_kind(kind: &str, label: Option<&str>) -> CmdResult<()> {
    let docker = docker().await?;
    let kind = format!("{LABEL_KIND}={kind}");
    let mut labels = vec![kind.as_str()];
    if let Some(l) = label {
        labels.push(l);
    }
    let mut filters = HashMap::new();
    filters.insert("label", labels);
    let list = docker
        .list_containers(Some(ListContainersOptionsBuilder::new().all(true).filters(&filters).build()))
        .await
        .map_err(err)?;
    for c in list {
        if let Some(id) = c.id {
            let options = RemoveContainerOptionsBuilder::default().force(true).build();
            docker.remove_container(&id, Some(options)).await.map_err(err)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Dockerfile lookup (filesystem only, no engine needed)

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerfileInfo {
    found: bool,
    dockerfile: String,
    from: Option<String>,
    exposes: Vec<u16>,
    suggested_name: String,
}

/// A folder's name as a service name: `Rides API` → `rides-api`.
pub(crate) fn folder_name(dir: &Path) -> String {
    dir.file_name()
        .map(|n| {
            n.to_string_lossy()
                .to_lowercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn docker_inspect_dockerfile(context: String, dockerfile: Option<String>) -> DockerfileInfo {
    let dir = expand_home(&context);
    let dockerfile = dockerfile.filter(|d| !d.is_empty()).unwrap_or_else(|| "Dockerfile".into());
    let suggested_name = folder_name(&dir);
    let Ok(text) = std::fs::read_to_string(dir.join(&dockerfile)) else {
        return DockerfileInfo { found: false, dockerfile, from: None, exposes: vec![], suggested_name };
    };
    let mut from = None;
    let mut exposes = Vec::new();
    for line in text.lines().map(str::trim) {
        let mut words = line.split_whitespace();
        match words.next().map(str::to_ascii_uppercase).as_deref() {
            // The last FROM is the stage that runs.
            Some("FROM") => from = words.find(|w| !w.starts_with("--")).map(String::from),
            Some("EXPOSE") => exposes.extend(
                words.filter_map(|w| w.split('/').next().and_then(|p| p.parse::<u16>().ok())),
            ),
            _ => {}
        }
    }
    DockerfileInfo { found: true, dockerfile, from, exposes, suggested_name }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("uat-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_the_running_stage_and_exposed_ports() {
        let dir = temp_dir("dockerfile");
        std::fs::write(
            dir.join("Dockerfile"),
            "FROM --platform=linux/amd64 node:20 AS build\nRUN npm ci\nFROM node:20-alpine\nEXPOSE 3000 9229/tcp\n",
        )
        .unwrap();
        let info = docker_inspect_dockerfile(dir.display().to_string(), None);
        assert!(info.found);
        assert_eq!(info.from.as_deref(), Some("node:20-alpine"));
        assert_eq!(info.exposes, vec![3000, 9229]);
        assert!(info.suggested_name.starts_with("uat-test-dockerfile"));

        let missing = docker_inspect_dockerfile(dir.display().to_string(), Some("Dockerfile.dev".into()));
        assert!(!missing.found);
    }

    #[test]
    fn build_context_honors_dockerignore() {
        let dir = temp_dir("context");
        std::fs::write(dir.join("Dockerfile"), "FROM scratch\n").unwrap();
        std::fs::write(dir.join(".dockerignore"), "node_modules\n*.log\n").unwrap();
        std::fs::write(dir.join("debug.log"), "x").unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), "x").unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.js"), "x").unwrap();

        let tar = pack_context(&dir).unwrap();
        let mut archive = tar::Archive::new(tar.as_slice());
        let names: Vec<String> = archive
            .entries()
            .unwrap()
            .map(|e| e.unwrap().path().unwrap().display().to_string())
            .collect();
        assert!(names.contains(&"Dockerfile".to_string()));
        assert!(names.contains(&"src/main.js".to_string()));
        assert!(!names.iter().any(|n| n.contains("node_modules") || n.ends_with(".log")), "{names:?}");
    }

    #[test]
    fn expands_home() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(expand_home("~/code/app"), PathBuf::from(&home).join("code/app"));
        assert_eq!(expand_home("~"), PathBuf::from(&home));
        assert_eq!(expand_home("/abs/path"), PathBuf::from("/abs/path"));
        assert_eq!(expand_home("~other/x"), PathBuf::from("~other/x"));
    }

    /// Against the local engine, so not part of a normal run:
    /// `cargo test -- --ignored --nocapture live_`. Uses `redis:7-alpine`
    /// (pulled if missing) and removes everything it creates.
    #[tokio::test]
    #[ignore]
    async fn live_services_reach_each_other_by_name() {
        let docker = docker().await.expect("a running Docker engine");
        let network = format!("uat-test-{}", std::process::id());
        let probe = format!("probe-{}", std::process::id());
        let report = |stage: &str, line: String| println!("[{stage}] {line}");

        let dir = temp_dir("probe");
        std::fs::write(
            dir.join("Dockerfile"),
            "FROM redis:7-alpine\nCMD [\"sh\", \"-c\", \"until redis-cli -h redis ping; do sleep 1; done; sleep 600\"]\n",
        )
        .unwrap();

        let outcome = async {
            let redis = add_service(
                &docker,
                AddServiceRequest {
                    network: network.clone(),
                    name: "redis".into(),
                    source: ServiceSource::Image { image: "redis:7-alpine".into() },
                    env: vec![],
                    ports: vec![PortRequest { container: 6379, host: None }],
                    depends_on: vec![],
                },
                &report,
            )
            .await?;
            let probe = add_service(
                &docker,
                AddServiceRequest {
                    network: network.clone(),
                    name: probe.clone(),
                    source: ServiceSource::Dockerfile { context: dir.display().to_string(), dockerfile: None },
                    env: vec!["GREETING=hi".into()],
                    ports: vec![],
                    depends_on: vec!["redis".into()],
                },
                &report,
            )
            .await?;
            assert_eq!(probe.kind, "dockerfile");
            assert_eq!(probe.depends_on, vec!["redis".to_string()]);

            let listed = docker_services(network.clone()).await?;
            let names: Vec<_> = listed.iter().map(|s| s.name.as_str()).collect();
            assert!(names.contains(&"redis") && names.contains(&probe.name.as_str()), "{names:?}");

            // The probe reaches redis by its alias on the network
            for _ in 0..30 {
                let logs = docker_logs(probe.id.clone(), Some(50)).await?;
                if logs.contains("PONG") {
                    return Ok::<_, String>(vec![redis.id, probe.id]);
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            Err(format!("probe never got PONG; logs: {}", docker_logs(probe.id, Some(50)).await?))
        }
        .await;

        // Clean up whatever was made, then report
        let mut filters = HashMap::new();
        filters.insert("network", vec![network.as_str()]);
        for c in docker
            .list_containers(Some(ListContainersOptionsBuilder::new().all(true).filters(&filters).build()))
            .await
            .unwrap_or_default()
        {
            let options = RemoveContainerOptionsBuilder::default().force(true).build();
            let _ = docker.remove_container(c.id.as_deref().unwrap_or_default(), Some(options)).await;
        }
        let _ = docker.remove_network(&network).await;
        let _ = docker
            .remove_image(&format!("uat/{probe}:latest"), None::<bollard::query_parameters::RemoveImageOptions>, None)
            .await;

        outcome.expect("services on one network reach each other by name");
    }

    /// A server on the Mac, bound to 127.0.0.1 like most dev servers, reached
    /// from a container by name through the proxy. Against the local engine:
    /// `cargo test -- --ignored --nocapture live_`.
    #[tokio::test]
    #[ignore]
    async fn live_host_process_is_reachable_by_name() {
        let docker = docker().await.expect("a running Docker engine");
        let pid = std::process::id();
        let network = format!("uat-ptest-{pid}");
        let name = format!("web-{pid}");
        let port = 18000 + (pid % 1000) as u16;
        let dir = temp_dir("web");
        std::fs::write(dir.join("marker.txt"), "hello from the mac").unwrap();
        let mut server = std::process::Command::new("python3")
            .args(["-m", "http.server", &port.to_string(), "--bind", "127.0.0.1"])
            .current_dir(&dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("python3");
        let report = |stage: &str, line: String| println!("[{stage}] {line}");

        let outcome = async {
            let spec = ProxySpec {
                process_id: "live-test",
                network: &network,
                name: &name,
                source: "test",
                ports: &[port],
                depends_on: &[],
            };
            ensure_proxy(spec, &report).await?;
            let client = format!("{network}-client");
            let fetch = format!(
                "for i in $(seq 1 20); do wget -qO- http://{name}:{port}/marker.txt && exit 0; sleep 0.5; done; exit 1"
            );
            docker
                .create_container(
                    Some(CreateContainerOptionsBuilder::new().name(&client).build()),
                    ContainerCreateBody {
                        image: Some("redis:7-alpine".into()),
                        entrypoint: Some(vec!["sh".into(), "-c".into()]),
                        cmd: Some(vec![fetch]),
                        host_config: Some(HostConfig { network_mode: Some(network.clone()), ..Default::default() }),
                        ..Default::default()
                    },
                )
                .await
                .map_err(err)?;
            docker.start_container(&client, None).await.map_err(err)?;
            let _ = docker.wait_container(&client, None).next().await;
            docker_logs(client, Some(20)).await
        }
        .await;

        let _ = server.kill();
        let mut filters = HashMap::new();
        filters.insert("network", vec![network.as_str()]);
        for c in docker
            .list_containers(Some(ListContainersOptionsBuilder::new().all(true).filters(&filters).build()))
            .await
            .unwrap_or_default()
        {
            let options = RemoveContainerOptionsBuilder::default().force(true).build();
            let _ = docker.remove_container(c.id.as_deref().unwrap_or_default(), Some(options)).await;
        }
        let _ = docker.remove_network(&network).await;

        let logs = outcome.expect("proxy and client run");
        assert!(logs.contains("hello from the mac"), "client got: {logs}");
    }

    #[test]
    fn service_names() {
        assert!(valid_name("rides-api"));
        assert!(valid_name("redis"));
        assert!(!valid_name("-bad"));
        assert!(!valid_name("has space"));
        assert!(!valid_name(""));
    }
}
