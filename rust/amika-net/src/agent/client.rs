//! The client side of the agent: how `connect` finds the agent, starts one
//! when there is none, and opens a stream through it.

use std::{
    io,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use clap::Args;
use tokio::net::UnixStream;
use tracing::{debug, info, warn};

use super::{
    peer,
    proto::{self, Action, AgentHello, ClientHello, Reply, Request},
    rundir::{self, AgentPaths, SocketState},
    server,
};
use crate::{
    connect::ConnectArgs,
    net::{self, EndpointArgs, RelayChoice},
    pipe,
};

/// How many times `connect` looks for a usable agent before it gives up.
const MAX_ATTEMPTS: usize = 5;
/// How long the agent may take to answer a hello.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the agent may take to dial a host and open the stream.
const REPLY_TIMEOUT: Duration = Duration::from_secs(60);
/// How long to wait for another process's agent start.
const LOCK_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a new agent may take to listen on its socket.
const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Options for the agent that `connect` uses, and starts when needed.
#[derive(Debug, Clone, Args)]
pub struct AgentOpts {
    /// The agent's directory (socket and start lock). Default:
    /// $XDG_RUNTIME_DIR/amika-net, else ~/.cache/amika/amika-net.
    #[arg(long, env = "AMIKA_NET_AGENT_DIR")]
    pub agent_dir: Option<PathBuf>,
    /// For an agent that this connect starts: seconds with no clients before
    /// it exits.
    #[arg(long, default_value_t = super::DEFAULT_IDLE_EXIT_SECS)]
    pub agent_idle_exit_secs: u64,
    /// For an agent that this connect starts: its log file. Default:
    /// amika/amika-net/agent.log in the state directory.
    #[arg(long)]
    pub agent_log_file: Option<PathBuf>,
}

/// Asks the agent for a stream to the target on the host, then pipes stdin
/// and stdout through it. Starts an agent if none answers.
pub async fn connect(args: &ConnectArgs) -> Result<()> {
    let opts = &args.agent;
    let key_file = args.key_file.as_path();
    let relay = args.relay_choice();
    let paths = AgentPaths::new(opts.agent_dir.as_deref())?;
    rundir::ensure_private_dir(&paths.dir)?;
    let log_file = match &opts.agent_log_file {
        Some(p) => std::path::absolute(p)?,
        None => rundir::default_log_file(|k| std::env::var_os(k))?,
    };
    let hello = ClientHello::this_process(Some(super::agent_config(key_file, &args.net, relay)?));
    let start = StartSpec {
        args: agent_args(opts, &paths, &log_file, key_file, &args.net, relay)?,
        log_file,
    };
    let mut stream = open_session(&paths, &hello, Some(&start)).await?;

    let request = Request::Connect {
        host: args.host.clone(),
        target: args.target.clone(),
    };
    proto::write_request(&mut stream, &request).await?;
    let reply = tokio::time::timeout(REPLY_TIMEOUT, proto::read_reply(&mut stream))
        .await
        .context("the agent did not answer the request")??;
    if let Reply::Error(detail) = reply {
        bail!("{detail}");
    }
    let (recv, send) = stream.into_split();
    pipe::stdio(send, recv).await?;
    Ok(())
}

/// Sends a control request (`agent status` or `agent stop`) to the running
/// agent. Returns `None` when no agent runs.
pub async fn control(dir: Option<&Path>, request: Option<Request>) -> Result<Option<AgentHello>> {
    let paths = AgentPaths::new(dir)?;
    let hello = ClientHello::this_process(None);
    let Some((mut stream, agent)) = say_hello(&paths.socket, &hello).await? else {
        return Ok(None);
    };
    if let Action::Refuse(detail) = &agent.action {
        bail!("the agent refused: {detail}");
    }
    if let Some(request) = request {
        proto::write_request(&mut stream, &request).await?;
        if let Reply::Error(detail) = proto::read_reply(&mut stream).await? {
            bail!("{detail}");
        }
    }
    Ok(Some(agent))
}

/// How to start an agent.
struct StartSpec {
    args: Vec<String>,
    log_file: PathBuf,
}

/// Returns a socket to an agent that answered `use`. Starts an agent when
/// there is none, or when the agent there leaves for a newer one.
async fn open_session(
    paths: &AgentPaths,
    hello: &ClientHello,
    start: Option<&StartSpec>,
) -> Result<UnixStream> {
    let mut last_error = None;
    for _ in 0..MAX_ATTEMPTS {
        match say_hello(&paths.socket, hello).await {
            Ok(Some((stream, agent))) => match agent.action {
                Action::Use { proto } => {
                    debug!(pid = agent.pid, build = %agent.build, proto, "using the agent");
                    return Ok(stream);
                }
                Action::Replace => info!(
                    pid = agent.pid,
                    build = %agent.build,
                    "the agent is leaving for a new one"
                ),
                Action::Refuse(detail) => bail!("the agent refused: {detail}"),
            },
            Ok(None) => debug!("no agent is running"),
            // An agent that exits between our connect and its answer.
            Err(e) => {
                warn!(error = %format!("{e:#}"), "the agent did not answer");
                last_error = Some(e);
            }
        }
        let Some(start) = start else {
            bail!("no agent is running");
        };
        start_agent(paths, start)?;
    }
    match last_error {
        Some(e) => Err(e.context(format!("no usable agent after {MAX_ATTEMPTS} attempts"))),
        None => bail!("no usable agent after {MAX_ATTEMPTS} attempts"),
    }
}

/// Connects and exchanges hellos. `None` means no agent listens.
async fn say_hello(socket: &Path, hello: &ClientHello) -> Result<Option<(UnixStream, AgentHello)>> {
    let mut stream = match UnixStream::connect(socket).await {
        Ok(s) => s,
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(None);
        }
        Err(e) => return Err(e).with_context(|| format!("connecting to {}", socket.display())),
    };
    peer::check_same_user(&stream).context("the agent's socket")?;
    proto::write_client_hello(&mut stream, hello).await?;
    let agent = tokio::time::timeout(HELLO_TIMEOUT, proto::read_agent_hello(&mut stream))
        .await
        .context("the agent did not answer the hello")??;
    Ok(Some((stream, agent)))
}

