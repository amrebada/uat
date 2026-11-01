//! What exporting and importing a network needs from this Mac: a snapshot
//! of its containers with the env each was given, which git repo a folder
//! is in, where a repo is cloned here, which host ports are taken, cloning
//! a repo, and reading and writing the file. Building the file and asking
//! about what doesn't travel happen in the window (`src/docker/share.ts`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use bollard::query_parameters::ListContainersOptionsBuilder;
use serde::Serialize;

use crate::docker::{
    self, err, expand_home, CmdResult, PortInfo, LABEL_DEPENDS_ON, LABEL_DOCKERFILE, LABEL_KIND, LABEL_MANAGED,
    LABEL_SERVICE, LABEL_SOURCE,
};

// ---------------------------------------------------------------------------
// A network's containers

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnapContainer {
    name: String,
    container_name: String,
    /// "dockerfile" | "image" | "attached"
    kind: String,
    image: String,
    /// The build context, for "dockerfile"
    context: Option<String>,
    dockerfile: Option<String>,
    /// What it was given, without what its image sets itself
    env: Vec<String>,
    ports: Vec<PortInfo>,
    depends_on: Vec<String>,
    /// Never pulled from a registry: another Mac can't get it
    image_local: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    home: String,
    user: String,
    host: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    network: String,
    containers: Vec<SnapContainer>,
    machine: Machine,
}

fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is large enough and NUL-terminated by gethostname
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let end = buf.iter().position(|&b| b == 0).unwrap_or(0);
    if ok { String::from_utf8_lossy(&buf[..end]).into_owned() } else { String::new() }
}

pub(crate) fn machine() -> Machine {
    Machine {
        home: std::env::var("HOME").unwrap_or_default(),
        user: std::env::var("USER").or_else(|_| std::env::var("LOGNAME")).unwrap_or_default(),
        host: hostname(),
    }
}

#[tauri::command]
pub async fn network_snapshot(network: String) -> CmdResult<Snapshot> {
    let docker = docker::docker().await?;
    let mut filters = HashMap::new();
    filters.insert("network", vec![network.as_str()]);
    let list = docker
        .list_containers(Some(ListContainersOptionsBuilder::new().all(true).filters(&filters).build()))
        .await
        .map_err(err)?;
    let mut containers = Vec::new();
    for c in list {
        let Some(id) = c.id.clone() else { continue };
        let labels = c.labels.clone().unwrap_or_default();
        let kind = labels.get(LABEL_KIND).map(String::as_str);
        // A command's proxy is exported as the command; sidecars aren't on the network
        if matches!(kind, Some("process" | "sniffer")) {
            continue;
        }
        let home = c.host_config.as_ref().and_then(|h| h.network_mode.as_deref()) == Some(network.as_str());
        let owned = labels.contains_key(LABEL_MANAGED) && home;
        let inspected = docker.inspect_container(&id, None).await.map_err(err)?;
        let config = inspected.config.unwrap_or_default();
        let image = config.image.clone().unwrap_or_else(|| c.image.clone().unwrap_or_default());
        let image_info = docker.inspect_image(c.image_id.as_deref().unwrap_or(&image)).await.ok();
        let image_env: HashSet<String> =
            image_info.as_ref().and_then(|i| i.config.as_ref()).and_then(|c| c.env.clone()).unwrap_or_default().into_iter().collect();
        let image_local = image_info.as_ref().is_some_and(|i| i.repo_digests.as_ref().is_none_or(|d| d.is_empty()));
        let container_name = c
            .names
            .as_ref()
            .and_then(|n| n.first())
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default();
        let mut seen = HashSet::new();
        containers.push(SnapContainer {
            name: labels.get(LABEL_SERVICE).cloned().unwrap_or_else(|| container_name.clone()),
            kind: if owned { kind.unwrap_or("image").to_string() } else { "attached".into() },
            context: (owned && kind == Some("dockerfile")).then(|| labels.get(LABEL_SOURCE).cloned()).flatten(),
            dockerfile: labels.get(LABEL_DOCKERFILE).cloned(),
            env: config.env.unwrap_or_default().into_iter().filter(|e| !image_env.contains(e)).collect(),
            ports: c
                .ports
                .unwrap_or_default()
                .into_iter()
                .filter(|p| seen.insert((p.private_port, p.public_port)))
                .map(|p| PortInfo { container: p.private_port, host: p.public_port })
                .collect(),
            depends_on: labels
                .get(LABEL_DEPENDS_ON)
                .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
                .unwrap_or_default(),
            image_local,
            image,
            container_name,
        });
    }
    containers.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Snapshot { network, containers, machine: machine() })
}

