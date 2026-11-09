//! Where the agent lives on disk: a private per-user directory with the
//! socket and the start lock, and a log file in the user's state directory.

use std::{
    ffi::OsString,
    fs::{self, DirBuilder, File},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};

/// The socket path limit is 104 bytes on macOS and 108 on Linux, with the
/// final NUL.
const MAX_SOCKET_PATH: usize = 103;

/// The agent's files.
#[derive(Debug, Clone)]
pub struct AgentPaths {
    pub dir: PathBuf,
    pub socket: PathBuf,
    pub lock: PathBuf,
}

impl AgentPaths {
    /// Returns the paths in `dir`, or in the default directory.
    pub fn new(dir: Option<&Path>) -> Result<Self> {
        let dir = match dir {
            Some(d) => std::path::absolute(d)?,
            None => default_dir(env)?,
        };
        let socket = dir.join("agent.sock");
        if socket.as_os_str().len() > MAX_SOCKET_PATH {
            bail!(
                "agent socket path {} is too long for a Unix socket; set --agent-dir",
                socket.display()
            );
        }
        Ok(Self {
            lock: dir.join("agent.lock"),
            socket,
            dir,
        })
    }
}

/// The default agent directory: `$XDG_RUNTIME_DIR/amika-net` when it is set
/// (Linux sessions), else `amika/amika-net` in the user's cache directory
/// (macOS, and Linux without a runtime directory).
pub fn default_dir(env: impl Fn(&str) -> Option<OsString>) -> Result<PathBuf> {
    if let Some(run) = env("XDG_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(run).join("amika-net"));
    }
    Ok(xdg_home(&env, "XDG_CACHE_HOME", ".cache")?.join("amika/amika-net"))
}

/// The default agent log file: `amika/amika-net/agent.log` in the user's
/// state directory, as the amika CLI keeps its state.
pub fn default_log_file(env: impl Fn(&str) -> Option<OsString>) -> Result<PathBuf> {
    Ok(xdg_home(&env, "XDG_STATE_HOME", ".local/state")?.join("amika/amika-net/agent.log"))
}

fn env(key: &str) -> Option<OsString> {
    std::env::var_os(key)
}

fn xdg_home(
    env: &impl Fn(&str) -> Option<OsString>,
    key: &str,
    under_home: &str,
) -> Result<PathBuf> {
    if let Some(v) = env(key).filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(v));
    }
    let home = env("HOME")
        .filter(|v| !v.is_empty())
        .context("HOME is not set")?;
    Ok(PathBuf::from(home).join(under_home))
}

/// Makes `dir` if it is missing, with mode 0700. Refuses a directory that
/// is a symlink, that another user owns, or that other users can open.
pub fn ensure_private_dir(dir: &Path) -> Result<()> {
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }
    match DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e).with_context(|| format!("creating {}", dir.display())),
    }
    check_private_dir(dir, current_uid())
}

fn check_private_dir(dir: &Path, uid: u32) -> Result<()> {
    let meta = fs::symlink_metadata(dir).with_context(|| format!("reading {}", dir.display()))?;
    if !meta.file_type().is_dir() {
        bail!("{} is not a directory", dir.display());
    }
    if meta.uid() != uid {
        bail!(
            "{} is owned by uid {}, not by this user (uid {uid})",
            dir.display(),
            meta.uid()
        );
    }
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        bail!(
            "{} has mode {mode:o}; it must be 700 (run: chmod 700 {})",
            dir.display(),
            dir.display()
        );
    }
    Ok(())
}

/// This process's effective user id.
pub fn current_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// What is at the socket path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketState {
    /// Nothing.
    Missing,
    /// A socket that a process listens on.
    Live,
    /// A file that no process listens on: a dead agent's socket.
    Stale,
}

/// Probes the socket path with a plain connect.
pub fn probe_socket(path: &Path) -> Result<SocketState> {
    match std::os::unix::net::UnixStream::connect(path) {
        Ok(_) => Ok(SocketState::Live),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(SocketState::Missing),
        Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => Ok(SocketState::Stale),
        Err(e) => Err(e).with_context(|| format!("probing {}", path.display())),
    }
}

/// Removes a stale socket. Returns whether a live agent holds the path.
/// Call it with the start lock held, so no new agent binds in between.
pub fn clear_stale_socket(path: &Path) -> Result<bool> {
    match probe_socket(path)? {
        SocketState::Live => Ok(true),
        SocketState::Missing => Ok(false),
        SocketState::Stale => {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e).with_context(|| format!("removing {}", path.display())),
            }
            tracing::info!(socket = %path.display(), "removed a stale agent socket");
            Ok(false)
        }
    }
}

/// The identity of a file, to tell our socket from a newer agent's socket
/// at the same path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId {
    dev: u64,
    ino: u64,
}

