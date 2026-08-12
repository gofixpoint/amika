/**
 * Sandbox-level operations against the Freestyle API: create (by cloning a
 * preset VM snapshot), start/stop/delete, SSH access, preview-URL refresh,
 * exec, and file reads. The provisioning lifecycle lives in
 * `@amika/sandbox-provisioning`; this module keeps the generic provider
 * mechanics, including {@link openFreestyleAdapter} (the adapter the
 * provisioning layer drives; it clones over that adapter's exec port, so
 * Freestyle needs no native clone primitive here).
 */
import { SANDBOX_ORG_ID_LABEL } from "../../../constants";
import { withStepContext } from "../../../util/errorutils";
import type { SandboxCtx } from "../../../logger";
import type { FreestyleConfig } from "../config";
import {
  type CreateSandboxProviderInput,
  type CreatedProviderSandbox,
  type ExecCommandOptions,
  type ProviderSandboxListing,
  type RefreshUrlsResult,
  type SandboxExecResult,
  type SandboxService,
} from "../../provider";
import type { SandboxStatus } from "../../../sandbox-status";
import type { SandboxAdapter } from "../../shared/adapter";
import { execWithStagedInput } from "../../shared/exec-input";
import {
  createFreestyleClient,
  FREESTYLE_CONTROL_PLANE_TIMEOUT_MS,
} from "./client";
import { FreestyleAdapter } from "./adapter";
import { buildFreestyleVmName, freestyleVmNameOrgId } from "../naming";
import { resolveFreestyleSnapshotRef } from "./snapshot-operations";

/**
 * Preview URLs are backed by Freestyle domain mappings, which are stable and do
 * not expire (unlike Daytona's signed URLs). Use a long TTL so a sandbox's
 * `urls_expire_at` stays far in the future and the refresh path rarely churns.
 */
export const FREESTYLE_URL_TTL_S = 365 * 24 * 60 * 60;

/**
 * "Never idle-suspend" expressed as a very large timeout. `vm.start` only
 * accepts a numeric `idleTimeoutSeconds` (no `null`), so a 1-year timeout is the
 * effective never — the VM won't suspend within any real session.
 */
const NEVER_IDLE_TIMEOUT_SECONDS = 365 * 24 * 60 * 60;

/**
 * Translate Daytona-style `auto_stop_interval` (minutes) into Freestyle's
 * `idleTimeoutSeconds`, applied identically at create and on every restart so
 * the user's choice survives stop/start (Freestyle resets idle timeout per
 * start otherwise):
 *   - `0`  → "never" (a 1-year timeout; the API has no null on start)
 *   - `>0` → seconds
 *   - absent/`null` → `undefined` (omit the field → Freestyle default)
 */
function freestyleIdleTimeoutSeconds(
  autoStopInterval?: number | null,
): number | undefined {
  if (autoStopInterval === 0) return NEVER_IDLE_TIMEOUT_SECONDS;
  if (autoStopInterval != null && autoStopInterval > 0) {
    return autoStopInterval * 60;
  }
  return undefined;
}

/**
 * Deterministic preview domain for a (vm, port). Stable across restarts and
 * refreshes so re-creating the mapping is idempotent. VM IDs are 20 lowercase
 * alphanumeric chars, so the result is a valid subdomain.
 */
function previewDomainFor(vmId: string, port: number): string {
  return `amika-${vmId}-${port}.style.dev`;
}

