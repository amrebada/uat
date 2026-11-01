//! Call traces: which service a call from Collections reached, what that
//! service called in turn, and how each of those calls went.
//!
//! Containers: each running container on a traced network gets a sidecar
//! that shares its network namespace and runs tcpdump (`uat/sniff:1`, built
//! the first time). Packets come back as pcap over `attach`. From them the
//! app keeps the names a container looked up and whether they resolved, the
//! connections it opened and whether they were accepted, and the request and
//! status lines of plain HTTP. Commands on the Mac that run Node load a hook
//! through NODE_OPTIONS (`trace-hook.cjs`) that writes the same to a file the
//! app follows.
//!
//! All of it is kept as calls for a while. A trace is the calls in a time
//! window, followed from the service the request reached.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bollard::container::{AttachContainerResults, LogOutput};
use bollard::models::{ContainerCreateBody, HostConfig, HostConfigLogConfig};
use bollard::query_parameters::{
    AttachContainerOptionsBuilder, CreateContainerOptionsBuilder, ListContainersOptionsBuilder,
    LogsOptionsBuilder, RemoveContainerOptionsBuilder,
};
use bollard::Docker;
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::docker::{self, err, CmdResult, DEFAULT_NETWORK, LABEL_KIND, LABEL_MANAGED, LABEL_SERVICE};
use crate::process::{self, ProcRef};

pub(crate) fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// ---------------------------------------------------------------------------
// What was seen