impl FileId {
    pub fn of(path: &Path) -> io::Result<Self> {
        let meta = fs::symlink_metadata(path)?;
        Ok(Self {
            dev: meta.dev(),
            ino: meta.ino(),
        })
    }
}

/// Removes the socket at `path` if it is still the file `id`. A newer agent
/// may have bound the path since, and its socket must stay.
pub fn remove_socket_if_ours(path: &Path, id: FileId) -> Result<bool> {
    match FileId::of(path) {
        Ok(now) if now == id => {
            fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
            Ok(true)
        }
        Ok(_) => Ok(false),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// The start lock: one process at a time may start an agent. It is an
/// advisory `flock`, so the kernel releases it when its holder exits.
#[derive(Debug)]
pub struct StartLock {
    _file: File,
}

/// Takes the start lock, waiting up to `timeout`.
pub fn lock(path: &Path, timeout: Duration) -> Result<StartLock> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    let started = Instant::now();
    loop {
        // SAFETY: the descriptor is open for the whole call.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            return Ok(StartLock { _file: file });
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::WouldBlock {
            return Err(err).with_context(|| format!("locking {}", path.display()));
        }
        if started.elapsed() >= timeout {
            bail!("timed out waiting for {}", path.display());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixListener;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("an-rd-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.into())
    }

    #[test]
    fn default_dir_prefers_the_runtime_dir() {
        let env = env_of(&[("XDG_RUNTIME_DIR", "/run/user/7"), ("HOME", "/home/u")]);
        assert_eq!(
            default_dir(env).unwrap(),
            PathBuf::from("/run/user/7/amika-net")
        );
        let env = env_of(&[("XDG_CACHE_HOME", "/c"), ("HOME", "/home/u")]);
        assert_eq!(
            default_dir(env).unwrap(),
            PathBuf::from("/c/amika/amika-net")
        );
        let env = env_of(&[("XDG_RUNTIME_DIR", ""), ("HOME", "/Users/u")]);
        assert_eq!(
            default_dir(env).unwrap(),
            PathBuf::from("/Users/u/.cache/amika/amika-net")
        );
        assert!(default_dir(env_of(&[])).is_err());
    }

    #[test]
    fn default_log_file_is_in_the_state_dir() {
        let env = env_of(&[("HOME", "/home/u")]);
        assert_eq!(
            default_log_file(env).unwrap(),
            PathBuf::from("/home/u/.local/state/amika/amika-net/agent.log")
        );
    }

    #[test]
    fn private_dir_is_made_0700_and_loose_modes_are_refused() {
        let dir = temp_dir("priv");
        let agent = dir.join("agent");
        ensure_private_dir(&agent).unwrap();
        let mode = fs::metadata(&agent).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        ensure_private_dir(&agent).unwrap();

        fs::set_permissions(&agent, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ensure_private_dir(&agent).is_err());

        let link = dir.join("link");
        fs::set_permissions(&agent, fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink(&agent, &link).unwrap();
        assert!(ensure_private_dir(&link).is_err());

        assert!(check_private_dir(&agent, current_uid() + 1).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stale_socket_is_removed_and_a_live_one_is_kept() {
        let dir = temp_dir("stale");
        fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("s");
        assert_eq!(probe_socket(&sock).unwrap(), SocketState::Missing);
        assert!(!clear_stale_socket(&sock).unwrap());

        let live = UnixListener::bind(&sock).unwrap();
        assert_eq!(probe_socket(&sock).unwrap(), SocketState::Live);
        assert!(clear_stale_socket(&sock).unwrap());
        assert!(sock.exists());

        drop(live);
        assert_eq!(probe_socket(&sock).unwrap(), SocketState::Stale);
        assert!(!clear_stale_socket(&sock).unwrap());
        assert!(!sock.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_our_own_socket_is_removed() {
        let dir = temp_dir("own");
        fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("s");
        let first = UnixListener::bind(&sock).unwrap();
        let ours = FileId::of(&sock).unwrap();
        // A newer agent replaces the path.
        fs::remove_file(&sock).unwrap();
        let _second = UnixListener::bind(&sock).unwrap();
        assert!(!remove_socket_if_ours(&sock, ours).unwrap());
        assert!(sock.exists());
        let theirs = FileId::of(&sock).unwrap();
        assert!(remove_socket_if_ours(&sock, theirs).unwrap());
        assert!(!sock.exists());
        drop(first);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn start_lock_admits_one_holder_at_a_time() {
        let dir = temp_dir("lock");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.lock");
        let held = lock(&path, Duration::from_millis(10)).unwrap();
        // flock locks belong to the open file, so a second open in the same
        // process contends like another process.
        assert!(lock(&path, Duration::from_millis(100)).is_err());
        drop(held);
        let again = lock(&path, Duration::from_millis(100)).unwrap();
        drop(again);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn long_socket_paths_are_refused() {
        let long = PathBuf::from("/").join("d".repeat(120));
        assert!(AgentPaths::new(Some(&long)).is_err());
    }
}