/// Starts an agent, unless another process starts one first. Holds the
/// start lock from the stale-socket check until the new agent listens, so
/// two racing `connect`s start one agent.
fn start_agent(paths: &AgentPaths, start: &StartSpec) -> Result<()> {
    let _lock = rundir::lock(&paths.lock, LOCK_TIMEOUT)?;
    if rundir::clear_stale_socket(&paths.socket)? {
        debug!("another process started an agent");
        return Ok(());
    }
    let mut child = spawn_detached(&start.args, &start.log_file)?;
    info!(pid = child.id(), log = %start.log_file.display(), "started an agent");
    let started = Instant::now();
    loop {
        if rundir::probe_socket(&paths.socket)? == SocketState::Live {
            break;
        }
        if let Some(status) = child.try_wait()? {
            bail!(
                "the agent exited at start ({status}); see {}",
                start.log_file.display()
            );
        }
        if started.elapsed() > READY_TIMEOUT {
            bail!(
                "the agent did not listen within {READY_TIMEOUT:?}; see {}",
                start.log_file.display()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // Reap the agent if it exits while this process still runs. When this
    // process exits first, init adopts the agent.
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Starts this binary as an agent in a new session, so it has no
/// controlling terminal and outlives the SSH session that started it.
fn spawn_detached(args: &[String], log_file: &Path) -> Result<Child> {
    let exe = std::env::current_exe().context("finding this binary")?;
    // Panics and early errors go to the same file as the agent's logs.
    let stderr = server::open_log(log_file)?;
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .current_dir("/");
    // SAFETY: the closure runs in the child between fork and exec, and calls
    // only setsid, which is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().context("starting the agent")
}

/// The command line of an agent with this client's key and options.
fn agent_args(
    opts: &AgentOpts,
    paths: &AgentPaths,
    log_file: &Path,
    key_file: &Path,
    net: &EndpointArgs,
    relay: RelayChoice,
) -> Result<Vec<String>> {
    let mut args = vec![
        "agent".to_string(),
        "run".into(),
        "--key-file".into(),
        net::absolute(key_file)?,
        "--agent-dir".into(),
        net::absolute(&paths.dir)?,
        "--idle-exit-secs".into(),
        opts.agent_idle_exit_secs.to_string(),
        "--log-file".into(),
        net::absolute(log_file)?,
    ];
    args.extend(net.to_args(relay)?);
    Ok(args)
}