/// Which of `images` this Mac has, for images a file says were built on
/// the exporter's Mac
#[tauri::command]
pub async fn images_here(images: Vec<String>) -> CmdResult<Vec<String>> {
    let docker = docker::docker().await?;
    let mut out = Vec::new();
    for image in images {
        if docker.inspect_image(&image).await.is_ok() {
            out.push(image);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Git repos

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    /// The clone's root here
    root: String,
    /// `github.com/yassir/rides-api`: the same on every Mac, whichever URL it was cloned with
    repo: Option<String>,
    /// The remote to clone, without any credentials in it
    url: Option<String>,
    /// The folder inside the repo, `services/api`, or "" for its root
    path: String,
}

/// `git@github.com:Yassir/rides-api.git`, `https://user:token@github.com/yassir/rides-api`
/// → `github.com/yassir/rides-api`
pub(crate) fn repo_id(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = if let Some((scheme, rest)) = u.split_once("://") {
        if !matches!(scheme, "https" | "http" | "ssh" | "git" | "git+ssh") {
            return None;
        }
        rest.to_string()
    } else {
        // scp-like: [user@]host:owner/name
        let (host, path) = u.split_once(':')?;
        if host.contains('/') {
            return None;
        }
        format!("{host}/{path}")
    };
    let rest = rest.rsplit_once('@').map_or(rest.as_str(), |(_, r)| r).to_string();
    let (host, path) = rest.split_once('/')?;
    let host = host.split(':').next()?.to_lowercase();
    let path = path.trim_matches('/').trim_end_matches(".git").trim_matches('/');
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some(format!("{host}/{}", path.to_lowercase()))
}

/// The remote without credentials: `https://token@host/x` → `https://host/x`
pub(crate) fn clean_url(url: &str) -> String {
    let u = url.trim();
    match u.split_once("://") {
        Some((scheme, rest)) if scheme.starts_with("http") => {
            let (auth, tail) = rest.split_once('/').map_or((rest, ""), |(a, t)| (a, t));
            let host = auth.rsplit_once('@').map_or(auth, |(_, h)| h);
            format!("{scheme}://{host}/{tail}")
        }
        _ => u.to_string(),
    }
}

/// The git dir of a clone, following the `gitdir:` of worktrees and submodules
fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot = root.join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let text = fs::read_to_string(&dot).ok()?;
    let dir = text.trim().strip_prefix("gitdir:")?.trim();
    let dir = if Path::new(dir).is_absolute() { PathBuf::from(dir) } else { root.join(dir) };
    // A worktree keeps the shared config in its common dir
    match fs::read_to_string(dir.join("commondir")) {
        Ok(common) => Some(dir.join(common.trim())),
        Err(_) => Some(dir),
    }
}

/// `origin`'s URL, or the first remote's
fn remote_url(git: &Path) -> Option<String> {
    let text = fs::read_to_string(git.join("config")).ok()?;
    let mut remotes: Vec<(String, String)> = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            current = line
                .strip_prefix("[remote \"")
                .and_then(|r| r.strip_suffix("\"]"))
                .map(String::from);
        } else if let (Some(name), Some(v)) = (&current, line.strip_prefix("url")) {
            if let Some(v) = v.trim_start().strip_prefix('=') {
                remotes.push((name.clone(), v.trim().to_string()));
            }
        }
    }
    remotes.iter().find(|(n, _)| n == "origin").or(remotes.first()).map(|(_, u)| u.clone())
}

pub(crate) fn git_info_of(path: &Path) -> Option<GitInfo> {
    let path = path.canonicalize().ok()?;
    let root = path.ancestors().find(|p| p.join(".git").exists())?;
    let url = git_dir(root).and_then(|g| remote_url(&g));
    let inside = path.strip_prefix(root).ok()?.to_string_lossy().into_owned();
    Some(GitInfo {
        root: root.display().to_string(),
        repo: url.as_deref().and_then(repo_id),
        url: url.as_deref().map(clean_url),
        path: inside,
    })
}

