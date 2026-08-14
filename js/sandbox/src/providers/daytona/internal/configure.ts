/**
 * Daytona-specific adapter configuration.
 *
 * The bulk of the adapter provisioning (credentials, lifecycle scripts, MCP
 * wiring, `/etc/environment`) lives in the provider-agnostic
 * `../shared/configure-adapter` and runs against the {@link SandboxAdapter}
 * port. What is here is genuinely Daytona-specific — repo cloning via the
 * SDK's first-class `git.clone`, and the Docker quiesce/restart around a Daytona
 * snapshot.
 */
import { Sandbox } from "@daytonaio/sdk";
import {
  buildGitCheckoutNewBranchCmd,
  checkBranchExistsOnRemote,
  isBranchNotFoundError,
} from "../../../util/git-clone";
import { shellQuote } from "../../../util/shell";
import {
  executeCheckedCommand,
  executeCommand,
  getWorkspaceDir,
  getRepoDir,
} from "./commands";

function getGitCredentials(githubToken?: string | null): {
  username?: string;
  password?: string;
} {
  if (!githubToken) {
    return {};
  }

  return {
    username: "x-access-token",
    password: githubToken,
  };
}

/**
 * Best-effort shell to stop the Docker daemon and quiesce its on-disk
 * state before a snapshot is captured. Runs as root via `bash -c`.
 *
 *  - Exits immediately on a non-dind sandbox (no `dockerd` binary).
 *  - Records the running containers (so {@link startDockerForSnapshot} can
 *    restart exactly those if the source sandbox is kept), then stops them
 *    first so their overlay mounts are released (a bare daemon stop leaves
 *    them mounted when `live-restore` is on).
 *  - Wraps every Docker CLI call in `timeout`: a wedged-but-still-listening
 *    daemon would otherwise hang `docker ps`/`docker stop` indefinitely
 *    (`docker stop -t` is the container grace period, not a client/daemon
 *    call timeout), stalling a request that already holds the
 *    `snapshotting` claim. On timeout we fall through to killing the daemon.
 *  - Stops the daemon via whatever supervises it, falling back to
 *    signalling the process directly — Daytona sandboxes typically run no
 *    systemd, so `pkill` is the path that actually fires.
 *  - Waits (bounded) for `dockerd` to exit so its overlay unmounts and
 *    network teardown finish before the filesystem is frozen.
 *  - Always exits 0: a teardown hiccup must never block the snapshot.
 */
const STOP_DOCKER_SCRIPT = `
command -v dockerd >/dev/null 2>&1 || exit 0

if command -v docker >/dev/null 2>&1; then
  timeout 30 docker ps -q 2>/dev/null \\
    > /var/run/amika-snapshot-running-containers
  xargs -r timeout 60 docker stop -t 10 \\
    < /var/run/amika-snapshot-running-containers 2>/dev/null
fi

systemctl stop docker.socket docker 2>/dev/null \\
  || service docker stop 2>/dev/null \\
  || pkill -TERM dockerd 2>/dev/null

for _ in $(seq 1 30); do
  pgrep -x dockerd >/dev/null 2>&1 || break
  sleep 0.5
done

systemctl stop containerd 2>/dev/null \\
  || service containerd stop 2>/dev/null \\
  || pkill -TERM containerd 2>/dev/null

rm -f /var/run/docker.pid /run/docker.pid 2>/dev/null

exit 0
`;

/**
 * Stop the Docker daemon and leave `/var/lib/docker` at rest before a
 * snapshot is captured.
 *
 * Dind sandboxes (`coder-dind` preset) start `dockerd` from the image's
 * `pre-setup.sh` hook on every boot. A snapshot taken while the daemon is
 * live bakes in the source sandbox's mid-flight Docker state — active
 * overlay mounts and network namespaces that no longer exist on a fresh
 * boot. A sandbox restored from that snapshot then stalls in `dockerd`
 * recovery and blows the hook's 30s readiness wait, surfacing as
 * "dockerd did not become ready within 30s" during sandbox init.
 *
 * Stopping the daemon cleanly first releases those mounts and tears down
 * networking, so the captured `/var/lib/docker` restores fast (images and
 * build cache are preserved — only running state is dropped). Best-effort
 * and a no-op on non-dind sandboxes; never throws on a stop failure.
 */
export async function stopDockerForSnapshot(sandbox: Sandbox): Promise<void> {
  await executeCommand(sandbox, `bash -c ${shellQuote(STOP_DOCKER_SCRIPT)}`, {
    sudo: true,
  });
}

