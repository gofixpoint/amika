import {
  CommandExitError,
  FileNotFoundError,
  Sandbox,
  SandboxNotFoundError,
  type CommandResult,
} from "e2b";
import { SANDBOX_ORG_ID_LABEL } from "../../../constants";
import type { SandboxCtx } from "../../../logger";
import type { SandboxStatus } from "../../../sandbox-status";
import type {
  CreateSandboxProviderInput,
  CreatedProviderSandbox,
  ExecCommandOptions,
  ProviderSandboxListing,
  RefreshUrlsResult,
  SandboxExecResult,
  SandboxService,
  StreamCommandHandlers,
} from "../../provider";
import type { SandboxAdapter } from "../../shared/adapter";
import type { E2bConfig } from "../config";
import { E2bAdapter } from "./adapter";
import { connectE2bSandbox, e2bApiOptions } from "./client";

export const E2B_URL_TTL_S = 24 * 60 * 60;
export const E2B_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const E2B_DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;

/** Translate Amika's idle-stop minutes into E2B's bounded timeout. */
export function e2bTimeoutMs(autoStopInterval?: number | null): number {
  if (autoStopInterval == null) return E2B_DEFAULT_TIMEOUT_MS;
  if (autoStopInterval <= 0) return E2B_MAX_TIMEOUT_MS;
  return Math.min(autoStopInterval * 60_000, E2B_MAX_TIMEOUT_MS);
}

export async function createE2bSandbox(
  ctx: SandboxCtx,
  config: E2bConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  if (!input.snapshot) {
    throw new Error(
      "E2B requires a prepared template (set the matching E2B_TEMPLATE_* variable)",
    );
  }
  ctx.logger.info(
    { name: input.name, snapshot: input.snapshot },
    "Creating E2B sandbox",
  );
  const metadata = {
    ...input.labels,
    "amika-sandbox-name": input.name,
  };
  const sandbox = await Sandbox.create(input.snapshot, {
    ...e2bApiOptions(config),
    metadata,
    timeoutMs: e2bTimeoutMs(input.autoStopInterval),
    lifecycle: {
      onTimeout: { action: "pause", keepMemory: false },
      autoResume: false,
    },
    network: { allowPublicTraffic: true },
  });
  return {
    provider: "e2b",
    providerSandboxId: sandbox.sandboxId,
    providerUrl: null,
    services: input.services,
    envVars: {},
  };
}

export async function startE2bSandbox(
  config: E2bConfig,
  providerSandboxId: string,
  autoStopInterval?: number | null,
): Promise<void> {
  const sandbox = await connectE2bSandbox(
    config,
    providerSandboxId,
    e2bTimeoutMs(autoStopInterval),
  );
  await sandbox.commands.run(e2bRouteRestoreCommand(), { user: "root" });
}

export async function stopE2bSandbox(
  config: E2bConfig,
  providerSandboxId: string,
): Promise<void> {
  await Sandbox.pause(providerSandboxId, {
    ...e2bApiOptions(config),
    keepMemory: false,
  });
}

export async function deleteE2bSandbox(
  config: E2bConfig,
  providerSandboxId: string,
): Promise<void> {
  await Sandbox.kill(providerSandboxId, e2bApiOptions(config));
}

export async function getE2bSandboxState(
  config: E2bConfig,
  providerSandboxId: string,
): Promise<string> {
  try {
    return (await Sandbox.getInfo(providerSandboxId, e2bApiOptions(config)))
      .state;
  } catch (error) {
    if (error instanceof SandboxNotFoundError) return "unknown";
    throw error;
  }
}

export function mapE2bSandboxState(state: string): SandboxStatus {
  switch (state) {
    case "running":
      return "running";
    case "paused":
      return "suspended";
    default:
      return "unknown";
  }
}

export async function refreshE2bUrls(
  config: E2bConfig,
  providerSandboxId: string,
  services: SandboxService[],
): Promise<RefreshUrlsResult> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  await sandbox.commands.run(e2bRouteSyncCommand(services), { user: "root" });
  const refreshed = services.map((service) => ({
    ...service,
    url: `https://${sandbox.getHost(service.containerPort)}`,
  }));
  return {
    providerUrl:
      refreshed.find((service) => service.name === "Coding Agent")?.url ?? null,
    services: refreshed,
  };
}

export async function syncE2bRoutes(
  config: E2bConfig,
  providerSandboxId: string,
  desired: SandboxService[],
): Promise<void> {
  const command = e2bRouteSyncCommand(desired);
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  await sandbox.commands.run(command, { user: "root" });
}

const E2B_ROUTE_CHAIN = "AMIKA_E2B_ROUTES";
const E2B_ROUTE_STATE_FILE = "/usr/local/etc/amikad/e2b-route-ports";
const E2B_ROUTE_DESIRED_FILE = "/usr/local/etc/amikad/e2b-route-desired-ports";

/**
 * Reconcile the public E2B ports Amika has managed before. E2B assigns a
 * public hostname to every sandbox port and has no per-port route API, so a
 * dedicated guest firewall chain is the revocation boundary. Remembering the
 * union of past and present ports lets a removed service stay blocked across
 * later reconciliations and filesystem-only pause/resume cycles. Ports Amika
 * has never advertised remain untouched.
 */