/// For each folder, the repo it's in, if any
#[tauri::command]
pub fn git_info(paths: Vec<String>) -> Vec<Option<GitInfo>> {
    paths.iter().map(|p| git_info_of(&expand_home(p))).collect()
}

/// Where people keep their clones
const CODE_FOLDERS: [&str; 16] = [
    "code", "Code", "workspace", "Workspace", "projects", "Projects", "dev", "Developer", "src", "repos", "git",
    "GitHub", "Documents/GitHub", "Documents/code", "Sites", "work",
];
const SKIP: [&str; 9] = ["node_modules", "Library", "target", "vendor", "dist", "build", "Pods", "venv", "__pycache__"];
const MAX_DEPTH: usize = 4;
const MAX_DIRS: usize = 40_000;

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// Clones with that remote
    clones: Vec<String>,
    /// Folders named like the repo with another remote or none
    named: Vec<String>,
}

/// Looks for clones of `repos` (`github.com/yassir/rides-api`) in the usual
/// code folders and in `roots`, and folders named like them
#[tauri::command]
pub async fn find_repos(repos: Vec<String>, roots: Vec<String>) -> HashMap<String, Found> {
    tauri::async_runtime::spawn_blocking(move || search(&repos, &roots, &PathBuf::from(machine().home)))
        .await
        .unwrap_or_default()
}

pub(crate) fn search(repos: &[String], roots: &[String], home: &Path) -> HashMap<String, Found> {
    let wanted: HashSet<&str> = repos.iter().map(String::as_str).collect();
    let names: HashMap<String, &str> = repos
        .iter()
        .filter_map(|r| r.rsplit('/').next().map(|n| (n.to_lowercase(), r.as_str())))
        .collect();
    let mut out: HashMap<String, Found> = repos.iter().map(|r| (r.clone(), Found::default())).collect();
    let mut starts: Vec<PathBuf> = CODE_FOLDERS.iter().map(|f| home.join(f)).collect();
    starts.extend(roots.iter().map(|r| expand_home(r)));
    let mut seen = HashSet::new();
    let mut visited = 0;
    let mut stack: Vec<(PathBuf, usize)> = starts.into_iter().filter(|p| p.is_dir()).map(|p| (p, 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        let Ok(real) = dir.canonicalize() else { continue };
        if !seen.insert(real.clone()) || visited > MAX_DIRS {
            continue;
        }
        visited += 1;
        if real.join(".git").exists() {
            let id = git_dir(&real).and_then(|g| remote_url(&g)).as_deref().and_then(repo_id);
            let shown = real.display().to_string();
            match id {
                Some(id) if wanted.contains(id.as_str()) => out.entry(id).or_default().clones.push(shown),
                _ => {
                    let name = real.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                    if let Some(repo) = names.get(&name) {
                        out.entry(repo.to_string()).or_default().named.push(shown);
                    }
                }
            }
            // A clone may hold others (a workspace of submodules); keep looking a little
        }
        if depth >= MAX_DEPTH {
            continue;
        }
        let Ok(entries) = fs::read_dir(&real) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIP.contains(&name.as_str()) {
                continue;
            }
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                stack.push((e.path(), depth + 1));
            }
        }
    }
    for f in out.values_mut() {
        f.clones.sort();
        f.named.sort();
    }
    out
}

// ---------------------------------------------------------------------------
// Ports, cloning, files

/// The host ports something here already listens on. Both addresses are
/// tried: with SO_REUSEADDR (which std sets), binding every address works
/// on macOS while something listens on localhost only.
#[tauri::command]
pub fn ports_in_use(ports: Vec<u16>) -> Vec<u16> {
    ports
        .into_iter()
        .filter(|p| ["0.0.0.0", "127.0.0.1"].iter().any(|ip| TcpListener::bind((*ip, *p)).is_err()))
        .collect()
}