export async function createFreestyleSandbox(
  ctx: SandboxCtx,
  config: FreestyleConfig,
  input: CreateSandboxProviderInput,
): Promise<CreatedProviderSandbox> {
  const client = createFreestyleClient(config);

  const idleTimeoutSeconds = freestyleIdleTimeoutSeconds(
    input.autoStopInterval,
  );

  // Freestyle's `vms.create` has no label facet (unlike Daytona, which stamps
  // `amika-org-id`), so org-gate the VM by folding the org id into its name.
  // The org id rides along in `input.labels`; absent it (no expected caller),
  // fall back to the bare name rather than minting an unscoped `/`-prefixed one.
  const orgId = input.labels?.[SANDBOX_ORG_ID_LABEL];
  const vmName = orgId ? buildFreestyleVmName(orgId, input.name) : input.name;

  // Resolve the snapshot reference to a bootable snapshot id. Preset references
  // are deterministic names (`amika-<preset>-<size>`); captured snapshots arrive
  // already resolved to ids. A preset name that resolves to nothing means the
  // snapshot has not been built yet — fail with a clear, actionable message
  // rather than passing a name to `vms.create` (which would 404 opaquely).
  const snapshotId = await withStepContext(
    "freestyle create: resolve snapshot ref",
    () => resolveFreestyleSnapshotRef(config, input.snapshot),
  );
  if (snapshotId === input.snapshot && input.snapshot.startsWith("amika-")) {
    throw new Error(
      `Freestyle preset snapshot "${input.snapshot}" not found. ` +
        "Build it with `bin/freestyle-build-snapshots`.",
    );
  }

  ctx.logger.info(
    { name: vmName, snapshot: input.snapshot, snapshotId },
    "Creating Freestyle sandbox (cloning snapshot)",
  );

  // Clone the preset VM snapshot into a fresh VM. `persistent` so the sandbox
  // survives stop/suspend. The org-scoped name is carried onto the VM so it's
  // attributable to its org in `vms.get` and the dashboard. Service ports are
  // exposed via domain mappings in `refreshFreestyleUrls`, not at create time.
  //
  // No post-create `vm.resize`: the requested size is baked into the per-size
  // snapshot (`amika-<preset>-<size>`, built by `bin/freestyle-build-snapshots`,
  // which resizes the VM before snapshotting), so the clone boots at that size —
  // mirroring Daytona's per-size image tags and removing the slow rootfs-grow the
  // runtime resize incurred.
  const created = await withStepContext(
    "freestyle create: clone snapshot",
    () =>
      client.vms.create({
        snapshotId,
        name: vmName,
        persistence: { type: "persistent" },
        ...(idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds } : {}),
      }),
  );

  return {
    provider: "freestyle",
    providerSandboxId: created.vmId,
    providerUrl: null,
    services: input.services,
    envVars: {},
  };
}

/**
 * Ensure a stable preview-domain mapping for each service and return the
 * resulting `https://` URLs. The deterministic domain makes re-creating the
 * mapping idempotent, so an "already exists" conflict is suppressed; any other
 * mapping failure is propagated (the hostname wouldn't route), failing the
 * provision rather than recording a dead URL.
 */
export async function refreshFreestyleUrls(
  config: FreestyleConfig,
  providerSandboxId: string,
  services: SandboxService[],
): Promise<RefreshUrlsResult> {
  const client = createFreestyleClient(config);
  const refreshed: SandboxService[] = [];
  let providerUrl: string | null = null;

  for (const service of services) {
    const domain = previewDomainFor(providerSandboxId, service.containerPort);
    // Create the mapping only if a *live* one doesn't already exist. The domain
    // is deterministic per (vm, port), so on a refresh/restart it's already
    // present — skipping avoids a spurious conflict. But a mapping torn down by
    // the route reconcile (`syncFreestyleRoutes`) lingers as a soft-deleted record
    // (`unmappedAt` set), so a service recreated on the same port must ignore
    // those and re-create, or its URL would resolve to nothing. Any failure of
    // the list or create (auth/quota, invalid port, VM not ready) propagates and
    // fails provisioning rather than recording a dead URL behind the long TTL.
    const { mappings } = await client.domains.mappings.list({ domain });
    if (!mappings.some((m) => m.domain === domain && !m.unmappedAt)) {
      await client.domains.mappings.create({
        domain,
        vmId: providerSandboxId,
        vmPort: service.containerPort,
      });
    }
    const url = `https://${domain}`;
    refreshed.push({ ...service, url });
    if (service.name === "Coding Agent") {
      providerUrl = url;
    }
  }

  return { providerUrl, services: refreshed };
}

/** Page size for the account-wide mapping enumeration in {@link syncFreestyleRoutes}. */
const MAPPINGS_LIST_PAGE_SIZE = 100;

/**
 * Fail-loud backstop for {@link listAllMappings}: a server that ignored the
 * offset param would return the same non-empty page forever, and without a
 * bound the loop would spin and accumulate duplicates unboundedly. 1000 pages
 * of 100 is far beyond any plausible account.
 */