/**
 * Best-effort shell to bring the Docker daemon back up after a capture,
 * undoing {@link stopDockerForSnapshot}. Runs as root via `bash -c`.
 *
 *  - Exits immediately on a non-dind sandbox (no `dockerd`).
 *  - Starts the daemon if it isn't running: prefers a service manager,
 *    falling back to launching `dockerd` directly in the background —
 *    Daytona dind sandboxes run no systemd, so the bare relaunch is the
 *    path that actually fires.
 *  - Once the daemon is back, restarts the containers
 *    {@link stopDockerForSnapshot} stopped — those without an
 *    auto-restart policy won't come back on daemon start otherwise, so
 *    dev services would stay down. This runs in a bounded background
 *    subshell so it never blocks the snapshot flow.
 *  - Always exits 0.
 */
const START_DOCKER_SCRIPT = `
command -v dockerd >/dev/null 2>&1 || exit 0

if ! pgrep -x dockerd >/dev/null 2>&1; then
  systemctl start docker.socket docker 2>/dev/null \\
    || service docker start 2>/dev/null \\
    || { nohup dockerd >/var/log/dockerd-restart.log 2>&1 & }
fi

# Restart the containers we stopped for the capture, once the daemon is
# ready. Backgrounded + bounded so a slow/failed daemon can't stall us.
running_file=/var/run/amika-snapshot-running-containers
(
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 1
  done
  if [ -s "$running_file" ]; then
    xargs -r docker start < "$running_file" >/dev/null 2>&1
  fi
  rm -f "$running_file"
) >/dev/null 2>&1 &

exit 0
`;

/**
 * Restart the Docker daemon on a sandbox that survives a capture.
 *
 * {@link stopDockerForSnapshot} quiesces Docker so the captured filesystem
 * is clean, on the assumption that "snapshot and delete" then deletes the
 * source. When that delete does NOT happen — the capture failed, or the
 * durability wait timed out and the source is restored to `active` — the
 * kept sandbox would otherwise be left with its containers and daemon
 * down. Bring Docker back so the user's workloads recover.
 *
 * The capture has already frozen the filesystem by the time this runs, so
 * restarting the live daemon does not affect the snapshot. Best-effort,
 * fire-and-forget, and a no-op on non-dind sandboxes. (On the success path
 * the source is deleted immediately after, so this is a harmless no-op
 * there.)
 *
 * Swallows its own errors so it never throws: callers invoke it in a
 * `finally` after a *successful* capture, where a thrown restart error
 * would mask the capture and make the flow treat a captured snapshot as
 * failed (orphaning the provider snapshot).
 */
export async function startDockerForSnapshot(sandbox: Sandbox): Promise<void> {
  try {
    await executeCommand(
      sandbox,
      `bash -c ${shellQuote(START_DOCKER_SCRIPT)}`,
      {
        sudo: true,
      },
    );
  } catch {
    // Best-effort recovery — never let a restart failure change the
    // capture's outcome.
  }
}

export async function cloneRepository(
  sandbox: Sandbox,
  homeDir: string,
  githubUrl: string,
  repoName?: string | null,
  githubToken?: string | null,
  branch?: string,
): Promise<void> {
  const workspaceDir = getWorkspaceDir(homeDir);
  const repoDir = getRepoDir(homeDir, repoName);

  await executeCheckedCommand(sandbox, `mkdir -p ${workspaceDir}`, {
    cwd: homeDir,
  });
  await executeCheckedCommand(
    sandbox,
    repoName ? `rm -rf ${repoDir}` : `rm -rf ${workspaceDir}`,
    { cwd: homeDir },
  );

  const credentials = getGitCredentials(githubToken);
  try {
    await sandbox.git.clone(
      githubUrl,
      repoDir,
      branch,
      undefined,
      credentials.username,
      credentials.password,
    );
  } catch (err) {
    if (!branch) {
      throw err;
    }
    if (!isBranchNotFoundError(err)) {
      // Daytona SDK may not produce standard git error messages — verify
      // the branch actually exists on the remote before giving up.
      const exists = await checkBranchExistsOnRemote(
        githubUrl,
        githubToken,
        branch,
      );
      if (exists) {
        throw err; // Branch exists; failure is something else
      }
    }
    // Branch doesn't exist on remote: clone the default branch, then create it.
    await sandbox.git.clone(
      githubUrl,
      repoDir,
      undefined,
      undefined,
      credentials.username,
      credentials.password,
    );
    await executeCheckedCommand(sandbox, buildGitCheckoutNewBranchCmd(branch), {
      cwd: repoDir,
    });
  }
}