export function e2bRouteSyncCommand(desired: SandboxService[]): string {
  const desiredPorts = [
    ...new Set(desired.map((service) => service.containerPort)),
  ].sort((a, b) => a - b);
  for (const port of desiredPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid E2B service port: ${port}`);
    }
  }

  return e2bRouteFirewallCommand(
    `desired_ports='${desiredPorts.join(" ")}'`,
    true,
  );
}

/** Restore the last desired route set after a filesystem-only auto-pause. */
export function e2bRouteRestoreCommand(): string {
  return e2bRouteFirewallCommand(
    `if [ ! -f "$desired_state_file" ]; then exit 0; fi
desired_ports="$(cat "$desired_state_file")"`,
    false,
  );
}

function e2bRouteFirewallCommand(
  desiredPortsDeclaration: string,
  persistDesired: boolean,
): string {
  const persistDesiredCommand = persistDesired
    ? `
printf '%s\n' "$desired_ports" > "$desired_state_file.tmp"
mv "$desired_state_file.tmp" "$desired_state_file"`
    : "";

  return `set -eu
state_file=${E2B_ROUTE_STATE_FILE}
desired_state_file=${E2B_ROUTE_DESIRED_FILE}
chain=${E2B_ROUTE_CHAIN}
${desiredPortsDeclaration}

mkdir -p "$(dirname "$state_file")"
previous_ports="$(cat "$state_file" 2>/dev/null || true)"
managed_ports="$(printf '%s\n%s\n' "$previous_ports" "$desired_ports" | tr ' ' '\n' | awk 'NF' | sort -nu)"

firewall_count=0
for firewall in iptables ip6tables; do
  command -v "$firewall" >/dev/null 2>&1 || continue
  firewall_count=$((firewall_count + 1))
  "$firewall" -w -N "$chain" 2>/dev/null || true
  "$firewall" -w -C INPUT -j "$chain" 2>/dev/null || \
    "$firewall" -w -I INPUT 1 -j "$chain"
  "$firewall" -w -F "$chain"
  for port in $managed_ports; do
    case " $desired_ports " in
      *" $port "*) ;;
      *) "$firewall" -w -A "$chain" -p tcp --dport "$port" \
        -j REJECT --reject-with tcp-reset ;;
    esac
  done
done
[ "$firewall_count" -gt 0 ] || {
  echo "E2B route reconciliation requires iptables or ip6tables" >&2
  exit 1
}

printf '%s\n' "$managed_ports" > "$state_file.tmp"
mv "$state_file.tmp" "$state_file"${persistDesiredCommand}`;
}

export async function executeE2bCommand(
  config: E2bConfig,
  providerSandboxId: string,
  command: string,
  opts?: ExecCommandOptions,
): Promise<SandboxExecResult> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  if (opts?.input !== undefined) {
    const handle = await sandbox.commands.run(command, {
      ...commandOptions(opts),
      background: true,
      stdin: true,
    });
    await handle.sendStdin(opts.input);
    await handle.closeStdin();
    try {
      return await handle.wait();
    } catch (error) {
      if (error instanceof CommandExitError) return commandExitResult(error);
      throw error;
    }
  }
  try {
    return await sandbox.commands.run(command, commandOptions(opts));
  } catch (error) {
    if (error instanceof CommandExitError) return commandExitResult(error);
    throw error;
  }
}

export async function streamE2bCommand(
  config: E2bConfig,
  providerSandboxId: string,
  command: string,
  handlers: StreamCommandHandlers,
): Promise<void> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  await sandbox.commands.run(command, {
    timeoutMs: 0,
    onStdout: handlers.onStdout,
    onStderr: handlers.onStderr,
  });
}

export async function readE2bFile(
  config: E2bConfig,
  providerSandboxId: string,
  filePath: string,
): Promise<string | null> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  try {
    return await sandbox.files.read(filePath);
  } catch (error) {
    if (error instanceof FileNotFoundError) return null;
    throw error;
  }
}

export async function writeE2bFile(
  config: E2bConfig,
  providerSandboxId: string,
  filePath: string,
  content: Buffer | string,
): Promise<void> {
  const sandbox = await connectE2bSandbox(config, providerSandboxId);
  const data =
    typeof content === "string" ? content : Uint8Array.from(content).buffer;
  await sandbox.files.write(filePath, data);
}

export async function listE2bSandboxes(
  config: E2bConfig,
): Promise<ProviderSandboxListing[]> {
  const apiOptions = e2bApiOptions(config);
  const paginator = Sandbox.list(apiOptions);
  const listings: ProviderSandboxListing[] = [];
  while (paginator.hasNext) {
    const page = await paginator.nextItems();
    for (const info of page) {
      const metrics = await Sandbox.getMetrics(info.sandboxId, apiOptions);
      const latest = metrics.at(-1);
      if (!latest || latest.diskTotal <= 0) continue;
      listings.push({
        providerSandboxId: info.sandboxId,
        orgId: info.metadata[SANDBOX_ORG_ID_LABEL] ?? null,
        state: info.state,
        sizing: {
          vcpus: info.cpuCount,
          memoryGib: info.memoryMB / 1024,
          diskGib: latest.diskTotal / 1024 ** 3,
        },
      });
    }
  }
  return listings;
}

export async function openE2bAdapter(
  config: E2bConfig,
  providerSandboxId: string,
): Promise<SandboxAdapter> {
  return new E2bAdapter(await connectE2bSandbox(config, providerSandboxId));
}

function commandOptions(opts?: ExecCommandOptions) {
  return {
    cwd: opts?.cwd,
    envs: opts?.env,
    user: opts?.sudo ? ("root" as const) : undefined,
    timeoutMs: 0,
  };
}

function commandExitResult(error: CommandExitError): CommandResult {
  return {
    exitCode: error.exitCode,
    stdout: error.stdout,
    stderr: error.stderr,
    ...(error.error ? { error: error.error } : {}),
  };
}
