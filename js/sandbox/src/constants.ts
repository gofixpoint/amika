/**
 * Sandbox-runtime constants the provider layer stamps into VMs and reads back:
 * reserved ports, lifecycle script paths, the amikad etc dir, provider ownership
 * labels, and size specs. Owned here so the provider package is self-contained
 * and callers can re-export them from the SDK-free `@amika/sandbox/client` entry
 * as one source of truth for these on-box contracts.
 */

/** Default port the OpenCode web server listens on inside a sandbox. */
export const DEFAULT_OPENCODE_PORT = 60998;

/**
 * Auto-delete interval when a sandbox is stopped.
 *  -1 = never auto-delete (preserve stopped sandboxes)
 *   0 = delete immediately on stop
 *  >0 = delete after N minutes of being stopped
 */
export const SANDBOX_DELETE_INTERVAL_KEEP_ON_STOP = -1;

export const SANDBOX_SETUP_SCRIPT = "/usr/local/etc/amikad/setup/setup.sh";
export const SANDBOX_START_SCRIPT = "/usr/local/etc/amikad/setup/start.sh";
export const PRE_SETUP_SCRIPT = "/usr/lib/amikad/pre-setup.sh";
export const POST_SETUP_SCRIPT = "/usr/lib/amikad/post-setup.sh";
export const RUN_HOOK_SCRIPT = "/usr/lib/amikad/run-hook.sh";
export const AMIKAD_ETC_DIR = "/usr/local/etc/amikad";

// Daytona exposes `/etc` for system-managed files, but we do not have a
// supported way to add our own durable files there, so custom state lives
// under `/usr/local/etc/amikad`.
export const SERVICE_ENV_VARS_PATH = `${AMIKAD_ETC_DIR}/service-env-vars.json`;

/**
 * Spool directory for backgrounded agent-send jobs (stdout + exit-code files).
 * Written by whichever unprivileged user runs the launch (`amika`), so it is
 * provisioned world-writable + sticky to tolerate a sandbox whose dir was
 * created by an earlier root-run launch.
 */
export const AGENT_JOBS_DIR = "/tmp/amika-jobs";

/** No-op user lifecycle scripts, installed as defaults / when resetting hooks. */
export const DEFAULT_SETUP_SCRIPT = "#!/bin/bash\nexit 0\n";
export const DEFAULT_START_SCRIPT = "#!/bin/bash\nexit 0\n";

/**
 * Label stamped on sandboxes created with secrets kept OUT of the container env
 * (delivered via `/etc/environment` + credential files instead). Sandboxes
 * missing this label may have secrets baked into their container spec, which a
 * snapshot cannot scrub — so "snapshot and delete" is refused for them.
 */
export const SANDBOX_ENV_SECRETS_EXCLUDED_LABEL = "amika-env-secrets-excluded";
export const SANDBOX_ENV_SECRETS_EXCLUDED_VALUE = "1";

/**
 * Provider-resource labels stamping a sandbox with the org and user that own
 * it. Daytona attaches these as native sandbox labels; providers without a
 * label facet (e.g. Freestyle) fold the org id into the resource name instead.
 * The stored `org_id` remains the security boundary — these are the
 * provider-side ownership stamp.
 */
export const SANDBOX_ORG_ID_LABEL = "amika-org-id";
export const SANDBOX_USER_ID_LABEL = "amika-user-id";

export const DEFAULT_HOME_DIR = "/home/amika";

export interface SandboxSizeSpec {
  label: string;
  vcpus: number;
  memoryGb: number;
  diskGb: number;
}

export const SANDBOX_SIZE_SPECS: Record<
  "xs" | "m" | "l" | "xl",
  SandboxSizeSpec
> = {
  xs: { label: "XS (Extra Small)", vcpus: 1, memoryGb: 1, diskGb: 3 },
  m: { label: "M (Medium)", vcpus: 2, memoryGb: 8, diskGb: 10 },
  l: { label: "L (Large)", vcpus: 2, memoryGb: 12, diskGb: 24 },
  xl: { label: "XL (Extra Large)", vcpus: 4, memoryGb: 16, diskGb: 32 },
};