const KEEP_MS: u64 = 20 * 60 * 1000;
const MAX_CALLS: usize = 50_000;
const MAX_HITS: usize = 256;
const MAX_REQUESTS: usize = 64;
/// A connection with no answer after this long is reported as unanswered
const NO_ANSWER_MS: u64 = 3000;

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Caller {
    Container(String),
    Process(String),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Target {
    /// As seen on the wire
    Addr(IpAddr, u16),
    /// As the code asked for it; port 0 when only the name was looked up
    Host(String, u16),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Outcome {
    Pending,
    Open,
    Refused,
    Unresolved,
    Failed,
}

#[derive(Clone, Debug)]
struct Request {
    tag: Option<String>,
    at: u64,
    method: String,
    path: String,
    status: Option<u16>,
    error: Option<String>,
    done: Option<u64>,
}

/// One connection, or one name that didn't resolve.
#[derive(Clone, Debug)]
struct Call {
    caller: Caller,
    target: Target,
    outcome: Outcome,
    error: Option<String>,
    started: u64,
    /// When something happened on it: the connect, requests, other traffic
    hits: VecDeque<u64>,
    requests: VecDeque<Request>,
    /// Made for a request the hook saw before (or without) its socket
    orphan: bool,
}

impl Call {
    fn new(caller: Caller, target: Target, outcome: Outcome, at: u64) -> Call {
        Call {
            caller,
            target,
            outcome,
            error: None,
            started: at,
            hits: VecDeque::from([at]),
            requests: VecDeque::new(),
            orphan: false,
        }
    }

    fn hit(&mut self, at: u64) {
        if self.hits.len() >= MAX_HITS {
            self.hits.pop_front();
        }
        self.hits.push_back(at);
    }

    fn last(&self) -> u64 {
        self.hits.back().copied().unwrap_or(self.started)
    }

    /// The first thing it did in the window
    fn first_between(&self, from: u64, to: u64) -> Option<u64> {
        let inside = |t: &u64| (from..=to).contains(t);
        let hit = self.hits.iter().copied().find(inside);
        let req = self.requests.iter().map(|r| r.at).find(inside);
        hit.into_iter().chain(req).min()
    }
}

#[derive(Hash, PartialEq, Eq, Clone, Debug)]
pub(crate) enum Conn {
    /// Container id, its port, the other end
    Tcp(String, u16, IpAddr, u16),
    /// Process id, the hook's id for the socket
    Hook(String, String),
}

#[derive(Default)]
pub(crate) struct Book {
    next: u64,
    calls: BTreeMap<u64, Call>,
    conns: HashMap<Conn, u64>,
    /// (process id, the hook's request id) → call, until the request ends
    tags: HashMap<(String, String), u64>,
    /// Addresses from the DNS answers seen
    names: HashMap<IpAddr, String>,
    /// Processes whose hook has loaded
    hooked: HashSet<String>,
}

pub(crate) static BOOK: LazyLock<Mutex<Book>> = LazyLock::new(Default::default);

impl Book {
    fn add(&mut self, call: Call) -> u64 {
        let now = call.started;
        self.next += 1;
        let id = self.next;
        self.calls.insert(id, call);
        self.prune(now);
        id
    }

    fn prune(&mut self, now: u64) {
        while let Some((&id, oldest)) = self.calls.first_key_value() {
            if self.calls.len() <= MAX_CALLS && now.saturating_sub(oldest.last()) <= KEEP_MS {
                break;
            }
            self.calls.remove(&id);
        }
        if self.conns.len() > 2 * self.calls.len() + 1024 {
            let calls = &self.calls;
            self.conns.retain(|_, id| calls.contains_key(id));
            self.tags.retain(|_, id| calls.contains_key(id));
        }
    }

    fn call_mut(&mut self, conn: &Conn) -> Option<&mut Call> {
        let id = *self.conns.get(conn)?;
        self.calls.get_mut(&id)
    }

    pub(crate) fn connect(&mut self, caller: Caller, conn: Conn, target: Target, at: u64) {
        // The hook can report a request before its socket connects
        let orphan = self.calls.iter_mut().rev().take(64).find_map(|(&id, c)| {
            let mine = c.orphan && c.caller == caller && c.target == target && at.saturating_sub(c.started) < 5000;
            mine.then(|| {
                c.orphan = false;
                c.outcome = Outcome::Pending;
                id
            })
        });
        let id = orphan.unwrap_or_else(|| self.add(Call::new(caller, target, Outcome::Pending, at)));
        self.conns.insert(conn, id);
    }

    pub(crate) fn accepted(&mut self, conn: &Conn) {
        if let Some(c) = self.call_mut(conn) {
            if c.outcome == Outcome::Pending {
                c.outcome = Outcome::Open;
            }
        }
    }

    /// A connection that never opened.
    pub(crate) fn failed(&mut self, conn: &Conn, outcome: Outcome, error: Option<String>) {
        if let Some(c) = self.call_mut(conn) {
            if c.outcome == Outcome::Pending {
                c.outcome = outcome;
                c.error = error;
            }
        }
    }

    /// Traffic on a connection; one opened before the capture started is
    /// added as it's seen.
    pub(crate) fn traffic(&mut self, caller: Caller, conn: Conn, target: Target, at: u64) -> u64 {
        if let Some(&id) = self.conns.get(&conn) {
            if let Some(c) = self.calls.get_mut(&id) {
                c.hit(at);
                if c.outcome == Outcome::Pending {
                    c.outcome = Outcome::Open;
                }
                return id;
            }
        }
        let id = self.add(Call::new(caller, target, Outcome::Open, at));
        self.conns.insert(conn, id);
        id
    }

    /// The caller's latest live call to `target`, for a request the hook
    /// saw without its socket (a pooled connection).
    fn recent(&self, caller: &Caller, target: &Target, at: u64) -> Option<u64> {
        self.calls
            .iter()
            .rev()
            .take(512)
            .find(|(_, c)| {
                &c.caller == caller
                    && &c.target == target
                    && matches!(c.outcome, Outcome::Open | Outcome::Pending)
                    && at.saturating_sub(c.last()) < 10_000
            })
            .map(|(&id, _)| id)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn request(
        &mut self,
        caller: Caller,
        conn: Option<Conn>,
        target: Target,
        at: u64,
        method: String,
        path: String,
        tag: Option<(String, String)>,
    ) {
        let id = match conn {
            Some(conn) => self.traffic(caller, conn, target, at),
            None => match self.recent(&caller, &target, at) {
                Some(id) => id,
                None => self.add(Call { orphan: true, ..Call::new(caller, target, Outcome::Open, at) }),
            },
        };
        if let Some(c) = self.calls.get_mut(&id) {
            c.hit(at);
            if c.requests.len() >= MAX_REQUESTS {
                c.requests.pop_front();
            }
            c.requests.push_back(Request {
                tag: tag.as_ref().map(|t| t.1.clone()),
                at,
                method,
                path,
                status: None,
                error: None,
                done: None,
            });
        }
        if let Some(tag) = tag {
            self.tags.insert(tag, id);
        }
    }

    /// A status line on a connection answers its oldest open request.
    pub(crate) fn response(&mut self, conn: &Conn, at: u64, status: u16) {
        if let Some(c) = self.call_mut(conn) {
            if let Some(r) = c.requests.iter_mut().find(|r| r.done.is_none()) {
                r.status = Some(status);
                r.done = Some(at);
            }
        }
    }

    /// How a request the hook reported ended.
    pub(crate) fn finished(&mut self, tag: &(String, String), at: u64, status: Option<u16>, error: Option<String>) {
        let Some(id) = self.tags.remove(tag) else { return };
        if let Some(c) = self.calls.get_mut(&id) {
            if let Some(r) = c.requests.iter_mut().find(|r| r.tag.as_deref() == Some(tag.1.as_str())) {
                r.status = status;
                r.error = error;
                r.done = Some(at);
            }
        }
    }

    /// A name the caller looked up that came back empty.
    pub(crate) fn unresolved(&mut self, caller: Caller, name: &str, at: u64) {
        // A resolver asks more than once (A and AAAA, retries, search
        // domains): keep one call with the shortest name
        let dup = self.calls.iter_mut().rev().take(64).find(|(_, c)| {
            c.caller == caller
                && c.outcome == Outcome::Unresolved
                && at.saturating_sub(c.started) < 2000
                && matches!(&c.target, Target::Host(n, _)
                    if n == name || n.starts_with(&format!("{name}.")) || name.starts_with(&format!("{n}.")))
        });
        if let Some((_, c)) = dup {
            if let Target::Host(n, _) = &mut c.target {
                if name.len() < n.len() {
                    *n = name.to_string();
                }
            }
            return;
        }
        self.add(Call::new(caller, Target::Host(name.to_string(), 0), Outcome::Unresolved, at));
    }

    pub(crate) fn resolved(&mut self, name: &str, addrs: &[IpAddr]) {
        if self.names.len() > 4096 {
            self.names.clear();
        }
        for &ip in addrs {
            self.names.insert(ip, name.to_string());
        }
    }

    /// One packet from a container's capture.
    pub(crate) fn packet(&mut self, container: &str, at: u64, p: &Packet) {
        match p.proto {
            Proto::Udp { sport: 53, payload } => {
                let Some(dns) = dns_answer(payload) else { return };
                if dns.name.is_empty() {
                    return;
                }
                if !dns.addrs.is_empty() {
                    self.resolved(&dns.name, &dns.addrs);
                } else if matches!(dns.rcode, 2 | 3) {
                    // NXDOMAIN or SERVFAIL; an empty NOERROR is just no AAAA record
                    self.unresolved(Caller::Container(container.into()), &dns.name, at);
                }
            }
            Proto::Udp { .. } => {}
            Proto::Tcp { sport, dport, flags, payload } => {
                if p.src.is_loopback() || p.dst.is_loopback() {
                    return;
                }
                let (here, there, port) = if p.outgoing { (sport, p.dst, dport) } else { (dport, p.src, sport) };
                let conn = Conn::Tcp(container.to_string(), here, there, port);
                let caller = || Caller::Container(container.to_string());
                let target = Target::Addr(there, port);
                let (syn, ack, rst, psh) = (flags & SYN != 0, flags & ACK != 0, flags & RST != 0, flags & PSH != 0);
                if syn && !ack {
                    if p.outgoing {
                        self.connect(caller(), conn, target, at);
                    }
                } else if syn && ack {
                    if !p.outgoing {
                        self.accepted(&conn);
                    }
                } else if rst {
                    if !p.outgoing {
                        self.failed(&conn, Outcome::Refused, None);
                    }
                } else if payload.is_empty() {
                } else if p.outgoing {
                    if let Some((method, path)) = http_request(payload) {
                        self.request(caller(), Some(conn), target, at, method, path, None);
                    } else if psh && here >= 32768 && port < 32768 {
                        // This side opened it (an ephemeral port to a service
                        // port): a query on a pooled connection
                        self.traffic(caller(), conn, target, at);
                    }
                } else if let Some(status) = http_status(payload) {
                    self.response(&conn, at, status);
                }
            }
        }
    }

    /// One line from a Node command's hook.
    pub(crate) fn hook_line(&mut self, process: &str, line: &str) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
        let at = v["t"].as_u64().unwrap_or_else(now_ms);
        let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        let port = v["port"].as_u64().unwrap_or(0) as u16;
        let host = || s("host").trim_matches(['[', ']']).to_string();
        let caller = || Caller::Process(process.to_string());
        let conn = || Conn::Hook(process.to_string(), s("c"));
        let tag = || (process.to_string(), s("r"));
        match v["k"].as_str() {
            Some("hi") => {
                self.hooked.insert(process.to_string());
            }
            Some("connect") => self.connect(caller(), conn(), Target::Host(host(), port), at),
            Some("open") => self.accepted(&conn()),
            Some("fail") => {
                let code = s("code");
                let outcome = match code.as_str() {
                    "ENOTFOUND" | "EAI_AGAIN" | "EAI_NONAME" => Outcome::Unresolved,
                    "ECONNREFUSED" => Outcome::Refused,
                    _ => Outcome::Failed,
                };
                let msg = s("msg");
                self.failed(&conn(), outcome, Some(if msg.is_empty() { code } else { msg }));
            }
            Some("req") => {
                self.request(caller(), None, Target::Host(host(), port), at, s("method"), s("path"), Some(tag()))
            }
            Some("res") => self.finished(&tag(), at, v["status"].as_u64().map(|s| s as u16), None),
            Some("rerr") => self.finished(&tag(), at, None, Some(s("code"))),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Packets

const SYN: u8 = 0x02;
const RST: u8 = 0x04;
const PSH: u8 = 0x08;
const ACK: u8 = 0x10;

#[derive(Debug)]
pub(crate) struct Packet<'a> {
    /// Sent by the container rather than received
    outgoing: bool,
    src: IpAddr,
    dst: IpAddr,
    proto: Proto<'a>,
}

#[derive(Debug)]
pub(crate) enum Proto<'a> {
    Tcp { sport: u16, dport: u16, flags: u8, payload: &'a [u8] },
    Udp { sport: u16, payload: &'a [u8] },
}

fn be16(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]))
}

/// A pcap stream read as it arrives.
#[derive(Default)]
pub(crate) struct Pcap {
    buf: Vec<u8>,
    head: Option<(bool, bool, u32)>,
}

impl Pcap {
    /// Adds bytes and calls `each(ms, link type, frame)` for every whole record.
    pub(crate) fn push(&mut self, bytes: &[u8], mut each: impl FnMut(u64, u32, &[u8])) {
        self.buf.extend_from_slice(bytes);
        let mut pos = 0;
        let word = |b: &[u8], i: usize, big: bool| {
            let a = [b[i], b[i + 1], b[i + 2], b[i + 3]];
            if big { u32::from_be_bytes(a) } else { u32::from_le_bytes(a) }
        };
        if self.head.is_none() {
            if self.buf.len() < 24 {
                return;
            }
            let (big, nanos) = match word(&self.buf, 0, false) {
                0xa1b2_c3d4 => (false, false),
                0xd4c3_b2a1 => (true, false),
                0xa1b2_3c4d => (false, true),
                0x4d3c_b2a1 => (true, true),
                _ => {
                    self.buf.clear();
                    return;
                }
            };
            self.head = Some((big, nanos, word(&self.buf, 20, big)));
            pos = 24;
        }
        let (big, nanos, link) = self.head.unwrap();
        while self.buf.len() - pos >= 16 {
            let sec = word(&self.buf, pos, big) as u64;
            let frac = word(&self.buf, pos + 4, big) as u64;
            let len = word(&self.buf, pos + 8, big) as usize;
            if len > 1 << 18 {
                // Not a record: the stream is out of step, so drop what's here
                self.buf.clear();
                return;
            }
            if self.buf.len() - pos - 16 < len {
                break;
            }
            let at = sec * 1000 + if nanos { frac / 1_000_000 } else { frac / 1000 };
            each(at, link, &self.buf[pos + 16..pos + 16 + len]);
            pos += 16 + len;
        }
        self.buf.drain(..pos);
    }
}

/// Reads a captured frame (Linux cooked v1/v2 from `-i any`, or Ethernet).
pub(crate) fn decode(link: u32, f: &[u8]) -> Option<Packet<'_>> {
    let (ethertype, outgoing, ip) = match link {
        276 => (be16(f, 0)?, *f.get(10)? == 4, f.get(20..)?),
        113 => (be16(f, 14)?, be16(f, 0)? == 4, f.get(16..)?),
        1 => (be16(f, 12)?, false, f.get(14..)?),
        _ => return None,
    };
    let (src, dst, proto, l4): (IpAddr, IpAddr, u8, &[u8]) = match ethertype {
        0x0800 => {
            let ihl = (*ip.first()? as usize & 0x0f) * 4;
            let total = (be16(ip, 2)? as usize).clamp(ihl, ip.len().max(ihl));
            let src = Ipv4Addr::from(<[u8; 4]>::try_from(ip.get(12..16)?).ok()?);
            let dst = Ipv4Addr::from(<[u8; 4]>::try_from(ip.get(16..20)?).ok()?);
            (src.into(), dst.into(), *ip.get(9)?, ip.get(ihl..total.min(ip.len()))?)
        }
        0x86dd => {
            let len = 40 + be16(ip, 4)? as usize;
            let src = Ipv6Addr::from(<[u8; 16]>::try_from(ip.get(8..24)?).ok()?);
            let dst = Ipv6Addr::from(<[u8; 16]>::try_from(ip.get(24..40)?).ok()?);
            (src.into(), dst.into(), *ip.get(6)?, ip.get(40..len.min(ip.len()))?)
        }
        _ => return None,
    };
    let proto = match proto {
        6 => {
            let off = (*l4.get(12)? as usize >> 4) * 4;
            Proto::Tcp {
                sport: be16(l4, 0)?,
                dport: be16(l4, 2)?,
                flags: *l4.get(13)?,
                payload: l4.get(off..).unwrap_or_default(),
            }
        }
        17 => Proto::Udp { sport: be16(l4, 0)?, payload: l4.get(8..)? },
        _ => return None,
    };
    Some(Packet { outgoing, src, dst, proto })
}

struct Dns {
    name: String,
    rcode: u8,
    addrs: Vec<IpAddr>,
}

/// The question and the addresses of a DNS response.
fn dns_answer(p: &[u8]) -> Option<Dns> {
    let flags = be16(p, 2)?;
    if flags & 0x8000 == 0 || be16(p, 4)? != 1 {
        return None;
    }
    let mut pos = 12;
    let name = dns_name(p, &mut pos)?;
    pos += 4;
    let mut addrs = Vec::new();
    for _ in 0..be16(p, 6)? {
        dns_name(p, &mut pos)?;
        let (kind, len) = (be16(p, pos)?, be16(p, pos + 8)? as usize);
        let data = p.get(pos + 10..pos + 10 + len)?;
        match (kind, len) {
            (1, 4) => addrs.push(IpAddr::from(<[u8; 4]>::try_from(data).ok()?)),
            (28, 16) => addrs.push(IpAddr::from(<[u8; 16]>::try_from(data).ok()?)),
            _ => {}
        }
        pos += 10 + len;
    }
    Some(Dns { name, rcode: (flags & 0x0f) as u8, addrs })
}

fn dns_name(p: &[u8], pos: &mut usize) -> Option<String> {
    let mut labels = Vec::new();
    let mut i = *pos;
    let mut jumped = false;
    for _ in 0..128 {
        let len = *p.get(i)? as usize;
        if len == 0 {
            if !jumped {
                *pos = i + 1;
            }
            return Some(labels.join("."));
        }
        if len & 0xc0 == 0xc0 {
            if !jumped {
                *pos = i + 2;
            }
            jumped = true;
            i = ((len & 0x3f) << 8) | *p.get(i + 1)? as usize;
            continue;
        }
        labels.push(String::from_utf8_lossy(p.get(i + 1..i + 1 + len)?).into_owned());
        i += 1 + len;
    }
    None
}

const METHODS: [&str; 9] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"];

fn first_line(p: &[u8]) -> String {
    let end = p.windows(2).position(|w| w == b"\r\n").unwrap_or(p.len());
    String::from_utf8_lossy(&p[..end]).into_owned()
}

/// `GET /rides?x=1 HTTP/1.1` → ("GET", "/rides?x=1"); the line may be cut by the capture length.
fn http_request(p: &[u8]) -> Option<(String, String)> {
    let word = p.iter().position(|&b| b == b' ').filter(|&i| i <= 7)?;
    let method = std::str::from_utf8(&p[..word]).ok()?;
    if !METHODS.contains(&method) {
        return None;
    }
    let line = first_line(p);
    let mut parts = line.splitn(3, ' ').skip(1);
    let path = parts.next().filter(|s| !s.is_empty())?;
    if parts.next().is_some_and(|v| !v.starts_with("HTTP/")) {
        return None;
    }
    Some((method.to_string(), path.to_string()))
}

fn http_status(p: &[u8]) -> Option<u16> {
    if !p.starts_with(b"HTTP/1.") {
        return None;
    }
    first_line(p).split(' ').nth(1)?.parse().ok()
}

// ---------------------------------------------------------------------------
// Traces

/// What the app knows about a network when a trace is read.
#[derive(Default)]
pub(crate) struct Place {
    network: String,
    members: Vec<Member>,
    gateways: HashSet<IpAddr>,
    processes: Vec<ProcRef>,
}

#[derive(Debug)]
struct Member {
    id: String,
    name: String,
    running: bool,
    /// The proxy that puts a command on the network
    proxy: bool,
    ips: Vec<IpAddr>,
    published: Vec<u16>,
}

struct Resolved {
    name: String,
    service: bool,
    port: Option<u16>,
}

impl Place {
    fn caller(&self, c: &Caller) -> Option<(&str, bool)> {
        match c {
            Caller::Container(id) => self.members.iter().find(|m| &m.id == id).map(|m| (m.name.as_str(), m.proxy)),
            Caller::Process(id) => self
                .processes
                .iter()
                .find(|p| &p.id == id && p.network == self.network)
                .map(|p| (p.name.as_str(), false)),
        }
    }

    fn is_service(&self, name: &str) -> bool {
        self.members.iter().any(|m| m.name == name) || self.processes.iter().any(|p| p.name == name && p.network == self.network)
    }

    /// A port on the Mac: the command listening there, or the container publishing it.
    fn mac_port(&self, port: u16, fallback: &str) -> Resolved {
        let name = self
            .processes
            .iter()
            .filter(|p| p.ports.contains(&port))
            .min_by_key(|p| p.network != self.network)
            .map(|p| p.name.clone())
            .or_else(|| self.members.iter().find(|m| m.published.contains(&port)).map(|m| m.name.clone()));
        match name {
            Some(name) => Resolved { name, service: true, port: Some(port) },
            None => Resolved { name: fallback.into(), service: false, port: Some(port) },
        }
    }

    fn resolve(&self, t: &Target, names: &HashMap<IpAddr, String>) -> Resolved {
        match t {
            Target::Addr(ip, port) => {
                if let Some(m) = self.members.iter().find(|m| m.ips.contains(ip)) {
                    return Resolved { name: m.name.clone(), service: true, port: Some(*port) };
                }
                let dns = names.get(ip);
                if self.gateways.contains(ip) || dns.is_some_and(|n| n.ends_with(".docker.internal")) {
                    return self.mac_port(*port, "host.docker.internal");
                }
                let name = dns.cloned().unwrap_or_else(|| ip.to_string());
                Resolved { name, service: false, port: Some(*port) }
            }
            Target::Host(host, port) => {
                let port = (*port != 0).then_some(*port);
                let local = matches!(host.as_str(), "localhost" | "::1" | "0.0.0.0" | "host.docker.internal")
                    || host.starts_with("127.")
                    || host.ends_with(".localhost");
                if let (true, Some(p)) = (local, port) {
                    return self.mac_port(p, "localhost");
                }
                Resolved { name: host.clone(), service: self.is_service(host), port }
            }
        }
    }

    /// Why a call failed, in words, for the line's end.
    fn explain(&self, state: &str, from_mac: bool, to: &Resolved, error: Option<&str>) -> Option<String> {
        let port = to.port.map(|p| format!(":{p}")).unwrap_or_default();
        Some(match state {
            "unresolved" => {
                let stopped = self.members.iter().any(|m| m.name == to.name && !m.running)
                    || self.processes.iter().any(|p| p.name == to.name && p.network == self.network && !p.running);
                let published = self.members.iter().find(|m| m.name == to.name).and_then(|m| m.published.first());
                if stopped {
                    format!("{} isn't running", to.name)
                } else if from_mac && self.is_service(&to.name) {
                    match published {
                        Some(p) => format!("Names don't resolve on this Mac. Use localhost:{p}"),
                        None => "Names don't resolve on this Mac. Publish a port and use localhost".into(),
                    }
                } else if from_mac {
                    "No such host from this Mac".into()
                } else {
                    format!("Not found on {}", self.network)
                }
            }
            "refused" => format!("Nothing is listening on {}{port}", to.name),
            "timeout" => format!("No answer on {}{port}", to.name),
            "failed" => error.unwrap_or("Failed").to_string(),
            _ => return None,
        })
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RequestView {
    at: u64,
    method: String,
    path: String,
    status: Option<u16>,
    error: Option<String>,
    ms: Option<u64>,
}

/// One service calling one other thing in the window, however many times.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hop {
    from: String,
    to: String,
    /// "service" on the network, or "external"
    kind: &'static str,
    port: Option<u16>,
    /// "ok" | "pending" | "refused" | "unresolved" | "timeout" | "failed"
    state: &'static str,
    error: Option<String>,
    at: u64,
    count: u32,
    failed: u32,
    requests: Vec<RequestView>,
}

fn state_of(c: &Call, now: u64) -> &'static str {
    match c.outcome {
        Outcome::Open => "ok",
        Outcome::Pending if now.saturating_sub(c.started) > NO_ANSWER_MS => "timeout",
        Outcome::Pending => "pending",
        Outcome::Refused => "refused",
        Outcome::Unresolved => "unresolved",
        Outcome::Failed => "failed",
    }
}

/// The calls made in [from, to], followed from `entry`.
pub(crate) fn hops(book: &Book, place: &Place, entry: &str, from: u64, to: u64, now: u64) -> Vec<Hop> {
    struct Acc {
        hop: Hop,
        conns: u32,
        oks: u32,
        pending: u32,
        last_fail: Option<(&'static str, Option<String>)>,
    }
    let mut groups: Vec<Acc> = Vec::new();
    let mut index: HashMap<(String, String, Option<u16>), usize> = HashMap::new();
    // A proxy that couldn't reach its command on the Mac: what was sent to
    // it went nowhere, though the caller's connection opened
    let mut proxy: HashMap<String, (u32, u32)> = HashMap::new();

    for call in book.calls.values() {
        let Some(at) = call.first_between(from, to) else { continue };
        let Some((caller, is_proxy)) = place.caller(&call.caller) else { continue };
        let state = state_of(call, now);
        if is_proxy {
            let tally = proxy.entry(caller.to_string()).or_default();
            if state == "ok" { tally.0 += 1 } else if state != "pending" { tally.1 += 1 }
            continue;
        }
        let target = place.resolve(&call.target, &book.names);
        let key = (caller.to_string(), target.name.clone(), target.port);
        let i = *index.entry(key).or_insert_with(|| {
            groups.push(Acc {
                hop: Hop {
                    from: caller.to_string(),
                    to: target.name.clone(),
                    kind: if target.service { "service" } else { "external" },
                    port: target.port,
                    state: "ok",
                    error: None,
                    at,
                    count: 0,
                    failed: 0,
                    requests: Vec::new(),
                },
                conns: 0,
                oks: 0,
                pending: 0,
                last_fail: None,
            });
            groups.len() - 1
        });
        let acc = &mut groups[i];
        acc.hop.at = acc.hop.at.min(at);
        acc.conns += 1;
        for r in call.requests.iter().filter(|r| (from..=to).contains(&r.at)) {
            acc.hop.requests.push(RequestView {
                at: r.at,
                method: r.method.clone(),
                path: r.path.clone(),
                status: r.status,
                error: r.error.clone(),
                ms: r.done.map(|d| d.saturating_sub(r.at)),
            });
        }
        match state {
            // Requests on a connection opened before the window
            _ if call.orphan => {}
            "ok" => acc.oks += 1,
            "pending" => acc.pending += 1,
            _ => {
                acc.hop.failed += 1;
                let from_mac = matches!(call.caller, Caller::Process(_));
                acc.last_fail = Some((state, place.explain(state, from_mac, &target, call.error.as_deref())));
            }
        }
    }

    for acc in &mut groups {
        let hop = &mut acc.hop;
        hop.requests.sort_by_key(|r| r.at);
        hop.requests.truncate(30);
        hop.count = acc.conns.max(hop.requests.len() as u32);
        if let Some((state, error)) = acc.last_fail.take() {
            if acc.oks == 0 {
                hop.state = state;
                hop.error = error;
            }
        } else if acc.oks == 0 && acc.pending > 0 {
            hop.state = "pending";
        }
        if let Some(&(oks, fails)) = proxy.get(&hop.to) {
            if fails > 0 && oks == 0 {
                hop.state = "refused";
                hop.failed = hop.count;
                hop.error = Some(match hop.port {
                    Some(p) => format!("{} isn't listening on :{p} on this Mac", hop.to),
                    None => format!("{} isn't listening on this Mac", hop.to),
                });
            }
        }
    }

    // Keep what the request set off: the entry's calls, then their calls
    let mut reached = vec![entry.to_string()];
    let mut out = Vec::new();
    let mut i = 0;
    while i < reached.len() {
        let name = reached[i].clone();
        i += 1;
        for acc in groups.iter().filter(|a| a.hop.from == name) {
            out.push(acc.hop.clone());
            if acc.hop.kind == "service" && acc.hop.state == "ok" && !reached.contains(&acc.hop.to) {
                reached.push(acc.hop.to.clone());
            }
        }
    }
    out.sort_by_key(|h| h.at);
    out
}

async fn place<R: Runtime>(app: &AppHandle<R>, network: &str) -> Place {
    let mut place = Place { network: network.to_string(), processes: process::refs(app), ..Default::default() };
    let Ok(docker) = docker::docker().await else { return place };
    let mut filters = HashMap::new();
    filters.insert("network", vec![network]);
    let options = ListContainersOptionsBuilder::new().all(true).filters(&filters).build();
    let Ok(list) = docker.list_containers(Some(options)).await else { return place };
    for c in list {
        let labels = c.labels.unwrap_or_default();
        let container_name = c
            .names
            .and_then(|n| n.into_iter().next())
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default();
        let endpoint = c.network_settings.and_then(|n| n.networks).and_then(|mut n| n.remove(network));
        let ip = |s: Option<String>| s.and_then(|s| s.parse::<IpAddr>().ok());
        if let Some(gw) = ip(endpoint.as_ref().and_then(|e| e.gateway.clone())) {
            place.gateways.insert(gw);
        }
        place.members.push(Member {
            id: c.id.unwrap_or_default(),
            name: labels.get(LABEL_SERVICE).cloned().unwrap_or(container_name),
            running: c.state.is_some_and(|s| s.to_string() == "running"),
            proxy: labels.get(LABEL_KIND).is_some_and(|k| k == "process"),
            ips: ip(endpoint.and_then(|e| e.ip_address)).into_iter().collect(),
            published: c.ports.unwrap_or_default().iter().filter_map(|p| p.public_port).collect(),
        });
    }
    place
}

/// `http://localhost:3000/x` → ("localhost", 3000)
fn host_port(url: &str) -> Option<(String, u16)> {
    let url = url.trim();
    let (scheme, rest) = match url.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => ("http".to_string(), url),
    };
    let authority = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?;
    let (host, port) = match authority.strip_prefix('[') {
        Some(v6) => {
            let (h, after) = v6.split_once(']')?;
            (h, after.strip_prefix(':'))
        }
        None => match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        },
    };
    let port = match port {
        Some(p) => p.parse().ok()?,
        None if matches!(scheme.as_str(), "https" | "wss") => 443,
        None => 80,
    };
    Some((host.to_ascii_lowercase(), port))
}

