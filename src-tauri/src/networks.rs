//! Removing a network with what's on it: the containers UAT made there, the
//! commands that run as its services, and, when asked, the images and
//! volumes only those containers used. `network_plan` says what would go
//! and what stays, so the app and agents can show it before anything goes.

use std::collections::{BTreeMap, HashSet};

use bollard::models::{ContainerSummary, NetworkDisconnectRequest};
use bollard::query_parameters::{
    ListContainersOptionsBuilder, RemoveContainerOptionsBuilder, RemoveImageOptionsBuilder,
    RemoveVolumeOptionsBuilder,
};
use bollard::Docker;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::docker::{self, err, human_size, CmdResult, DEFAULT_NETWORK, LABEL_KIND, LABEL_MANAGED, LABEL_SERVICE};
use crate::{process, trace};

const PROGRESS_EVENT: &str = "network://progress";
/// The engine's own networks
const BUILT_IN: [&str; 3] = ["bridge", "host", "none"];
/// The app's helper images, which other networks use
const HELPER_IMAGES: [&str; 2] = ["uat/proxy:", "uat/sniff:"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanContainer {
    id: String,
    name: String,
    image: String,
    state: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanCommand {
    id: String,
    name: String,
    running: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanImage {
    id: String,
    /// Its tags, or the id when it has none
    names: Vec<String>,
    size: String,
    /// Why it stays: the containers that still use it
    kept: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanVolume {
    name: String,
    /// Made by an image's VOLUME, not named by anyone
    anonymous: bool,
    kept: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    network: String,
    /// UAT's default network: it's made again, empty
    recreated: bool,
    /// Removed: containers UAT made on this network
    containers: Vec<PlanContainer>,
    /// Only disconnected: containers started elsewhere, or made for another network
    attached: Vec<PlanContainer>,
    /// Stopped and deleted from UAT: commands run as this network's services
    commands: Vec<PlanCommand>,
    images: Vec<PlanImage>,
    volumes: Vec<PlanVolume>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    network: String,
    recreated: bool,
    containers: Vec<String>,
    disconnected: Vec<String>,
    commands: Vec<String>,
    images: Vec<String>,
    volumes: Vec<String>,
    /// What stayed, and why
    kept: Vec<String>,
}

fn name_of(c: &ContainerSummary) -> String {
    let labels = c.labels.clone().unwrap_or_default();
    labels.get(LABEL_SERVICE).cloned().unwrap_or_else(|| {
        c.names.as_ref().and_then(|n| n.first()).map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default()
    })
}

fn summary(c: &ContainerSummary) -> PlanContainer {
    PlanContainer {
        id: c.id.clone().unwrap_or_default(),
        name: name_of(c),
        image: c.image.clone().unwrap_or_default(),
        state: c.state.map(|s| s.to_string()).unwrap_or_default(),
    }
}

fn on(c: &ContainerSummary, network: &str) -> bool {
    c.network_settings.as_ref().and_then(|n| n.networks.as_ref()).is_some_and(|n| n.contains_key(network))
}

/// Made by UAT for this network, not attached to it
fn owned(c: &ContainerSummary, network: &str) -> bool {
    let labels = c.labels.as_ref();
    let managed = labels.is_some_and(|l| l.contains_key(LABEL_MANAGED));
    let home = c.host_config.as_ref().and_then(|h| h.network_mode.as_deref()) == Some(network);
    managed && home
}

fn is_proxy(c: &ContainerSummary) -> bool {
    c.labels.as_ref().and_then(|l| l.get(LABEL_KIND)).map(String::as_str) == Some("process")
}

fn volumes_of(c: &ContainerSummary) -> Vec<String> {
    c.mounts
        .iter()
        .flatten()
        .filter(|m| m.typ.as_deref() == Some("volume"))
        .filter_map(|m| m.name.clone())
        .collect()
}

fn anonymous(volume: &str) -> bool {
    volume.len() == 64 && volume.bytes().all(|b| b.is_ascii_hexdigit())
}

/// "used by a, b and 3 more"
fn used_by(names: &[String]) -> String {
    match names.len() {
        0 => String::new(),
        1..=3 => format!("used by {}", names.join(", ")),
        n => format!("used by {} and {} more", names[..3].join(", "), n - 3),
    }
}

async fn all_containers(docker: &Docker) -> CmdResult<Vec<ContainerSummary>> {
    docker
        .list_containers(Some(ListContainersOptionsBuilder::new().all(true).build()))
        .await
        .map_err(err)
}

async fn exists(docker: &Docker, network: &str) -> CmdResult<()> {
    if BUILT_IN.contains(&network) {
        return Err(format!("{network} is the engine's own network; it can't be removed."));
    }
    docker.inspect_network(network, None).await.map(|_| ()).map_err(|_| format!("There's no network called {network}."))
}

/// What removing `network` takes with it, and what stays
pub(crate) async fn plan<R: Runtime>(app: &AppHandle<R>, docker: &Docker, network: &str) -> CmdResult<Plan> {
    exists(docker, network).await?;
    let all = all_containers(docker).await?;
    let commands: Vec<PlanCommand> = process::refs(app)
        .into_iter()
        .filter(|p| p.network == network)
        .map(|p| PlanCommand { id: p.id, name: p.name, running: p.running })
        .collect();

    let mut containers = Vec::new();
    let mut attached = Vec::new();
    let mut going = HashSet::new();
    for c in all.iter().filter(|c| on(c, network)) {
        if owned(c, network) {
            going.insert(c.id.clone().unwrap_or_default());
            // A command's proxy goes with the command
            if !is_proxy(c) {
                containers.push(c);
            }
        } else {
            attached.push(summary(c));
        }
    }
    let staying: Vec<&ContainerSummary> = all.iter().filter(|c| !going.contains(c.id.as_deref().unwrap_or_default())).collect();

    // Images, by id: the ones these containers run
    let mut by_image: BTreeMap<String, String> = BTreeMap::new();
    for c in &containers {
        if let Some(id) = &c.image_id {
            by_image.entry(id.clone()).or_insert_with(|| c.image.clone().unwrap_or_default());
        }
    }
    let mut images = Vec::new();
    for (id, shown) in by_image {
        let inspected = docker.inspect_image(&id).await.ok();
        let mut names = inspected.as_ref().and_then(|i| i.repo_tags.clone()).unwrap_or_default();
        if names.is_empty() {
            names.push(if shown.is_empty() { id.clone() } else { shown });
        }
        if names.iter().any(|n| HELPER_IMAGES.iter().any(|h| n.starts_with(h))) {
            continue;
        }
        let users: Vec<String> = staying.iter().filter(|c| c.image_id.as_deref() == Some(&id)).map(|c| name_of(c)).collect();
        images.push(PlanImage {
            size: inspected.and_then(|i| i.size).map(|s| human_size(s.max(0) as usize)).unwrap_or_default(),
            id,
            names,
            kept: (!users.is_empty()).then(|| used_by(&users)),
        });
    }

    let mut seen = HashSet::new();
    let volumes = containers
        .iter()
        .flat_map(|c| volumes_of(c))
        .filter(|v| seen.insert(v.clone()))
        .map(|name| {
            let users: Vec<String> = staying.iter().filter(|c| volumes_of(c).contains(&name)).map(|c| name_of(c)).collect();
            PlanVolume { anonymous: anonymous(&name), kept: (!users.is_empty()).then(|| used_by(&users)), name }
        })
        .collect();

    Ok(Plan {
        network: network.to_string(),
        recreated: network == DEFAULT_NETWORK,
        containers: containers.into_iter().map(summary).collect(),
        attached,
        commands,
        images,
        volumes,
    })
}

/// Removes `network` as `plan` says, with its images and volumes when asked
pub(crate) async fn remove<R: Runtime>(
    app: &AppHandle<R>,
    docker: &Docker,
    network: &str,
    images: bool,
    volumes: bool,
    report: docker::Report<'_>,
) -> CmdResult<Removed> {
    let plan = plan(app, docker, network).await?;
    let mut out = Removed { network: network.to_string(), recreated: plan.recreated, ..Default::default() };

    // Its containers, the attached ones and the proxies included
    let on_it: Vec<String> = all_containers(docker)
        .await?
        .iter()
        .filter(|c| on(c, network))
        .filter_map(|c| c.id.clone())
        .collect();
    report("trace", "Stopping the trace on it".into());
    trace::unwatch(network, &on_it).await;

    for cmd in &plan.commands {
        report("command", format!("Stopping and deleting {}", cmd.name));
        process::process_delete(app.clone(), cmd.id.clone()).await?;
        out.commands.push(cmd.name.clone());
    }
    let force = || Some(RemoveContainerOptionsBuilder::default().force(true).build());
    for c in &plan.containers {
        report("container", format!("Removing {}", c.name));
        docker.remove_container(&c.id, force()).await.map_err(err)?;
        out.containers.push(c.name.clone());
    }
    // Proxies left without their command, from an earlier run
    for c in all_containers(docker).await? {
        if on(&c, network) && owned(&c, network) && is_proxy(&c) {
            let _ = docker.remove_container(c.id.as_deref().unwrap_or_default(), force()).await;
        }
    }
    for c in &plan.attached {
        report("container", format!("Disconnecting {}", c.name));
        let request = NetworkDisconnectRequest { container: c.id.clone(), force: Some(true) };
        docker.disconnect_network(network, request).await.map_err(err)?;
        out.disconnected.push(c.name.clone());
    }
    report("network", format!("Removing {network}"));
    docker.remove_network(network).await.map_err(err)?;

    for image in &plan.images {
        let label = image.names.join(", ");
        if !images {
            continue;
        }
        if let Some(why) = &image.kept {
            out.kept.push(format!("{label}: {why}"));
            continue;
        }
        report("image", format!("Removing {label}"));
        // By tag: an image with several can't be removed by id without force
        let mut failed = None;
        for name in &image.names {
            let options = RemoveImageOptionsBuilder::new().force(false).build();
            if let Err(e) = docker.remove_image(name, Some(options), None).await {
                failed = Some(err(e));
                break;
            }
        }
        match failed {
            Some(e) => out.kept.push(format!("{label}: {e}")),
            None => out.images.push(label),
        }
    }
    for volume in &plan.volumes {
        if !volumes {
            continue;
        }
        if let Some(why) = &volume.kept {
            out.kept.push(format!("volume {}: {why}", volume.name));
            continue;
        }
        report("volume", format!("Removing volume {}", volume.name));
        let options = RemoveVolumeOptionsBuilder::new().force(false).build();
        match docker.remove_volume(&volume.name, Some(options)).await {
            Ok(()) => out.volumes.push(volume.name.clone()),
            Err(e) => out.kept.push(format!("volume {}: {}", volume.name, err(e))),
        }
    }
    report("done", format!("Removed {network}"));
    Ok(out)
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    network: &'a str,
    line: String,
}

#[tauri::command]
pub async fn docker_network_plan(app: AppHandle, network: String) -> CmdResult<Plan> {
    plan(&app, &docker::docker().await?, network.trim()).await
}

#[tauri::command]
pub async fn docker_remove_network(app: AppHandle, network: String, images: bool, volumes: bool) -> CmdResult<Removed> {
    let network = network.trim().to_string();
    let report = |_: &str, line: String| {
        let _ = app.emit(PROGRESS_EVENT, Progress { network: &network, line });
    };
    remove(&app, &docker::docker().await?, &network, images, volumes, &report).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::{add_service, AddServiceRequest, ServiceSource};
    use bollard::models::ContainerCreateBody;
    use bollard::query_parameters::CreateContainerOptionsBuilder;
    use std::time::Duration;

    #[test]
    fn says_who_keeps_an_image() {
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(used_by(&names(&["redis"])), "used by redis");
        assert_eq!(used_by(&names(&["a", "b", "c", "d", "e"])), "used by a, b, c and 2 more");
        assert!(anonymous(&"ab".repeat(32)));
        assert!(!anonymous("rides-data"));
    }

    /// A throwaway network with a service built here (its image and its
    /// anonymous volume go with it), a container started elsewhere and
    /// attached (only disconnected), and a command with its proxy (stopped
    /// and deleted). Run with `cargo test -- --ignored --nocapture live_`.
    #[test]
    #[ignore = "needs a running Docker engine and the alpine:3.20 image"]
    fn live_removes_a_network_with_what_it_made() {
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().identifier = "dev.uat.test".into();
        let app = tauri::test::mock_builder().manage(process::Processes::default()).build(ctx).unwrap();
        let app = app.handle().clone();
        let pid = std::process::id();
        let network = format!("uat-remove-test-{pid}");
        let built = format!("rmtest{pid}");
        let outside = format!("uat-remove-test-outside-{pid}");
        let dir = std::env::temp_dir().join(format!("uat-remove-test-{pid}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Dockerfile"), "FROM alpine:3.20\nVOLUME /data\nCMD [\"sleep\", \"300\"]\n").unwrap();

        struct Cleanup(String, String, String, std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                tauri::async_runtime::block_on(async {
                    if let Ok(docker) = docker::docker().await {
                        let force = || Some(RemoveContainerOptionsBuilder::default().force(true).build());
                        for name in [self.2.clone(), format!("{}-{}", self.0, self.1), format!("{}-cmd", self.0)] {
                            let _ = docker.remove_container(&name, force()).await;
                        }
                        let _ = docker.remove_network(&self.0).await;
                        let _ = docker.remove_image(&format!("uat/{}:latest", self.1), None::<bollard::query_parameters::RemoveImageOptions>, None).await;
                    }
                });
                let _ = std::fs::remove_dir_all(&self.3);
            }
        }
        let _cleanup = Cleanup(network.clone(), built.clone(), outside.clone(), dir.clone());

        tauri::async_runtime::block_on(async {
            let docker = docker::docker().await.unwrap();
            let req = AddServiceRequest {
                network: network.clone(),
                name: built.clone(),
                source: ServiceSource::Dockerfile { context: dir.display().to_string(), dockerfile: None },
                env: vec![],
                ports: vec![],
                depends_on: vec![],
            };
            add_service(&docker, req, &|_, line| println!("{line}")).await.unwrap();

            let body = ContainerCreateBody {
                image: Some("alpine:3.20".into()),
                cmd: Some(vec!["sleep".into(), "300".into()]),
                ..Default::default()
            };
            docker.create_container(Some(CreateContainerOptionsBuilder::new().name(&outside).build()), body).await.unwrap();
            docker.start_container(&outside, None).await.unwrap();
            docker::docker_attach(outside.clone(), network.clone(), "outside".into()).await.unwrap();

            let def = serde_json::from_value(serde_json::json!({
                "network": network, "name": "cmd", "cwd": dir.display().to_string(), "command": "sleep 300", "ports": [8799]
            }))
            .unwrap();
            process::process_create(app.clone(), def).unwrap();
            let proxy = format!("{network}-cmd");
            for _ in 0..100 {
                if docker.inspect_container(&proxy, None).await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            assert!(docker.inspect_container(&proxy, None).await.is_ok(), "the command's proxy started");

            let plan = plan(&app, &docker, &network).await.unwrap();
            println!("{plan:#?}");
            assert_eq!(plan.containers.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), [built.as_str()]);
            assert_eq!(plan.attached.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), [outside.as_str()]);
            assert_eq!(plan.commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["cmd"]);
            assert_eq!(plan.images.len(), 1);
            assert_eq!(plan.images[0].names, [format!("uat/{built}:latest")]);
            assert!(plan.images[0].kept.is_none());
            assert_eq!(plan.volumes.len(), 1);
            assert!(plan.volumes[0].anonymous && plan.volumes[0].kept.is_none());
            let volume = plan.volumes[0].name.clone();

            let removed = remove(&app, &docker, &network, true, true, &|_, line| println!("{line}")).await.unwrap();
            println!("{removed:#?}");
            assert!(removed.kept.is_empty(), "{:?}", removed.kept);
            assert!(docker.inspect_network(&network, None).await.is_err(), "the network is gone");
            assert!(docker.inspect_container(&format!("{network}-{built}"), None).await.is_err(), "its container is gone");
            assert!(docker.inspect_container(&proxy, None).await.is_err(), "the proxy is gone");
            assert!(docker.inspect_image(&format!("uat/{built}:latest")).await.is_err(), "its image is gone");
            assert!(docker.inspect_volume(&volume).await.is_err(), "its volume is gone");
            assert!(process::refs(&app).iter().all(|p| p.network != network), "the command is deleted");
            let left = docker.inspect_container(&outside, None).await.unwrap();
            assert!(left.state.and_then(|s| s.running).unwrap_or(false), "the attached container still runs");
        });
    }
}
