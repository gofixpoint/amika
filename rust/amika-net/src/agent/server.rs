//! The agent process: one iroh endpoint with the device key, serving
//! `connect` clients on a Unix socket.

use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use clap::Args;
use iroh::{
    Endpoint, EndpointId,
    endpoint::{Connection, RecvStream, SendStream},
};
use tokio::{
    net::{UnixListener, UnixStream},
    signal::unix::{SignalKind, signal},
    sync::Notify,
};
use tracing::{debug, info, warn};

use super::{
    peer,
    proto::{self, Action, AgentHello, AgentView, ClientHello, Decision, Reply, Request},
    rundir::{self, AgentPaths, FileId},
};
use crate::{
    connect::{self, HostAddrArgs},
    header::Target,
    keys, net, paths, pipe,
};

/// How long a client may take to send its hello and its request.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the agent checks its lifecycle when nothing else wakes it.
const TICK: Duration = Duration::from_secs(1);
/// A log file larger than this is moved aside when the agent starts.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Args)]
pub struct RunArgs {
    /// The device's endpoint key file (made with mode 600 if missing).
    #[arg(long)]
    pub key_file: PathBuf,
    /// The agent's directory (socket and start lock).
    #[arg(long, env = "AMIKA_NET_AGENT_DIR")]
    pub agent_dir: Option<PathBuf>,
    /// Exit after this many seconds with no clients.
    #[arg(long, default_value_t = super::DEFAULT_IDLE_EXIT_SECS)]
    pub idle_exit_secs: u64,
    /// The log file. Default: amika/amika-net/agent.log in the state directory.
    #[arg(long)]
    pub log_file: Option<PathBuf>,
    #[command(flatten)]
    pub net: net::NetArgs,
}

pub async fn run(args: RunArgs) -> Result<()> {
    let paths = AgentPaths::new(args.agent_dir.as_deref())?;
    rundir::ensure_private_dir(&paths.dir)?;
    let config = super::agent_config(&args.key_file, &args.net)?;
    let secret = keys::load_or_create(&args.key_file)?;
    let ep = net::builder(&args.net, secret).await?.bind().await?;
    net::spawn_home_relay_logger(&ep);
    let ep2 = ep.clone();
    tokio::spawn(async move { net::report_online(&ep2, Duration::from_secs(15)).await });

    let listener = bind_socket(&paths.socket)?;
    let agent = Arc::new(Agent::new(
        ep.clone(),
        config,
        paths.socket.clone(),
        FileId::of(&paths.socket)?,
    ));
    info!(
        pid = std::process::id(),
        build = %agent.build,
        endpoint = %ep.id(),
        socket = %paths.socket.display(),
        idle_exit_secs = args.idle_exit_secs,
        "agent ready"
    );
    let result = agent
        .clone()
        .serve(listener, Duration::from_secs(args.idle_exit_secs))
        .await;
    agent.remove_socket();
    ep.close().await;
    info!("agent exited");
    result
}

/// Opens the agent's log file for appending. Moves a large old file aside.
pub fn open_log(path: &Path) -> Result<fs::File> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    if fs::metadata(path).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))
}