/// Clones `url` into `parent`, with the git and credentials a terminal has.
/// Returns the clone's folder.
#[tauri::command]
pub async fn git_clone(url: String, parent: String) -> CmdResult<String> {
    let url = url.trim().to_string();
    if url.is_empty() || url.starts_with('-') {
        return Err("That isn't a repo URL.".into());
    }
    let name = repo_id(&url).and_then(|id| id.rsplit('/').next().map(String::from)).ok_or("That isn't a repo URL.")?;
    let dest = expand_home(&parent).join(&name);
    if dest.exists() {
        return Err(format!("{} already exists. Choose it instead, or another folder.", dest.display()));
    }
    let target = dest.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        Command::new("git")
            .envs(crate::process::shell_env())
            .env("GIT_TERMINAL_PROMPT", "0")
            .args(["clone", "--", &url])
            .arg(&target)
            .stdin(Stdio::null())
            .output()
    })
    .await
    .map_err(err)?
    .map_err(|e| format!("Couldn't run git: {e}. Install the Xcode command line tools."))?;
    if !output.status.success() {
        let text = String::from_utf8_lossy(&output.stderr);
        let last = text.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("git clone failed");
        return Err(last.trim().to_string());
    }
    Ok(dest.display().to_string())
}

#[tauri::command]
pub fn share_read(path: String) -> CmdResult<String> {
    let path = expand_home(&path);
    fs::read_to_string(&path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))
}

#[tauri::command]
pub fn share_write(path: String, text: String) -> CmdResult<String> {
    let path = expand_home(&path);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("uat-tmp");
    fs::write(&tmp, text)
        .and_then(|_| fs::rename(&tmp, &path))
        .map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_repo_the_same_whatever_its_url() {
        for url in [
            "git@github.com:Yassir/rides-api.git",
            "https://github.com/yassir/rides-api",
            "https://amr:ghp_secret@github.com/yassir/rides-api.git",
            "ssh://git@github.com:22/yassir/rides-api.git",
            "git+ssh://git@github.com/yassir/rides-api/",
        ] {
            assert_eq!(repo_id(url).as_deref(), Some("github.com/yassir/rides-api"), "{url}");
        }
        assert_eq!(repo_id("gitlab.example.com:group/sub/app.git").as_deref(), Some("gitlab.example.com/group/sub/app"));
        assert_eq!(repo_id("/Users/me/code/app"), None);
        assert_eq!(repo_id("file:///Users/me/code/app"), None);
    }

    #[test]
    fn keeps_credentials_out_of_urls() {
        assert_eq!(clean_url("https://amr:ghp_secret@github.com/yassir/x.git"), "https://github.com/yassir/x.git");
        assert_eq!(clean_url("git@github.com:yassir/x.git"), "git@github.com:yassir/x.git");
    }

    #[test]
    fn finds_a_folders_repo_and_clones_of_it() {
        let home = std::env::temp_dir().join(format!("uat-share-repos-{}", std::process::id()));
        let clone = home.join("code/team/rides-api");
        fs::create_dir_all(clone.join(".git")).unwrap();
        fs::create_dir_all(clone.join("services/api")).unwrap();
        fs::write(
            clone.join(".git/config"),
            "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = git@github.com:other/rides-api.git\n[remote \"origin\"]\n\turl = https://me:tok@github.com/Yassir/rides-api.git\n",
        )
        .unwrap();
        let other = home.join("work/rides-api");
        fs::create_dir_all(other.join(".git")).unwrap();
        fs::write(other.join(".git/config"), "[core]\n").unwrap();
        fs::create_dir_all(home.join("code/node_modules/rides-api/.git")).unwrap();

        let info = git_info_of(&clone.join("services/api")).unwrap();
        assert_eq!(info.repo.as_deref(), Some("github.com/yassir/rides-api"));
        assert_eq!(info.url.as_deref(), Some("https://github.com/Yassir/rides-api.git"));
        assert_eq!(info.path, "services/api");
        assert!(git_info_of(&home).is_none());

        let found = search(&["github.com/yassir/rides-api".into()], &[], &home);
        let f = &found["github.com/yassir/rides-api"];
        assert_eq!(f.clones, [clone.canonicalize().unwrap().display().to_string()]);
        assert_eq!(f.named, [other.canonicalize().unwrap().display().to_string()]);
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn sees_a_port_taken_on_localhost_only() {
        let taken = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        assert_eq!(ports_in_use(vec![port]), [port]);
        drop(taken);
        assert!(ports_in_use(vec![port]).is_empty());
    }

    #[test]
    fn writes_and_reads_a_file() {
        let path = std::env::temp_dir().join(format!("uat-share-file-{}/a/net.uat.json", std::process::id()));
        let written = share_write(path.display().to_string(), "{}".into()).unwrap();
        assert_eq!(share_read(written).unwrap(), "{}");
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }
}