const MAPPINGS_LIST_MAX_PAGES = 1000;

/**
 * Enumerate ALL of the account's domain mappings, paginating to exhaustion.
 * `domains.mappings.list` is account-wide with a small default page (10), so
 * reconciling from a partial first page could leave a deleted service
 * publicly routed.
 *
 * Pagination is OFFSET-based: the SDK parses the `cursor` option as an
 * integer offset (`parseInt(cursor, 10)` in freestyle@0.1.63) and its
 * response carries no continuation token, so the next offset is synthesized
 * from the count fetched so far. Termination is on an EMPTY page, not a
 * short one — a server that clamps `limit` below the requested page size
 * would make a short page look like exhaustion and silently strand stale
 * routes. Provided the server honors the offset, each non-empty page
 * strictly advances it; {@link MAPPINGS_LIST_MAX_PAGES} fails loud rather
 * than spinning if it ever doesn't.
 */
async function listAllMappings(
  client: ReturnType<typeof createFreestyleClient>,
): Promise<
  Awaited<ReturnType<typeof client.domains.mappings.list>>["mappings"]
> {
  const all: Awaited<
    ReturnType<typeof client.domains.mappings.list>
  >["mappings"] = [];
  for (let page = 0; page < MAPPINGS_LIST_MAX_PAGES; page++) {
    const res = await client.domains.mappings.list({
      limit: MAPPINGS_LIST_PAGE_SIZE,
      cursor: String(all.length),
    });
    if (res.mappings.length === 0) return all;
    all.push(...res.mappings);
  }
  throw new Error(
    `Freestyle domain-mapping enumeration exceeded ${MAPPINGS_LIST_MAX_PAGES} ` +
      "pages without draining; refusing to reconcile routes from a listing " +
      "that never terminates.",
  );
}

/**
 * Reconcile the VM's preview-domain mappings to exactly the desired service
 * set: delete the Amika-owned mappings whose port no longer has a desired
 * service, create the missing ones. Freestyle mappings persist
 * for their long TTL untied to run state, so without the delete pass a
 * removed service's URL keeps routing to the VM (a restart does not clear
 * it). The shared-port guard falls out of the declarative shape: a per-port
 * domain is deleted iff NO desired service uses that port.
 *
 * Reconciliation touches only Amika-OWNED mappings: filtered by `vmId` AND
 * the deterministic `amika-<vmId>-<port>.style.dev` shape (soft-deleted
 * records ignored), so a custom domain a user independently mapped to the
 * same VM is never classified as reconcilable state and cannot be deleted.
 *
 * Concurrency caveat (same in kind as `refreshAll`'s mapping creation): the
 * create pass works from a desired set computed before this call, so two
 * concurrent syncs of the same VM can interleave — one's create pass may
 * re-create a mapping the other's delete pass just tore down, until the next
 * sync reconciles it. Not serialized here; acceptable for the current usage.
 */
export async function syncFreestyleRoutes(
  config: FreestyleConfig,
  providerSandboxId: string,
  desired: SandboxService[],
): Promise<void> {
  const client = createFreestyleClient(
    config,
    FREESTYLE_CONTROL_PLANE_TIMEOUT_MS,
  );
  const desiredPorts = new Set(desired.map((s) => s.containerPort));

  // Delete pass: live Amika-owned mappings for this VM whose port lost its
  // last desired service.
  const mappings = await listAllMappings(client);
  const stale = mappings.filter(
    (m) =>
      m.vmId === providerSandboxId &&
      !m.unmappedAt &&
      m.vmPort != null &&
      m.domain === previewDomainFor(providerSandboxId, m.vmPort) &&
      !desiredPorts.has(m.vmPort),
  );
  // Dedupe by domain: offset pagination can surface a record twice when the
  // listing shifts between pages, and the delete is per-domain anyway. The
  // mirror hazard — a concurrent delete elsewhere in the account shifting a
  // record BELOW the walked boundary, skipping this VM's stale mapping — is
  // accepted: the window needs a 100+-mapping account plus a racing delete
  // between page fetches, and the skip only defers the teardown to this
  // sandbox's next service mutation.
  for (const domain of new Set(stale.map((m) => m.domain))) {
    await client.domains.mappings.delete({ domain });
  }

  // Create pass: expose desired ports that have no live mapping yet. The
  // per-domain existence check mirrors `refreshFreestyleUrls` (a soft-deleted
  // record lingers with `unmappedAt` set and must be re-created over).
  for (const port of desiredPorts) {
    const domain = previewDomainFor(providerSandboxId, port);
    const { mappings: existing } = await client.domains.mappings.list({
      domain,
    });
    if (!existing.some((m) => m.domain === domain && !m.unmappedAt)) {
      await client.domains.mappings.create({
        domain,
        vmId: providerSandboxId,
        vmPort: port,
      });
    }
  }
}