fn bind_socket(path: &Path) -> Result<UnixListener> {
    if rundir::clear_stale_socket(path)? {
        bail!("another agent listens on {}", path.display());
    }
    let listener =
        UnixListener::bind(path).with_context(|| format!("binding {}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

struct Agent {
    ep: Endpoint,
    build: String,
    proto: (u32, u32),
    config: String,
    socket: PathBuf,
    socket_id: FileId,
    state: Mutex<State>,
    changed: Notify,
    /// One connection per host, reused by every stream to it.
    hosts: Mutex<HashMap<EndpointId, Arc<tokio::sync::Mutex<Option<Connection>>>>>,
}

#[derive(Debug, Clone, Copy)]
struct State {
    /// Accepted clients, from accept to close.
    clients: usize,
    /// Clients whose stream to a host is open.
    streams: usize,
    /// Exit when the last stream ends: another build asked.
    retiring: bool,
    /// Take no new streams, and exit when the last client ends.
    draining: bool,
    /// When `clients` last fell to zero.
    idle_since: Instant,
}

/// What the agent does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Wait,
    Drain(&'static str),
    Exit,
}

/// The agent's lifecycle rules.
fn next_step(s: &State, now: Instant, idle_exit: Duration) -> Step {
    if s.draining {
        return if s.clients == 0 {
            Step::Exit
        } else {
            Step::Wait
        };
    }
    if s.retiring && s.streams == 0 {
        return Step::Drain("retired after its last stream");
    }
    if s.clients == 0 && now.duration_since(s.idle_since) >= idle_exit {
        return Step::Drain("idle");
    }
    Step::Wait
}

impl Agent {
    fn new(ep: Endpoint, config: String, socket: PathBuf, socket_id: FileId) -> Self {
        Self {
            ep,
            build: proto::build(),
            proto: proto::proto_range(),
            config,
            socket,
            socket_id,
            state: Mutex::new(State {
                clients: 0,
                streams: 0,
                retiring: false,
                draining: false,
                idle_since: Instant::now(),
            }),
            changed: Notify::new(),
            hosts: Mutex::new(HashMap::new()),
        }
    }

    /// Accepts clients until the lifecycle says to exit or a signal comes.
    async fn serve(self: Arc<Self>, listener: UnixListener, idle_exit: Duration) -> Result<()> {
        let mut term = signal(SignalKind::terminate())?;
        let mut int = signal(SignalKind::interrupt())?;
        loop {
            match next_step(&self.state(), Instant::now(), idle_exit) {
                Step::Exit => return Ok(()),
                Step::Drain(reason) => self.begin_drain(reason),
                Step::Wait => {}
            }
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let agent = self.clone();
                        tokio::spawn(async move { agent.serve_client(stream).await });
                    }
                    Err(e) => warn!(error = %e, "accept failed"),
                },
                _ = self.changed.notified() => {}
                _ = tokio::time::sleep(TICK) => {}
                _ = term.recv() => { info!("SIGTERM; exiting"); return Ok(()); }
                _ = int.recv() => { info!("SIGINT; exiting"); return Ok(()); }
            }
        }
    }

    async fn serve_client(self: Arc<Self>, stream: UnixStream) {
        let _client = self.track(|s| &mut s.clients);
        if let Err(e) = peer::check_same_user(&stream) {
            if is_closed(&e) {
                debug!("a client closed at once (a readiness probe)");
            } else {
                warn!(error = %format!("{e:#}"), "refused a client");
            }
            return;
        }
        if let Err(e) = self.handle(stream).await {
            info!(error = %format!("{e:#}"), "client ended with an error");
        }
    }

    async fn handle(&self, mut stream: UnixStream) -> Result<()> {
        let hello =
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, proto::read_client_hello(&mut stream))
                .await
            {
                Ok(Ok(hello)) => hello,
                Ok(Err(e)) if is_closed(&e) => {
                    debug!("a client closed before its hello (a readiness probe)");
                    return Ok(());
                }
                Ok(Err(e)) => return Err(e).context("reading the hello"),
                Err(_) => bail!("no hello in {HANDSHAKE_TIMEOUT:?}"),
            };
        let decision = self.decide(&hello);
        proto::write_agent_hello(&mut stream, &self.hello(decision.action.clone())).await?;
        if !matches!(decision.action, Action::Use { .. }) {
            return Ok(());
        }
        let request =
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, proto::read_request(&mut stream)).await {
                Ok(Ok(request)) => request,
                Ok(Err(e)) if is_closed(&e) => {
                    debug!("a client closed after the hello (agent status)");
                    return Ok(());
                }
                Ok(Err(e)) => return Err(e).context("reading the request"),
                Err(_) => bail!("no request in {HANDSHAKE_TIMEOUT:?}"),
            };
        match request {
            Request::Stop => {
                self.begin_drain("stop requested");
                proto::write_reply(&mut stream, &Reply::Ok).await
            }
            Request::Connect { host, target } => self.serve_stream(stream, &host, &target).await,
        }
    }

    /// Decides how to answer a hello, and applies the decision's retire or
    /// drain before the answer goes out. A draining agent has removed its
    /// socket by then, so the client's new agent can bind the path.
    fn decide(&self, hello: &ClientHello) -> Decision {
        let mut state = self.state.lock().expect("poisoned");
        let view = AgentView {
            proto_min: self.proto.0,
            proto_max: self.proto.1,
            build: self.build.clone(),
            config: self.config.clone(),
            streams: state.streams,
            draining: state.draining,
        };
        let decision = proto::decide(&view, hello);
        info!(
            client_build = %hello.build,
            client_proto = ?(hello.proto_min, hello.proto_max),
            control = hello.config.is_none(),
            action = ?decision.action,
            "hello"
        );
        if decision.retire && !state.retiring {
            state.retiring = true;
            info!(client_build = %hello.build, "another build asked; retiring after the last stream");
        }
        drop(state);
        if decision.drain {
            self.begin_drain("a client needs another agent");
        }
        decision
    }

    async fn serve_stream(
        &self,
        mut stream: UnixStream,
        host: &HostAddrArgs,
        target: &Target,
    ) -> Result<()> {
        let (send, recv) = match self.open(host, target).await {
            Ok(s) => s,
            Err(e) => {
                info!(host = %host.host_id, %target, error = %format!("{e:#}"), "stream failed");
                return proto::write_reply(&mut stream, &Reply::Error(format!("{e:#}"))).await;
            }
        };
        proto::write_reply(&mut stream, &Reply::Ok).await?;
        let _stream = self.track(|s| &mut s.streams);
        info!(host = %host.host_id, %target, "stream opened");
        let (to_client, to_host) = pipe::splice(stream, send, recv).await;
        info!(host = %host.host_id, %target, to_client, to_host, "stream finished");
        Ok(())
    }

    /// Opens a stream to `target`, on the host's cached connection if it is
    /// still open. If the cached connection closed under us, dials once more.
    async fn open(&self, host: &HostAddrArgs, target: &Target) -> Result<(SendStream, RecvStream)> {
        let conn = self.connection(host).await?;
        match connect::open_target(&conn, target).await {
            Err(_) if conn.close_reason().is_some() => {
                info!(host = %host.host_id, "the host connection closed; dialing again");
                let conn = self.connection(host).await?;
                connect::open_target(&conn, target).await
            }
            r => r,
        }
    }

    /// Returns the open connection to the host, dialing when there is none.
    /// Clients of the same host wait for one dial.
    async fn connection(&self, host: &HostAddrArgs) -> Result<Connection> {
        let slot = self
            .hosts
            .lock()
            .expect("poisoned")
            .entry(host.host_id)
            .or_default()
            .clone();
        let mut cached = slot.lock().await;
        if let Some(conn) = cached.as_ref().filter(|c| c.close_reason().is_none()) {
            return Ok(conn.clone());
        }
        let conn = connect::dial(&self.ep, host).await?;
        paths::spawn_logger(&conn, "agent");
        *cached = Some(conn.clone());
        Ok(conn)
    }

    fn hello(&self, action: Action) -> AgentHello {
        let state = self.state();
        AgentHello {
            build: self.build.clone(),
            pid: std::process::id(),
            endpoint: self.ep.id(),
            streams: state.streams,
            retiring: state.retiring,
            action,
        }
    }

    fn state(&self) -> State {
        *self.state.lock().expect("poisoned")
    }

    /// Stops taking new streams. Removes the socket first, so the path is
    /// free for a new agent while this one finishes its streams.
    fn begin_drain(&self, reason: &str) {
        {
            let mut state = self.state.lock().expect("poisoned");
            if state.draining {
                return;
            }
            state.draining = true;
        }
        self.remove_socket();
        info!(reason, streams = self.state().streams, "draining");
        self.changed.notify_one();
    }

    fn remove_socket(&self) {
        if let Err(e) = rundir::remove_socket_if_ours(&self.socket, self.socket_id) {
            warn!(error = %format!("{e:#}"), "could not remove the socket");
        }
    }

    /// Counts one unit in the field that `field` picks, until the guard drops.
    fn track(&self, field: fn(&mut State) -> &mut usize) -> Tracked<'_> {
        *field(&mut self.state.lock().expect("poisoned")) += 1;
        Tracked { agent: self, field }
    }
}