fn is_local(host: &str) -> bool {
    matches!(host, "localhost" | "::1" | "0.0.0.0") || host.starts_with("127.") || host.ends_with(".localhost")
}

/// The service a running container publishing `port` on the Mac is, and its network.
async fn published_by(port: u16) -> Option<(String, String)> {
    let docker = docker::docker().await.ok()?;
    let mut filters = HashMap::new();
    filters.insert("status", vec!["running"]);
    let list = docker
        .list_containers(Some(ListContainersOptionsBuilder::new().filters(&filters).build()))
        .await
        .ok()?;
    for c in list {
        if !c.ports.iter().flatten().any(|p| p.public_port == Some(port)) {
            continue;
        }
        let labels = c.labels.unwrap_or_default();
        let container_name = c.names.and_then(|n| n.into_iter().next()).unwrap_or_default();
        let name = labels.get(LABEL_SERVICE).cloned().unwrap_or_else(|| container_name.trim_start_matches('/').into());
        let mut nets: Vec<String> = c
            .network_settings
            .and_then(|n| n.networks)
            .map(|n| n.into_keys().filter(|n| !matches!(n.as_str(), "bridge" | "host" | "none")).collect())
            .unwrap_or_default();
        nets.sort_by_key(|n| (n != DEFAULT_NETWORK, n.clone()));
        if let Some(network) = nets.into_iter().next() {
            return Some((network, name));
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    network: String,
    service: String,
    /// "container" | "process"
    kind: &'static str,
    /// Whether the network's containers are being watched
    watching: bool,
}

/// Where a request to `url` lands, so its trace can be read after it, and
/// starts watching that network if it isn't yet. `None` for URLs that
/// don't reach a service on this Mac.
#[tauri::command]
pub async fn trace_prepare<R: Runtime>(app: AppHandle<R>, url: String) -> CmdResult<Option<Entry>> {
    let Some((host, port)) = host_port(&url) else { return Ok(None) };
    if !is_local(&host) {
        return Ok(None);
    }
    let process = process::refs(&app).into_iter().find(|p| p.ports.contains(&port));
    let (network, service, kind) = match process {
        Some(p) => (p.network, p.name, "process"),
        None => match published_by(port).await {
            Some((network, service)) => (network, service, "container"),
            None => return Ok(None),
        },
    };
    let watching = watch(&network).await.is_ok();
    Ok(Some(Entry { network, service, kind, watching }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceNode {
    name: String,
    /// "container" | "process"
    kind: &'static str,
    /// Whether its own calls could be seen for the whole window
    watched: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    network: String,
    entry: String,
    from: u64,
    to: u64,
    hops: Vec<Hop>,
    nodes: Vec<TraceNode>,
}

/// Packets carry the Docker VM's clock; allow for it being a little off this Mac's
const SLACK_MS: u64 = 100;

/// What the request sent at `from` set off, up to `to`.
#[tauri::command]
pub async fn trace_query<R: Runtime>(app: AppHandle<R>, network: String, entry: String, from: u64, to: u64) -> CmdResult<Trace> {
    let place = place(&app, &network).await;
    let (hops, hooked) = {
        let book = BOOK.lock().unwrap();
        (hops(&book, &place, &entry, from.saturating_sub(SLACK_MS), to, now_ms()), book.hooked.clone())
    };
    let sniffed: HashMap<String, u64> = SNIFFERS.lock().unwrap().iter().map(|(id, s)| (id.clone(), s.since)).collect();
    let mut names = vec![entry.clone()];
    for h in hops.iter().filter(|h| h.kind == "service") {
        for n in [&h.from, &h.to] {
            if !names.contains(n) {
                names.push(n.clone());
            }
        }
    }
    let nodes = names
        .into_iter()
        .map(|name| {
            let process = place.processes.iter().find(|p| p.name == name && p.network == network);
            match process {
                Some(p) => TraceNode { watched: hooked.contains(&p.id), name, kind: "process" },
                None => {
                    let member = place.members.iter().find(|m| m.name == name);
                    let watched = member.and_then(|m| sniffed.get(&m.id)).is_some_and(|&since| since <= from);
                    TraceNode { name, kind: "container", watched }
                }
            }
        })
        .collect();
    Ok(Trace { network, entry, from, to, hops, nodes })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TraceLine {
    at: u64,
    /// "out" | "err" | "sys"
    stream: &'static str,
    text: String,
}

#[derive(Serialize)]
pub struct ServiceLines {
    service: String,
    lines: Vec<TraceLine>,
}

const MAX_TRACE_LINES: usize = 300;

/// Each service's output from just before `from` to `to`.
#[tauri::command]
pub async fn trace_logs<R: Runtime>(
    app: AppHandle<R>,
    network: String,
    services: Vec<String>,
    from: u64,
    to: u64,
) -> CmdResult<Vec<ServiceLines>> {
    let place = place(&app, &network).await;
    let docker = docker::docker().await.ok();
    let from = from.saturating_sub(SLACK_MS);
    let mut out = Vec::new();
    for service in services {
        let process = place.processes.iter().find(|p| p.name == service && p.network == network);
        let member = place.members.iter().find(|m| m.name == service && !m.proxy);
        let mut lines = match (process, member, &docker) {
            (Some(p), _, _) => process::lines_between(&app, &p.id, from, to)
                .into_iter()
                .map(|(at, stream, text)| TraceLine { at, stream, text })
                .collect(),
            (None, Some(m), Some(docker)) => container_lines(docker, &m.id, from, to).await,
            _ => Vec::new(),
        };
        lines.truncate(MAX_TRACE_LINES);
        out.push(ServiceLines { service, lines });
    }
    Ok(out)
}

async fn container_lines(docker: &Docker, id: &str, from: u64, to: u64) -> Vec<TraceLine> {
    let options = LogsOptionsBuilder::new()
        .stdout(true)
        .stderr(true)
        .timestamps(true)
        .since((from / 1000) as i32 - 1)
        .until((to / 1000) as i32 + 2)
        .build();
    let mut stream = docker.logs(id, Some(options));
    let mut out = Vec::new();
    while let Some(Ok(item)) = stream.next().await {
        let (stream_name, message) = match item {
            LogOutput::StdErr { message } => ("err", message),
            LogOutput::StdOut { message } | LogOutput::Console { message } => ("out", message),
            LogOutput::StdIn { .. } => continue,
        };
        for line in String::from_utf8_lossy(&message).lines() {
            let Some((ts, text)) = line.split_once(' ') else { continue };
            let Some(at) = docker_time(ts) else { continue };
            if (from..=to).contains(&at) && out.len() < MAX_TRACE_LINES {
                out.push(TraceLine { at, stream: stream_name, text: text.trim_end_matches('\r').to_string() });
            }
        }
    }
    out
}

/// `2026-11-01T12:05:52.604676123Z` → ms since the epoch.
fn docker_time(s: &str) -> Option<u64> {
    let (date, time) = s.strip_suffix('Z')?.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut t = hms.splitn(3, ':').map(|p| p.parse::<i64>());
    let (h, mi, sec) = (t.next()?.ok()?, t.next()?.ok()?, t.next()?.ok()?);
    let ms: i64 = format!("{frac:0<3}").get(..3)?.parse().ok()?;
    // Days from the civil date (Howard Hinnant's algorithm)
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from(((days * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + ms).ok()
}

// ---------------------------------------------------------------------------
// Sniffers

const SNIFF_IMAGE: &str = "uat/sniff:1";
const SNIFF_DOCKERFILE: &str = "FROM alpine:3.20\nRUN apk add --no-cache tcpdump\n";
const KIND_SNIFFER: &str = "sniffer";
const LABEL_TARGET: &str = "uat.sniff";
/// DNS answers, connection opens and resets, data the container sends, and
/// HTTP status lines it receives
const FILTER: &str = "(udp and src port 53) or (tcp[tcpflags] & (tcp-syn|tcp-rst) != 0) \
    or (outbound and tcp[tcpflags] & tcp-push != 0) \
    or (tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x48545450)";

struct Sniffer {
    sidecar: String,
    network: String,
    /// The target's start time; a restart puts it in a new namespace
    started_at: String,
    since: u64,
}

static SNIFFERS: LazyLock<Mutex<HashMap<String, Sniffer>>> = LazyLock::new(Default::default);
static WATCHED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
static SYNCING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LOOPING: AtomicBool = AtomicBool::new(false);

/// Watches every running container on `network`, now and as they start
/// and restart, for as long as the app runs.
pub(crate) async fn watch(network: &str) -> CmdResult<()> {
    WATCHED.lock().unwrap().insert(network.to_string());
    if !LOOPING.swap(true, Ordering::AcqRel) {
        tokio::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_secs(4)).await;
                let networks: Vec<String> = WATCHED.lock().unwrap().iter().cloned().collect();
                for n in networks {
                    let _ = sync(&n).await;
                }
            }
        });
    }
    sync(network).await
}

async fn sync(network: &str) -> CmdResult<()> {
    let _one = SYNCING.lock().await;
    let docker = docker::docker().await?;
    docker::ensure_image(&docker, SNIFF_IMAGE, &[("Dockerfile", SNIFF_DOCKERFILE)], "trace", &|_, _| {}).await?;
    let mut filters = HashMap::new();
    filters.insert("network", vec![network]);
    filters.insert("status", vec!["running"]);
    let list = docker
        .list_containers(Some(ListContainersOptionsBuilder::new().filters(&filters).build()))
        .await
        .map_err(err)?;

    let mut running = HashSet::new();
    let mut starts = Vec::new();
    for c in list {
        let Some(id) = c.id else { continue };
        running.insert(id.clone());
        let started_at = docker
            .inspect_container(&id, None)
            .await
            .ok()
            .and_then(|i| i.state)
            .and_then(|s| s.started_at)
            .unwrap_or_default();
        let live = SNIFFERS.lock().unwrap().get(&id).is_some_and(|s| s.started_at == started_at);
        if !live {
            starts.push(start(&docker, network, id, started_at));
        }
    }
    // Sidecars of containers that stopped or left
    let gone: Vec<String> = SNIFFERS
        .lock()
        .unwrap()
        .iter()
        .filter(|(id, s)| s.network == network && !running.contains(*id))
        .map(|(_, s)| s.sidecar.clone())
        .collect();
    for sidecar in gone {
        let _ = docker.remove_container(&sidecar, Some(RemoveContainerOptionsBuilder::default().force(true).build())).await;
    }
    let results = futures_util::future::join_all(starts).await;
    results.into_iter().find_map(Result::err).map_or(Ok(()), Err)
}

async fn start(docker: &Docker, network: &str, target: String, started_at: String) -> CmdResult<()> {
    let name = format!("uat-sniff-{}", target.get(..12).unwrap_or(&target));
    let force = || Some(RemoveContainerOptionsBuilder::default().force(true).build());
    // One left from an earlier run of the target or of the app
    let _ = docker.remove_container(&name, force()).await;
    let labels = HashMap::from([
        (LABEL_MANAGED.to_string(), "true".to_string()),
        (LABEL_KIND.to_string(), KIND_SNIFFER.to_string()),
        (LABEL_TARGET.to_string(), target.clone()),
    ]);
    let body = ContainerCreateBody {
        image: Some(SNIFF_IMAGE.into()),
        // Immediate mode: otherwise packets come in batches up to a second late
        cmd: Some(
            ["tcpdump", "--immediate-mode", "-i", "any", "-nn", "-U", "-s", "512", "-w", "-", FILTER]
                .map(String::from)
                .to_vec(),
        ),
        labels: Some(labels),
        host_config: Some(HostConfig {
            network_mode: Some(format!("container:{target}")),
            cap_add: Some(vec!["NET_RAW".into(), "NET_ADMIN".into()]),
            auto_remove: Some(true),
            log_config: Some(HostConfigLogConfig { typ: Some("none".into()), config: None }),
            ..Default::default()
        }),
        ..Default::default()
    };
    let created = docker
        .create_container(Some(CreateContainerOptionsBuilder::new().name(&name).build()), body)
        .await
        .map_err(err)?;
    let options = AttachContainerOptionsBuilder::new().stdout(true).stderr(true).stream(true).build();
    let attached = docker.attach_container(&created.id, Some(options)).await.map_err(err)?;
    SNIFFERS.lock().unwrap().insert(
        target.clone(),
        Sniffer { sidecar: created.id.clone(), network: network.to_string(), started_at, since: now_ms() },
    );
    let (ready, listening) = tokio::sync::oneshot::channel();
    tokio::spawn(capture(attached, target.clone(), created.id.clone(), ready));
    let started = docker.start_container(&created.id, None).await.map_err(err);
    let listening = tokio::time::timeout(Duration::from_secs(8), listening).await;
    if started.is_err() || !matches!(listening, Ok(Ok(()))) {
        let _ = docker.remove_container(&created.id, force()).await;
        SNIFFERS.lock().unwrap().remove(&target);
        return Err(started.err().unwrap_or_else(|| "The trace sidecar didn't start capturing".into()));
    }
    // Calls seen from here on
    if let Some(s) = SNIFFERS.lock().unwrap().get_mut(&target) {
        s.since = now_ms();
    }
    Ok(())
}

async fn capture(attached: AttachContainerResults, target: String, sidecar: String, ready: tokio::sync::oneshot::Sender<()>) {
    // Keep the write half: dropping it ends the attach
    let AttachContainerResults { mut output, input: _input } = attached;
    let mut ready = Some(ready);
    let mut said = String::new();
    let mut pcap = Pcap::default();
    while let Some(Ok(chunk)) = output.next().await {
        match chunk {
            LogOutput::StdOut { message } => {
                let mut book = BOOK.lock().unwrap();
                pcap.push(&message, |at, link, frame| {
                    if let Some(p) = decode(link, frame) {
                        book.packet(&target, at, &p);
                    }
                });
            }
            LogOutput::StdErr { message } if ready.is_some() => {
                said.push_str(&String::from_utf8_lossy(&message));
                if said.contains("listening on") {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(());
                    }
                }
            }
            _ => {}
        }
    }
    let mut sniffers = SNIFFERS.lock().unwrap();
    if sniffers.get(&target).is_some_and(|s| s.sidecar == sidecar) {
        sniffers.remove(&target);
    }
}

/// Builds the sniffer image ahead of the first trace.
#[tauri::command]
pub async fn trace_warm() -> CmdResult<()> {
    let docker = docker::docker().await?;
    docker::ensure_image(&docker, SNIFF_IMAGE, &[("Dockerfile", SNIFF_DOCKERFILE)], "trace", &|_, _| {}).await
}

pub(crate) async fn remove_sniffers() -> CmdResult<()> {
    docker::remove_kind(KIND_SNIFFER, None).await
}

/// Stops watching `network`, ahead of removing it: its sidecars go, and so
/// do any left beside `targets` (its containers) from an earlier run.
pub(crate) async fn unwatch(network: &str, targets: &[String]) {
    // A sync under way would start sidecars again
    let _one = SYNCING.lock().await;
    WATCHED.lock().unwrap().remove(network);
    SNIFFERS.lock().unwrap().retain(|target, s| s.network != network && !targets.contains(target));
    for target in targets {
        let _ = docker::remove_kind(KIND_SNIFFER, Some(&format!("{LABEL_TARGET}={target}"))).await;
    }
}

/// Removes the sidecars when the app quits.
pub fn stop_all() {
    if !SNIFFERS.lock().unwrap().is_empty() {
        let _ = tauri::async_runtime::block_on(remove_sniffers());
    }
}

// ---------------------------------------------------------------------------
// Node commands on the Mac

const HOOK: &str = include_str!("trace-hook.cjs");
const TRIM_AT: u64 = 4 << 20;

/// Env that makes Node in a command load the hook, given the command's own
/// NODE_OPTIONS, and the file the hook writes to (emptied for this run).
pub(crate) fn hook_env(process_id: &str, node_options: Option<&str>) -> std::io::Result<(Vec<String>, PathBuf)> {
    let dir = std::env::temp_dir().join("uat");
    std::fs::create_dir_all(&dir)?;
    let hook = dir.join("trace-hook.cjs");
    if std::fs::read_to_string(&hook).ok().as_deref() != Some(HOOK) {
        let tmp = dir.join(format!("trace-hook.{}.tmp", std::process::id()));
        std::fs::write(&tmp, HOOK)?;
        std::fs::rename(&tmp, &hook)?;
    }
    let file = dir.join(format!("trace-{process_id}.jsonl"));
    std::fs::write(&file, "")?;
    let require = format!("--require \"{}\"", hook.display());
    let options = match node_options.map(str::trim) {
        Some(o) if !o.is_empty() => format!("{o} {require}"),
        _ => require,
    };
    Ok((vec![format!("NODE_OPTIONS={options}"), format!("UAT_TRACE_FILE={}", file.display())], file))
}

/// Reads what the hook writes until `done` is set, then removes the file.
pub(crate) fn follow(process_id: String, path: PathBuf, done: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut offset = 0u64;
        let mut rest = Vec::new();
        loop {
            let last = done.load(Ordering::Acquire);
            if let Ok(f) = std::fs::File::open(&path) {
                let len = f.metadata().map(|m| m.len()).unwrap_or(0);
                if len < offset {
                    offset = 0;
                    rest.clear();
                }
                let mut f = f;
                if len > offset && f.seek(SeekFrom::Start(offset)).is_ok() {
                    if let Ok(n) = f.take(len - offset).read_to_end(&mut rest) {
                        offset += n as u64;
                    }
                    let mut book = BOOK.lock().unwrap();
                    while let Some(i) = rest.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = rest.drain(..=i).collect();
                        book.hook_line(&process_id, &String::from_utf8_lossy(&line));
                    }
                }
                // Keep it small; the hook appends, so it carries on at the start
                if offset > TRIM_AT && rest.is_empty() {
                    if let Ok(f) = OpenOptions::new().write(true).open(&path) {
                        let _ = f.set_len(0);
                        offset = 0;
                    }
                }
            }
            if last {
                break;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        let _ = std::fs::remove_file(&path);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Linux cooked v2 frame around an IPv4 packet.
    fn frame(outgoing: bool, src: [u8; 4], dst: [u8; 4], proto: u8, l4: &[u8]) -> Vec<u8> {
        let mut f = vec![0x08, 0x00, 0, 0, 0, 0, 0, 2, 0, 1, if outgoing { 4 } else { 0 }, 6];
        f.extend([0; 8]);
        let total = (20 + l4.len()) as u16;
        f.extend([0x45, 0, (total >> 8) as u8, total as u8, 0, 0, 0x40, 0, 64, proto, 0, 0]);
        f.extend(src);
        f.extend(dst);
        f.extend(l4);
        f
    }

    fn tcp(sport: u16, dport: u16, flags: u8, payload: &[u8]) -> Vec<u8> {
        let mut t = vec![(sport >> 8) as u8, sport as u8, (dport >> 8) as u8, dport as u8];
        t.extend([0; 8]);
        t.extend([0x50, flags, 0, 0, 0, 0, 0, 0]);
        t.extend(payload);
        t
    }

    fn dns_reply(name: &str, rcode: u8, addr: Option<[u8; 4]>) -> Vec<u8> {
        let mut d = vec![0x12, 0x34, 0x81, 0x80 | rcode, 0, 1, 0, addr.is_some() as u8, 0, 0, 0, 0];
        for label in name.split('.') {
            d.push(label.len() as u8);
            d.extend(label.as_bytes());
        }
        d.extend([0, 0, 1, 0, 1]);
        if let Some(a) = addr {
            d.extend([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]);
            d.extend(a);
        }
        let mut u = vec![0, 53, 0xa0, 0x00, 0, (8 + d.len()) as u8, 0, 0];
        u.extend(d);
        u
    }

    fn pcap(frames: &[(u64, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(0xa1b2_c3d4u32.to_le_bytes());
        out.extend([2, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0]);
        out.extend(276u32.to_le_bytes());
        for (ms, f) in frames {
            out.extend(((ms / 1000) as u32).to_le_bytes());
            out.extend((((ms % 1000) * 1000) as u32).to_le_bytes());
            out.extend((f.len() as u32).to_le_bytes());
            out.extend((f.len() as u32).to_le_bytes());
            out.extend(f);
        }
        out
    }

    const API: [u8; 4] = [172, 20, 0, 2];
    const DB: [u8; 4] = [172, 20, 0, 3];
    const LOCAL_DNS: [u8; 4] = [127, 0, 0, 11];
    const LO: [u8; 4] = [127, 0, 0, 1];

    fn member(id: &str, name: &str, ip: [u8; 4]) -> Member {
        Member { id: id.into(), name: name.into(), running: true, proxy: false, ips: vec![IpAddr::from(ip)], published: vec![] }
    }

    #[test]
    fn reads_calls_from_a_capture_split_anywhere() {
        let t = 1_800_000_000_000;
        let stream = pcap(&[
            (t, frame(false, LOCAL_DNS, LO, 17, &dns_reply("db", 0, Some(DB)))),
            (t + 1, frame(true, API, DB, 6, &tcp(40000, 5432, SYN, b""))),
            (t + 2, frame(false, DB, API, 6, &tcp(5432, 40000, SYN | ACK, b""))),
            (t + 3, frame(true, API, DB, 6, &tcp(40001, 8080, SYN, b""))),
            (t + 4, frame(false, DB, API, 6, &tcp(8080, 40001, RST | ACK, b""))),
            (t + 5, frame(false, LOCAL_DNS, LO, 17, &dns_reply("payments", 3, None))),
            (t + 6, frame(false, LOCAL_DNS, LO, 17, &dns_reply("payments", 0, None))),
            (t + 7, frame(true, API, DB, 6, &tcp(40002, 9000, PSH | ACK, b"GET /rides/42?full=1 HTTP/1.1\r\nHost: db\r\n\r\n"))),
            (t + 9, frame(false, DB, API, 6, &tcp(9000, 40002, PSH | ACK, b"HTTP/1.1 503 Service Unavailable\r\n"))),
            // Its own replies to someone calling it are not its calls
            (t + 10, frame(true, API, DB, 6, &tcp(3000, 50000, PSH | ACK, b"{\"ok\":true}"))),
        ]);
        let mut book = Book::default();
        let mut pcap = Pcap::default();
        for piece in stream.chunks(7) {
            pcap.push(piece, |at, link, f| {
                let p = decode(link, f).expect("decodes");
                book.packet("api-id", at, &p);
            });
        }
        let place = Place {
            network: "uat-net".into(),
            members: vec![member("api-id", "api", API), member("db-id", "db", DB)],
            ..Default::default()
        };
        let hops = hops(&book, &place, "api", t, t + 100, t + 100);
        let view: Vec<_> = hops.iter().map(|h| (h.to.as_str(), h.port, h.state, h.kind)).collect();
        assert_eq!(
            view,
            [
                ("db", Some(5432), "ok", "service"),
                ("db", Some(8080), "refused", "service"),
                ("payments", None, "unresolved", "external"),
                ("db", Some(9000), "ok", "service"),
            ]
        );
        assert_eq!(hops[2].error.as_deref(), Some("Not found on uat-net"));
        let r = &hops[3].requests[0];
        assert_eq!((r.method.as_str(), r.path.as_str(), r.status, r.ms), ("GET", "/rides/42?full=1", Some(503), Some(2)));
    }

    #[test]
    fn follows_the_calls_the_request_set_off() {
        let t = 1_800_000_000_000;
        let mut book = Book::default();
        let call = |book: &mut Book, from: &str, to: [u8; 4], port: u16, at: u64, ok: bool| {
            let conn = Conn::Tcp(from.into(), 40000 + at as u16 % 1000, IpAddr::from(to), port);
            book.connect(Caller::Container(from.into()), conn.clone(), Target::Addr(IpAddr::from(to), port), at);
            if ok {
                book.accepted(&conn);
            }
        };
        call(&mut book, "api-id", DB, 4000, t + 1, true); // api → rides
        call(&mut book, "db-id", [172, 20, 0, 4], 5432, t + 2, true); // rides → pg
        call(&mut book, "worker-id", DB, 4000, t + 3, true); // unrelated
        call(&mut book, "api-id", DB, 4000, t - 5000, true); // before the window
        call(&mut book, "api-id", [10, 0, 0, 9], 443, t + 4, false); // no answer yet
        book.hook_line("p1", r#"{"k":"hi","t":1}"#);
        let place = Place {
            network: "uat-net".into(),
            members: vec![
                member("api-id", "api", API),
                member("db-id", "rides", DB),
                member("pg-id", "pg", [172, 20, 0, 4]),
                member("worker-id", "worker", [172, 20, 0, 5]),
            ],
            ..Default::default()
        };
        let hops = hops(&book, &place, "api", t, t + 100, t + 10_000);
        let view: Vec<_> = hops.iter().map(|h| (h.from.as_str(), h.to.as_str(), h.state, h.count)).collect();
        assert_eq!(view, [("api", "rides", "ok", 1), ("rides", "pg", "ok", 1), ("api", "10.0.0.9", "timeout", 1)]);
        assert!(book.hooked.contains("p1"));
    }

    #[test]
    fn reads_the_node_hook() {
        let mut book = Book::default();
        let lines = [
            r#"{"k":"connect","c":"1.1","host":"localhost","port":5432,"t":100}"#,
            r#"{"k":"open","c":"1.1","t":101}"#,
            r#"{"k":"req","r":"1.2","host":"rides","port":4000,"method":"POST","path":"/quote","t":102}"#,
            r#"{"k":"connect","c":"1.3","host":"rides","port":4000,"t":102}"#,
            r#"{"k":"fail","c":"1.3","code":"ENOTFOUND","msg":"getaddrinfo ENOTFOUND rides","t":104}"#,
            r#"{"k":"rerr","r":"1.2","code":"ENOTFOUND","t":104}"#,
            r#"{"k":"connect","c":"1.4","host":"127.0.0.1","port":6379,"t":105}"#,
            r#"{"k":"fail","c":"1.4","code":"ECONNREFUSED","t":106}"#,
        ];
        for l in lines {
            book.hook_line("p1", l);
        }
        let place = Place {
            network: "uat-net".into(),
            members: vec![Member { published: vec![5432], ..member("pg-id", "pg", DB) }, member("rides-id", "rides", API)],
            processes: vec![ProcRef { id: "p1".into(), name: "web".into(), network: "uat-net".into(), ports: vec![3000], running: true }],
            ..Default::default()
        };
        let hops = hops(&book, &place, "web", 0, 1000, 1000);
        let view: Vec<_> = hops.iter().map(|h| (h.to.as_str(), h.port, h.state)).collect();
        assert_eq!(
            view,
            [("pg", Some(5432), "ok"), ("rides", Some(4000), "unresolved"), ("localhost", Some(6379), "refused")]
        );
        assert_eq!(hops[1].error.as_deref(), Some("Names don't resolve on this Mac. Publish a port and use localhost"));
        assert_eq!(hops[1].requests[0].error.as_deref(), Some("ENOTFOUND"));
    }

    #[test]
    fn a_proxy_that_cant_reach_its_command_fails_the_call() {
        let mut book = Book::default();
        let proxy_ip = [172, 20, 0, 9];
        let conn = Conn::Tcp("api-id".into(), 40000, IpAddr::from(proxy_ip), 5173);
        book.connect(Caller::Container("api-id".into()), conn.clone(), Target::Addr(IpAddr::from(proxy_ip), 5173), 10);
        book.accepted(&conn);
        let fwd = Conn::Tcp("proxy-id".into(), 41000, IpAddr::from([192, 168, 65, 254]), 5173);
        book.connect(Caller::Container("proxy-id".into()), fwd.clone(), Target::Addr(IpAddr::from([192, 168, 65, 254]), 5173), 11);
        book.failed(&fwd, Outcome::Refused, None);
        let place = Place {
            network: "uat-net".into(),
            members: vec![member("api-id", "api", API), Member { proxy: true, ..member("proxy-id", "web", proxy_ip) }],
            ..Default::default()
        };
        let hops = hops(&book, &place, "api", 0, 100, 100);
        assert_eq!(hops.len(), 1);
        assert_eq!((hops[0].to.as_str(), hops[0].state), ("web", "refused"));
        assert_eq!(hops[0].error.as_deref(), Some("web isn't listening on :5173 on this Mac"));
    }

    #[test]
    fn parses_urls_and_docker_times() {
        assert_eq!(host_port("http://localhost:3000/x?y"), Some(("localhost".into(), 3000)));
        assert_eq!(host_port("wss://[::1]/socket"), Some(("::1".into(), 443)));
        assert_eq!(host_port("localhost:8080"), Some(("localhost".into(), 8080)));
        assert_eq!(host_port("http://u:p@127.0.0.1"), Some(("127.0.0.1".into(), 80)));
        assert_eq!(docker_time("2026-11-01T12:05:52.604676123Z"), Some(1_793_534_752_604));
        assert_eq!(docker_time("1970-01-01T00:00:01Z"), Some(1000));
    }

    #[test]
    fn hook_env_keeps_the_commands_node_options() {
        let (env, file) = hook_env("test-env", Some("--max-old-space-size=4096")).unwrap();
        assert!(env[0].starts_with("NODE_OPTIONS=--max-old-space-size=4096 --require \""));
        assert!(env[0].ends_with("trace-hook.cjs\""));
        assert_eq!(env[1], format!("UAT_TRACE_FILE={}", file.display()));
        let _ = std::fs::remove_file(file);
    }

    /// Runs Node with the hook against a local server, a name that doesn't
    /// resolve and a closed port, and reads the hook's file the way the app does.
    #[test]
    fn node_hook_reports_calls() {
        let node = std::process::Command::new("node").arg("--version").output();
        if node.is_err() {
            eprintln!("node not on PATH; skipping");
            return;
        }
        let (env, file) = hook_env("test-node", None).unwrap();
        let script = r#"
            const http = require('http');
            const srv = http.createServer((q, s) => s.end('ok')).listen(0, async () => {
              const port = srv.address().port;
              await fetch(`http://127.0.0.1:${port}/a`).then((r) => r.text());
              await fetch('http://uat-no-such-service:8080/x').catch(() => {});
              await new Promise((r) => require('net').connect(9, '127.0.0.1').on('error', r));
              srv.close();
            });"#;
        let mut cmd = std::process::Command::new("node");
        cmd.arg("-e").arg(script);
        for kv in &env {
            let (k, v) = kv.split_once('=').unwrap();
            cmd.env(k, v);
        }
        assert!(cmd.status().unwrap().success());
        let mut book = Book::default();
        for line in std::fs::read_to_string(&file).unwrap().lines() {
            book.hook_line("p1", line);
        }
        let _ = std::fs::remove_file(&file);
        let place = Place {
            network: "uat-net".into(),
            processes: vec![ProcRef { id: "p1".into(), name: "web".into(), network: "uat-net".into(), ports: vec![], running: true }],
            ..Default::default()
        };
        let hops = hops(&book, &place, "web", 0, u64::MAX, now_ms());
        let view: Vec<_> = hops.iter().map(|h| (h.to.as_str(), h.state)).collect();
        assert_eq!(view, [("localhost", "ok"), ("uat-no-such-service", "unresolved"), ("localhost", "refused")]);
        assert_eq!(hops[0].requests[0].status, Some(200));
    }

    async fn run_container(docker: &Docker, network: &str, name: &str, image: &str, cmd: &[&str], publish: Option<(u16, u16)>) {
        use bollard::models::{EndpointSettings, NetworkingConfig, PortBinding};
        let mut host_config = HostConfig { network_mode: Some(network.into()), ..Default::default() };
        if let Some((container, host)) = publish {
            let binding = vec![PortBinding { host_ip: None, host_port: Some(host.to_string()) }];
            host_config.port_bindings = Some(HashMap::from([(format!("{container}/tcp"), Some(binding))]));
        }
        let body = ContainerCreateBody {
            image: Some(image.into()),
            cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
            exposed_ports: publish.map(|(c, _)| vec![format!("{c}/tcp")]),
            labels: Some(HashMap::from([(LABEL_SERVICE.to_string(), name.to_string())])),
            host_config: Some(host_config),
            networking_config: Some(NetworkingConfig {
                endpoints_config: Some(HashMap::from([(
                    network.to_string(),
                    EndpointSettings { aliases: Some(vec![name.into()]), ..Default::default() },
                )])),
            }),
            ..Default::default()
        };
        let options = CreateContainerOptionsBuilder::new().name(&format!("{network}-{name}")).build();
        let created = docker.create_container(Some(options), body).await.expect("create");
        docker.start_container(&created.id, None).await.expect("start");
    }

    fn get(port: u16, path: &str) -> String {
        use std::io::Write;
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connects");
        s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
        write!(s, "GET {path} HTTP/1.0\r\nHost: localhost\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    /// A request to a Node command on this Mac, which calls a container by
    /// its published port and another by a name the Mac can't resolve; the
    /// container then calls a third by name and a name that isn't on the
    /// network. Run with `cargo test -- --ignored --nocapture live_`.
    #[test]
    #[ignore = "needs a running Docker engine, node, and the redis, caddy and bun images"]
    fn live_trace_follows_a_request_across_the_mac_and_containers() {
        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().identifier = "dev.uat.test".into();
        let app = tauri::test::mock_builder().manage(process::Processes::default()).build(ctx).unwrap();
        let app = app.handle().clone();

        let pid = std::process::id();
        let network = format!("uat-trace-{pid}");
        let api_port = 39000 + (pid % 1000) as u16;
        let web_port = 38000 + (pid % 1000) as u16;
        let dir = std::env::temp_dir().join(format!("uat-trace-web-{pid}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("server.js"),
            format!(
                r#"const http = require('http');
http.createServer(async (req, res) => {{
  const a = await fetch('http://localhost:{api_port}/rides').then((r) => r.status).catch((e) => String(e));
  await fetch('http://store:8080/').catch(() => {{}});
  console.log('web handled', req.url, a);
  res.end('ok');
}}).listen({web_port}, '127.0.0.1', () => console.log('web listening'));"#
            ),
        )
        .unwrap();
        let api_script = "Bun.serve({ port: 3000, async fetch(req) { \
            const s = await fetch('http://store:8080/items?x=1').then((r) => r.status).catch((e) => String(e)); \
            await fetch('http://payments:8080/charge', { method: 'POST' }).catch(() => {}); \
            console.log('api handled', new URL(req.url).pathname, s); return new Response('ok'); } }); \
            console.log('api listening');";

        // Removes whatever was made, even when an assert fails
        struct Cleanup<R: Runtime> {
            app: AppHandle<R>,
            network: String,
            web: Arc<Mutex<String>>,
            dir: PathBuf,
        }
        impl<R: Runtime> Drop for Cleanup<R> {
            fn drop(&mut self) {
                let web = self.web.lock().unwrap().clone();
                tauri::async_runtime::block_on(async {
                    if !web.is_empty() {
                        let _ = process::process_delete(self.app.clone(), web).await;
                    }
                    let _ = remove_sniffers().await;
                    if let Ok(docker) = docker::docker().await {
                        let mut filters = HashMap::new();
                        filters.insert("network", vec![self.network.as_str()]);
                        let options = ListContainersOptionsBuilder::new().all(true).filters(&filters).build();
                        for c in docker.list_containers(Some(options)).await.unwrap_or_default() {
                            let force = RemoveContainerOptionsBuilder::default().force(true).build();
                            let _ = docker.remove_container(c.id.as_deref().unwrap_or_default(), Some(force)).await;
                        }
                        let _ = docker.remove_network(&self.network).await;
                    }
                });
                let _ = std::fs::remove_dir_all(&self.dir);
            }
        }
        let web = Arc::new(Mutex::new(String::new()));
        let _cleanup = Cleanup { app: app.clone(), network: network.clone(), web: web.clone(), dir: dir.clone() };

        let outcome = tauri::async_runtime::block_on(async {
            let docker = docker::docker().await?;
            docker::docker_create_network(network.clone()).await?;
            run_container(&docker, &network, "store", "caddy:2-alpine", &["caddy", "respond", "--listen", ":8080", "stored"], None).await;
            run_container(&docker, &network, "api", "oven/bun:1.3-slim", &["bun", "-e", api_script], Some((3000, api_port))).await;

            let def: process::NewProcess = serde_json::from_value(serde_json::json!({
                "network": network, "name": "web", "cwd": dir.display().to_string(),
                "command": "node server.js", "env": [], "ports": [web_port], "dependsOn": ["api"],
            }))
            .unwrap();
            let info = process::process_create(app.clone(), def)?;
            let web_id = serde_json::to_value(&info).unwrap()["id"].as_str().unwrap().to_string();
            *web.lock().unwrap() = web_id.clone();

            let api = format!("{network}-api");
            for _ in 0..60 {
                let api_up = docker.logs(&api, None::<bollard::query_parameters::LogsOptions>).count().await > 0;
                let web_up = process::lines_between(&app, &web_id, 0, u64::MAX).iter().any(|l| l.2.contains("web listening"));
                if api_up && web_up {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }

            let entry = trace_prepare(app.clone(), format!("http://localhost:{web_port}/home")).await?.ok_or("no entry")?;
            assert_eq!((entry.service.as_str(), entry.kind, entry.watching), ("web", "process", true));
            let entry = trace_prepare(app.clone(), format!("http://127.0.0.1:{api_port}/")).await?.ok_or("no entry")?;
            assert_eq!((entry.service.as_str(), entry.network.as_str(), entry.kind), ("api", network.as_str(), "container"));

            let t0 = now_ms();
            let body = tokio::task::spawn_blocking(move || get(web_port, "/home")).await.unwrap();
            let t1 = now_ms();
            assert!(body.ends_with("ok"), "{body}");
            tokio::time::sleep(Duration::from_millis(900)).await;

            let trace = trace_query(app.clone(), network.clone(), "web".into(), t0, t1 + 700).await?;
            for h in &trace.hops {
                println!("{} → {}:{:?} {} {:?} at +{}ms {:?}", h.from, h.to, h.port, h.state, h.error, h.at as i64 - t0 as i64, h.requests);
            }
            let find = |from: &str, to: &str| trace.hops.iter().find(|h| h.from == from && h.to == to).cloned();
            let web_api = find("web", "api").ok_or("web → api missing")?;
            assert_eq!((web_api.state, web_api.port), ("ok", Some(api_port)));
            assert_eq!(web_api.requests[0].status, Some(200));
            let web_store = find("web", "store").ok_or("web → store missing")?;
            assert_eq!(web_store.state, "unresolved");
            let api_store = find("api", "store").ok_or("api → store missing")?;
            assert_eq!((api_store.state, api_store.port), ("ok", Some(8080)));
            let r = &api_store.requests[0];
            assert_eq!((r.method.as_str(), r.path.as_str(), r.status), ("GET", "/items?x=1", Some(200)));
            let api_pay = find("api", "payments").ok_or("api → payments missing")?;
            assert_eq!((api_pay.state, api_pay.error.clone()), ("unresolved", Some(format!("Not found on {network}"))));
            // The VM's clock and this Mac's agree closely enough to window by time
            for h in &trace.hops {
                assert!(h.at + 200 >= t0 && h.at <= t1 + 200, "{} → {} at {} outside {t0}..{t1}", h.from, h.to, h.at);
            }
            let watched: Vec<_> = trace.nodes.iter().map(|n| (n.name.as_str(), n.watched)).collect();
            assert!(watched.contains(&("web", true)) && watched.contains(&("api", true)), "{watched:?}");

            let logs = trace_logs(app.clone(), network.clone(), vec!["web".into(), "api".into()], t0, t1 + 700).await?;
            let text = |i: usize| logs[i].lines.iter().map(|l| l.text.clone()).collect::<Vec<_>>().join("\n");
            assert!(text(0).contains("web handled /home 200"), "web logs: {}", text(0));
            assert!(text(1).contains("api handled /rides 200"), "api logs: {}", text(1));
            Ok::<_, String>(())
        });

        outcome.expect("the trace follows the request");
    }
}