export async function getFreestyleSandboxState(
  config: FreestyleConfig,
  providerSandboxId: string,
): Promise<string> {
  const client = createFreestyleClient(
    config,
    FREESTYLE_CONTROL_PLANE_TIMEOUT_MS,
  );
  // The VM handle has no get-info; state comes from the VM list.
  const { vms } = await client.vms.list();
  return vms.find((vm) => vm.id === providerSandboxId)?.state ?? "unknown";
}

/**
 * One item of Freestyle's `vms.list()` with the fields the spend meter needs.
 * The public SDK types (freestyle@0.1.63) omit `name` and `sizing`, but both are
 * present at runtime in the `GET /v1/vms` response (see the SDK's `private.d.ts`
 * `ResponseGetV1Vms200`); the pinned SDK version guards against the shape
 * changing.
 */
interface FreestyleVmListItem {
  id: string;
  name?: string | null;
  state: string;
  // Soft-delete flag, independent of `state`: a deleted VM keeps appearing in
  // vms.list() as stopped/suspended with `deleted: true`. There is no "deleted"
  // state value, so this is the only signal that a VM is gone.
  deleted?: boolean | null;
  sizing?: {
    /** Provisioned vCPU count. */
    vcpuCount: number;
    /** Provisioned memory, mebibytes. */
    memSizeMib: number;
    /** Provisioned root filesystem, mebibytes. */
    rootfsSizeMb: number;
  } | null;
}

const MIB_PER_GIB = 1024;

/**
 * Enumerate every live VM in the Freestyle account with its org stamp (folded
 * into the VM name), raw state, and provisioned sizing (converted MiB→GiB).
 * Soft-deleted VMs still lingering in the list, and VMs whose sizing the API
 * omits, are excluded — a deleted VM must stop billing, and an unsizeable one
 * can't be priced.
 */
export async function listFreestyleSandboxes(
  config: FreestyleConfig,
): Promise<ProviderSandboxListing[]> {
  const client = createFreestyleClient(
    config,
    FREESTYLE_CONTROL_PLANE_TIMEOUT_MS,
  );
  const { vms } = await client.vms.list();
  const items = vms as unknown as FreestyleVmListItem[];
  const listings: ProviderSandboxListing[] = [];
  for (const vm of items) {
    if (vm.deleted) continue;
    if (!vm.sizing) continue;
    listings.push({
      providerSandboxId: vm.id,
      orgId: freestyleVmNameOrgId(vm.name ?? null),
      state: vm.state,
      sizing: {
        vcpus: vm.sizing.vcpuCount,
        memoryGib: vm.sizing.memSizeMib / MIB_PER_GIB,
        diskGib: vm.sizing.rootfsSizeMb / MIB_PER_GIB,
      },
    });
  }
  return listings;
}

/**
 * Map a raw Freestyle VM state into the canonical lifecycle vocabulary. Raw
 * values are the `freestyle` SDK's VM `state` union plus the synthesized
 * `"unknown"` for a VM absent from the list. `stopped` and `suspended` both
 * read as `suspended` (either is resumable via start); `lost` is terminal.
 */
export function mapFreestyleSandboxState(rawState: string): SandboxStatus {
  switch (rawState) {
    case "building":
      return "creating";
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "suspending":
      return "suspending";
    case "suspended":
    case "stopped":
      return "suspended";
    case "lost":
      return "failed";
    default:
      return "unknown";
  }
}

/**
 * How long to wait for a Freestyle VM to reach a settled (suspended/stopped)
 * state, and the poll cadence. `vm.suspend`/`vm.stop` resolve once the request
 * is *accepted*, not once the VM has settled, so callers that must observe the
 * settled state poll the VM list.
 */