struct Tracked<'a> {
    agent: &'a Agent,
    field: fn(&mut State) -> &mut usize,
}

impl Drop for Tracked<'_> {
    fn drop(&mut self) {
        let mut state = self.agent.state.lock().expect("poisoned");
        *(self.field)(&mut state) -= 1;
        if state.clients == 0 {
            state.idle_since = Instant::now();
        }
        drop(state);
        self.agent.changed.notify_one();
    }
}

/// Whether `e` means the client had already closed its socket.
fn is_closed(e: &anyhow::Error) -> bool {
    use std::io::ErrorKind::{ConnectionReset, NotConnected, UnexpectedEof};
    e.chain()
        .filter_map(|c| c.downcast_ref::<std::io::Error>())
        .any(|io| matches!(io.kind(), UnexpectedEof | NotConnected | ConnectionReset))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(clients: usize, streams: usize, retiring: bool, draining: bool) -> State {
        State {
            clients,
            streams,
            retiring,
            draining,
            idle_since: Instant::now(),
        }
    }

    #[test]
    fn idle_agent_drains_after_the_idle_period() {
        let idle = Duration::from_secs(600);
        let s = state(0, 0, false, false);
        assert_eq!(next_step(&s, s.idle_since, idle), Step::Wait);
        assert_eq!(
            next_step(&s, s.idle_since + idle, idle),
            Step::Drain("idle")
        );
        let busy = state(1, 1, false, false);
        assert_eq!(
            next_step(&busy, busy.idle_since + idle * 2, idle),
            Step::Wait
        );
    }

    #[test]
    fn retiring_agent_drains_after_its_last_stream() {
        let idle = Duration::from_secs(600);
        let s = state(1, 1, true, false);
        assert_eq!(next_step(&s, s.idle_since, idle), Step::Wait);
        let s = state(1, 0, true, false);
        assert_eq!(
            next_step(&s, s.idle_since, idle),
            Step::Drain("retired after its last stream")
        );
    }

    #[test]
    fn draining_agent_exits_when_its_clients_end() {
        let idle = Duration::from_secs(600);
        let s = state(2, 1, false, true);
        assert_eq!(next_step(&s, s.idle_since, idle), Step::Wait);
        let s = state(0, 0, false, true);
        assert_eq!(next_step(&s, s.idle_since, idle), Step::Exit);
    }
}
