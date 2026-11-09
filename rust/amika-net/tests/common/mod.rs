//! A test bed on one machine: a TCP echo server, a host role in front of
//! it, and a fake hostd on the host's control socket that allows one client
//! key. Clients run the real `amika-net` binary.

#![allow(dead_code)]

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{
            net::{UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Output, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

pub const BIN: &str = env!("CARGO_BIN_EXE_amika-net");

/// Options for the host and the clients.
pub struct NetOpts {
    /// Endpoint flags for the host.
    pub host: Vec<String>,
    /// Endpoint flags for the clients.
    pub client: Vec<String>,
    /// Whether clients pass the host's loopback address.
    pub host_addr: bool,
}

impl NetOpts {
    /// No relays: every connection is direct on loopback.
    pub fn offline() -> Self {
        let none = ["--relay", "none"].map(String::from).to_vec();
        Self {
            host: none.clone(),
            client: none,
            host_addr: true,
        }
    }
}

pub struct Bed {
    pub dir: PathBuf,
    pub agent_dir: PathBuf,
    pub log: PathBuf,
    pub client_key: PathBuf,
    pub client_id: String,
    pub host_id: String,
    pub host_relay: Option<String>,
    /// Every message the fake hostd got.
    pub hostd: Arc<Mutex<Vec<Value>>>,
    host_port: u16,
    host: Child,
    opts: NetOpts,
    /// Every agent pid seen, to stop them all at the end.
    seen: std::sync::Mutex<Vec<u32>>,
}

impl Bed {
    pub fn new(name: &str) -> Self {
        Self::with(name, NetOpts::offline())
    }

    pub fn with(name: &str, opts: NetOpts) -> Self {
        // Short paths: a Unix socket path has a limit of about 100 bytes.
        let dir = std::env::temp_dir().join(format!("ant-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let echo = start_echo_server();
        let client_key = dir.join("client.key");
        let client_id = key_id(&client_key);
        let socket = dir.join("hostd.sock");
        let hostd = start_fake_hostd(&socket, client_id.clone(), echo);
        let host_log = fs::File::create(dir.join("host.log")).unwrap();
        let mut cmd = Command::new(BIN);
        cmd.args(["host", "--control-socket"])
            .arg(&socket)
            .args(["--key-fd", "3", "--bind", "127.0.0.1:0"])
            .args(&opts.host)
            .stderr(host_log);
        let _key_pipe = pass_key_on_fd_3(&mut cmd);
        let host = cmd.spawn().unwrap();
        let mut bed = Self {
            agent_dir: dir.join("agent"),
            log: dir.join("agent.log"),
            dir,
            client_key,
            client_id,
            host_id: String::new(),
            host_relay: None,
            hostd,
            host_port: 0,
            host,
            opts,
            seen: Default::default(),
        };
        bed.host_port = bed.wait_for_bind();
        (bed.host_id, bed.host_relay) = bed.wait_for_ready();
        bed
    }

    /// Waits for the host to bind, and returns its IPv4 UDP port. The host
    /// picks the port itself: a port picked here could be taken by another
    /// test's endpoint before the host binds it.
    fn wait_for_bind(&self) -> u16 {
        let log = self.dir.join("host.log");
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            let text = fs::read_to_string(&log).unwrap_or_default();
            let port = text
                .lines()
                .find(|l| l.contains("host bound"))
                .and_then(|l| l.split("127.0.0.1:").nth(1))
                .and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|p| p.parse().ok());
            if let Some(port) = port {
                return port;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("host did not bind:\n{}", fs::read_to_string(&log).unwrap());
    }

    /// Waits for the host's `ready` on the control socket, and returns its
    /// endpoint id and, unless clients dial the loopback address, its home
    /// relay.
    fn wait_for_ready(&self) -> (String, Option<String>) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            let msgs = self.hostd.lock().unwrap().clone();
            let id = msgs
                .iter()
                .find(|m| m["type"] == "ready")
                .and_then(|m| m["endpoint_id"].as_str())
                .map(str::to_string);
            let relay = msgs
                .iter()
                .filter_map(|m| m["relay_url"].as_str())
                .next_back()
                .map(str::to_string);
            match (id, relay) {
                (Some(id), _) if self.opts.host_addr => return (id, None),
                (Some(id), Some(relay)) => return (id, Some(relay)),
                _ => thread::sleep(Duration::from_millis(100)),
            }
        }
        panic!(
            "host did not report ready with a relay:\n{}",
            fs::read_to_string(self.dir.join("host.log")).unwrap()
        );
    }

    /// The messages of one type that the fake hostd got.
    pub fn hostd_messages(&self, kind: &str) -> Vec<Value> {
        let msgs = self.hostd.lock().unwrap();
        msgs.iter().filter(|m| m["type"] == kind).cloned().collect()
    }

    /// The `connect` command line, through the agent unless `extra` says
    /// `--direct`.
    pub fn connect_cmd(&self, target: &str, extra: &[&str]) -> Command {
        self.connect_cmd_as(&self.client_key, &self.agent_dir, target, extra)
    }

    /// The `connect` command line with another device key and agent.
    pub fn connect_cmd_as(
        &self,
        key: &Path,
        agent_dir: &Path,
        target: &str,
        extra: &[&str],
    ) -> Command {
        let mut cmd = Command::new(BIN);
        cmd.args(["connect", "--key-file"])
            .arg(key)
            .args(["--endpoint", &self.host_id, "--target", target])
            .arg("--agent-dir")
            .arg(agent_dir)
            .arg("--agent-log-file")
            .arg(&self.log)
            .args(&self.opts.client)
            .args(extra);
        if self.opts.host_addr {
            cmd.args(["--direct-addr", &format!("127.0.0.1:{}", self.host_port)]);
        }
        if let Some(relay) = &self.host_relay {
            cmd.args(["--relay-url", relay]);
        }
        cmd
    }

    /// Starts a session to the echo target.
    pub fn session(&self, extra: &[&str], env: &[(&str, &str)]) -> Session {
        let mut cmd = self.connect_cmd("rig:r1:7", extra);
        cmd.envs(env.iter().copied());
        Session::spawn(cmd, self.dir.join(format!("connect-{}.err", next_id())))
    }

    /// Runs `agent status`. Returns `None` if no agent runs.
    pub fn status(&self) -> Option<Status> {
        self.status_with(&[])
    }

    /// Runs `agent status` with extra environment variables.
    pub fn status_with(&self, env: &[(&str, &str)]) -> Option<Status> {
        let out = Command::new(BIN)
            .args(["agent", "status", "--agent-dir"])
            .arg(&self.agent_dir)
            .envs(env.iter().copied())
            .output()
            .unwrap();
        assert!(out.status.success(), "status failed: {}", stderr(&out));
        let status = Status::parse(&String::from_utf8_lossy(&out.stdout));
        if let Some(s) = &status {
            self.seen.lock().unwrap().push(s.pid);
        }
        status
    }

    /// Runs `agent stop`.
    pub fn stop_agent(&self) -> Output {
        Command::new(BIN)
            .args(["agent", "stop", "--agent-dir"])
            .arg(&self.agent_dir)
            .output()
            .unwrap()
    }

    /// How many agents started, from the shared log.
    pub fn agents_started(&self) -> usize {
        self.agent_log().matches("agent ready").count()
    }

    pub fn agent_log(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }

    pub fn socket(&self) -> PathBuf {
        self.agent_dir.join("agent.sock")
    }
}

impl Drop for Bed {
    fn drop(&mut self) {
        let mut pids = self.seen.lock().unwrap().clone();
        pids.extend(self.status_quiet().map(|s| s.pid));
        for pid in pids {
            if alive(pid) {
                kill(pid);
            }
        }
        let _ = self.host.kill();
        let _ = self.host.wait();
        if !thread::panicking() {
            let _ = fs::remove_dir_all(&self.dir);
        } else {
            eprintln!("test files kept in {}", self.dir.display());
            eprintln!("agent log:\n{}", self.agent_log());
        }
    }
}

impl Bed {
    fn status_quiet(&self) -> Option<Status> {
        let out = Command::new(BIN)
            .args(["agent", "status", "--agent-dir"])
            .arg(&self.agent_dir)
            .output()
            .ok()?;
        Status::parse(&String::from_utf8_lossy(&out.stdout))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub build: String,
    pub pid: u32,
    pub streams: usize,
    pub retiring: bool,
}

impl Status {
    fn parse(text: &str) -> Option<Self> {
        let get = |key: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix(&format!("{key} ")))
                .map(str::to_string)
        };
        Some(Self {
            build: get("build")?,
            pid: get("pid")?.parse().ok()?,
            streams: get("streams")?.parse().ok()?,
            retiring: get("retiring")?.parse().ok()?,
        })
    }
}

/// One `connect` process with a line-based echo session.
pub struct Session {
    pub child: Child,
    stdin: Option<ChildStdin>,
    lines: mpsc::Receiver<String>,
    pub stderr_path: PathBuf,
    sent: usize,
}

impl Session {
    fn spawn(mut cmd: Command, stderr_path: PathBuf) -> Self {
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(fs::File::create(&stderr_path).unwrap())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Self {
            stdin: child.stdin.take(),
            child,
            lines,
            stderr_path,
            sent: 0,
        }
    }

    /// Sends one line and waits for its echo.
    pub fn echo(&mut self, timeout: Duration) -> Result<(), String> {
        self.sent += 1;
        let line = format!("line {}", self.sent);
        let stdin = self.stdin.as_mut().ok_or("stdin is closed")?;
        writeln!(stdin, "{line}").map_err(|e| format!("write: {e}"))?;
        stdin.flush().map_err(|e| format!("flush: {e}"))?;
        match self.lines.recv_timeout(timeout) {
            Ok(got) if got == line => Ok(()),
            Ok(got) => Err(format!("expected {line:?}, got {got:?}")),
            Err(e) => Err(format!(
                "no echo for {line:?} in {timeout:?}: {e}; {}",
                self.stderr()
            )),
        }
    }

    /// Echoes lines for `period`, one every `every`, failing on the first miss.
    pub fn echo_for(&mut self, period: Duration, every: Duration) -> Result<usize, String> {
        let end = Instant::now() + period;
        let mut n = 0;
        while Instant::now() < end {
            self.echo(Duration::from_secs(5))?;
            n += 1;
            thread::sleep(every);
        }
        Ok(n)
    }

    /// Closes stdin and waits for the process to exit.
    pub fn close(mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        wait_timeout(&mut self.child, Duration::from_secs(10)).expect("connect did not exit")
    }

    pub fn stderr(&self) -> String {
        fs::read_to_string(&self.stderr_path).unwrap_or_default()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn wait_timeout(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        thread::sleep(Duration::from_millis(20));
    }
    None
}

/// Waits until `f` is true, or panics with `what`.
pub fn wait_until(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + timeout;
    while Instant::now() < end {
        if f() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for: {what}");
}

pub fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn kill(pid: u32) {
    // SAFETY: sends SIGTERM to a process this test started.
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

pub fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn key_id(path: &Path) -> String {
    let out = Command::new(BIN)
        .args(["id", "--key-file"])
        .arg(path)
        .output()
        .unwrap();
    assert!(out.status.success(), "id failed: {}", stderr(&out));
    String::from_utf8(out.stdout).unwrap().trim().to_string()
}

fn start_echo_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { continue };
            thread::spawn(move || {
                let mut out = conn.try_clone().unwrap();
                let mut buf = [0u8; 4096];
                loop {
                    match conn.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if out.write_all(&buf[..n]).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    addr
}

fn next_id() -> usize {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

/// Gives the child a random host key on file descriptor 3, as hostd does.
/// Returns the pipe's read end, which must live until the spawn.
fn pass_key_on_fd_3(cmd: &mut Command) -> OwnedFd {
    let mut key = [0u8; 32];
    fs::File::open("/dev/urandom")
        .unwrap()
        .read_exact(&mut key)
        .unwrap();
    let (r, mut w) = std::io::pipe().unwrap();
    w.write_all(&key).unwrap();
    drop(w);
    let r = OwnedFd::from(r);
    let fd = r.as_raw_fd();
    // SAFETY: the closure runs in the child between fork and exec, and calls
    // only dup2 and fcntl, which are async-signal-safe.
    unsafe {
        cmd.pre_exec(move || {
            let ok = if fd == 3 {
                libc::fcntl(3, libc::F_SETFD, 0) != -1
            } else {
                libc::dup2(fd, 3) != -1
            };
            if ok {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    r
}

/// A fake hostd on `socket`. It allows the client key, maps `rig:r1:7` to
/// the echo server, and refuses other targets. It records every message.
fn start_fake_hostd(socket: &Path, client_id: String, echo: SocketAddr) -> Arc<Mutex<Vec<Value>>> {
    let listener = UnixListener::bind(socket).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen2 = seen.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            serve_hostd(stream, &client_id, echo, &seen2);
        }
    });
    seen
}

fn serve_hostd(stream: UnixStream, client_id: &str, echo: SocketAddr, seen: &Mutex<Vec<Value>>) {
    let mut out = stream.try_clone().unwrap();
    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { return };
        let msg: Value = serde_json::from_str(&line).unwrap();
        seen.lock().unwrap().push(msg.clone());
        let reply = match msg["type"].as_str() {
            Some("check_peer") => json!({
                "id": msg["id"],
                "allowed": msg["endpoint_id"] == client_id,
                "kind": "device",
                "principal": { "kind": "user", "id": "user_1" },
            }),
            Some("open") => {
                let target = msg["target"].as_str().unwrap_or_default();
                let mut reply = match target {
                    "rig:r1:7" => json!({ "ok": true, "connect": echo.to_string() }),
                    t if t.starts_with("rig:r1:") => {
                        json!({ "ok": false, "reason": "port_not_allowed" })
                    }
                    "hostd" => json!({ "ok": false, "reason": "not_allowed" }),
                    _ => json!({ "ok": false, "reason": "unknown_rig" }),
                };
                reply["id"] = msg["id"].clone();
                reply
            }
            _ => continue,
        };
        if writeln!(out, "{reply}").is_err() {
            return;
        }
    }
}