const FREESTYLE_VM_SETTLE_TIMEOUT_S = 2 * 60;
const FREESTYLE_VM_SETTLE_POLL_INTERVAL_MS = 2_000;

/**
 * Block until the VM's state satisfies `isSettled`, throwing if the timeout
 * elapses first. `vm.suspend`/`vm.stop` resolve once the request is accepted,
 * not once the VM has settled (unlike `vm.start`/`vms.create`, which resolve
 * only when the VM is running), so any operation that must not race a still
 * transitioning VM polls here first.
 */
async function waitForFreestyleVmState(
  config: FreestyleConfig,
  providerSandboxId: string,
  isSettled: (state: string) => boolean,
  description: string,
  timeoutS: number = FREESTYLE_VM_SETTLE_TIMEOUT_S,
): Promise<void> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    const state = await getFreestyleSandboxState(config, providerSandboxId);
    if (isSettled(state)) return;
    // `lost` is terminal and `unknown` means the VM is absent from the list
    // (deleted/never existed); neither will ever reach the target state, so fail
    // fast with a clear error rather than polling out to the deadline.
    if (state === "lost" || state === "unknown") {
      throw new Error(
        `Freestyle VM "${providerSandboxId}" is "${state}" and will not ` +
          `reach ${description}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Freestyle VM "${providerSandboxId}" did not reach ${description} ` +
          `within ${timeoutS}s (last state: "${state}")`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, FREESTYLE_VM_SETTLE_POLL_INTERVAL_MS),
    );
  }
}

/**
 * Block until the VM is fully `stopped` (a cold power-off). Used by the
 * stop/start lifecycle to wait out an in-flight cold stop before `vm.start`
 * resumes the VM (see {@link startFreestyleSandbox}).
 */
export async function waitForFreestyleVmStopped(
  config: FreestyleConfig,
  providerSandboxId: string,
  timeoutS?: number,
): Promise<void> {
  await waitForFreestyleVmState(
    config,
    providerSandboxId,
    (state) => state === "stopped",
    "stopped",
    timeoutS,
  );
}

/**
 * Block until the VM is `suspended` (a warm suspend-to-disk that `vm.start`
 * resumes from). Used by the stop/start lifecycle.
 */
async function waitForFreestyleVmSuspended(
  config: FreestyleConfig,
  providerSandboxId: string,
  timeoutS?: number,
): Promise<void> {
  await waitForFreestyleVmState(
    config,
    providerSandboxId,
    (state) => state === "suspended",
    "suspended",
    timeoutS,
  );
}

export async function startFreestyleSandbox(
  config: FreestyleConfig,
  providerSandboxId: string,
  autoStopInterval?: number | null,
): Promise<void> {
  const client = createFreestyleClient(
    config,
    FREESTYLE_CONTROL_PLANE_TIMEOUT_MS,
  );
  const vm = client.vms.ref({ vmId: providerSandboxId });
  // A suspend/stop issued moments earlier may still be settling (`vm.suspend`/
  // `vm.stop` resolve on accept). Resuming a VM mid-transition wedges it in
  // `starting`, which strands the sandbox in `initializing`. Wait for the VM to
  // settle so `vm.start` always acts on a `suspended`/`stopped` VM.
  const state = await getFreestyleSandboxState(config, providerSandboxId);
  if (state === "suspending") {
    await waitForFreestyleVmSuspended(config, providerSandboxId);
  } else if (state === "stopping") {
    await waitForFreestyleVmStopped(config, providerSandboxId);
  }
  // Freestyle resets idle timeout per start, so re-apply the persisted choice
  // (omitting the field falls back to the provider default).
  const idleTimeoutSeconds = freestyleIdleTimeoutSeconds(autoStopInterval);
  await vm.start(
    idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds } : {},
  );
}

export async function stopFreestyleSandbox(
  config: FreestyleConfig,
  providerSandboxId: string,
): Promise<void> {
  const client = createFreestyleClient(
    config,
    FREESTYLE_CONTROL_PLANE_TIMEOUT_MS,
  );
  const vm = client.vms.ref({ vmId: providerSandboxId });
  // Suspend rather than stop. `vm.stop` is a cold power-off, and resuming a
  // `stopped` VM via `vm.start` cold-boots it — which wedges it in `starting`
  // forever, stranding the sandbox in `initializing`. `vm.suspend` snapshots the
  // VM to disk (the same warm path the idle timeout uses), and `vm.start`
  // resumes from that layer reliably. `suspend` is present in the
  // freestyle@0.1.63 runtime but absent from its published types (like
  // `vm.user`), so it is typed locally here. Safe because Amika creates VMs with
  // `persistence: "persistent"`; an `ephemeral` VM can carry `deleteEvent:
  // "OnSuspend"` and would be deleted by a suspend.
  const state = await getFreestyleSandboxState(config, providerSandboxId);
  // Already idle (or being made idle by an earlier request) — nothing to do but
  // let it settle. `vm.suspend` on an already-suspended VM is a 409.
  if (state !== "suspended" && state !== "stopped" && state !== "suspending") {
    await (vm as typeof vm & { suspend(): Promise<unknown> }).suspend();
  }
  // `vm.suspend` resolves once accepted, not once suspended; wait so the row
  // isn't marked `stopped` while the VM is still suspending (a resume issued
  // right after would otherwise race the in-flight suspend).
  if (state !== "stopped") {
    await waitForFreestyleVmSuspended(config, providerSandboxId);
  }
}

export async function deleteFreestyleSandbox(
  config: FreestyleConfig,
  providerSandboxId: string,
): Promise<void> {
  const client = createFreestyleClient(
    config,
    FREESTYLE_CONTROL_PLANE_TIMEOUT_MS,
  );
  await client.vms.delete({ vmId: providerSandboxId });
}

/**
 * Capture an immutable snapshot of a VM's current state (memory, disk, CPU
 * registers) and return the new snapshot id. Works on running, suspended, or
 * stopped VMs. The resulting snapshot can be cloned into fresh VMs via
 * {@link createFreestyleSandbox} (`vms.create({ snapshotId })`). An optional
 * `name` makes the snapshot easier to identify in the dashboard and in
 * `vms.snapshots.list`.
 */
export async function snapshotFreestyleSandbox(
  config: FreestyleConfig,
  providerSandboxId: string,
  name?: string | null,
): Promise<string> {
  const client = createFreestyleClient(config);
  const vm = client.vms.ref({ vmId: providerSandboxId });
  const { snapshotId } = await vm.snapshot(name != null ? { name } : {});
  return snapshotId;
}

export async function readFreestyleFile(
  config: FreestyleConfig,
  providerSandboxId: string,
  filePath: string,
): Promise<string | null> {
  const client = createFreestyleClient(config);
  const adapter = new FreestyleAdapter(
    client.vms.ref({ vmId: providerSandboxId }),
    client,
  );
  return adapter.downloadFile(filePath);
}

export async function writeFreestyleFile(
  config: FreestyleConfig,
  providerSandboxId: string,
  filePath: string,
  content: Buffer | string,
): Promise<void> {
  const client = createFreestyleClient(config);
  const adapter = new FreestyleAdapter(
    client.vms.ref({ vmId: providerSandboxId }),
    client,
  );
  await adapter.uploadFile(content, filePath);
}

export async function executeFreestyleCommand(
  config: FreestyleConfig,
  providerSandboxId: string,
  command: string,
  opts?: ExecCommandOptions,
): Promise<SandboxExecResult> {
  const client = createFreestyleClient(config);
  const adapter = new FreestyleAdapter(
    client.vms.ref({ vmId: providerSandboxId }),
    client,
  );
  if (opts?.input !== undefined) {
    return execWithStagedInput(adapter, command, opts.input, opts);
  }
  return adapter.exec(command, opts);
}

/**
 * Open a Freestyle adapter handle (the core provisioning seam). `vms.ref` is a
 * local reference builder — no round-trip — so there is no fetched-once cost to
 * amortize here.
 */
export function openFreestyleAdapter(
  config: FreestyleConfig,
  providerSandboxId: string,
): SandboxAdapter {
  const client = createFreestyleClient(config);
  return new FreestyleAdapter(
    client.vms.ref({ vmId: providerSandboxId }),
    client,
  );
}
