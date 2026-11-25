/**
 * What a Daytona API key's organization can boot. A create from a snapshot
 * cannot set resources, so the org's snapshots fix its sizes. A size counts
 * only when a general snapshot of the configured sandbox class (`linux-vm`
 * with `useVm`, else `container`) is active and available in one of the
 * org's regions. Daytona refuses a create from a snapshot that no region of
 * the org serves ("Snapshot ... is not available in region ...").
 *
 * Only general snapshots count. Daytona publishes them with a known layout
 * (Debian, systemd, a `daytona` user with passwordless sudo), which the
 * stock-image boot needs. An org's own snapshots can hold anything.
 */
import {
  Configuration,
  OrganizationsApi,
  SandboxClass,
  SnapshotsApi,
  SnapshotState,
  type SnapshotDto,
} from "@daytona/api-client";
import type { AccountSize } from "../../provider";
import type { DaytonaConfig } from "../config";

/** Shorter than a create's timeouts: a caller waits on this to offer sizes. */
const SIZES_TIMEOUT_MS = 10_000;

/** Daytona's largest page size for the snapshot list. */
const SNAPSHOT_PAGE_LIMIT = 100;

/**
 * The sizes a new sandbox may have with this key, smallest first, each with
 * the general snapshot that boots it. Empty when the org can boot none.
 */
export async function listDaytonaAccountSizes(
  config: DaytonaConfig,
): Promise<AccountSize[]> {
  const [snapshots, regionIds] = await Promise.all([
    listSnapshots(config),
    listRegionIds(config),
  ]);
  const sandboxClass = config.useVm
    ? SandboxClass.LINUX_VM
    : SandboxClass.CONTAINER;
  return snapshots
    .filter(
      (s) =>
        s.general &&
        s.state === SnapshotState.ACTIVE &&
        (s.sandboxClass ?? SandboxClass.CONTAINER) === sandboxClass &&
        (s.regionIds ?? []).some((id) => regionIds.has(id)),
    )
    .map((s) => ({
      vcpus: s.cpu,
      memoryGib: s.mem,
      diskGib: s.disk,
      image: s.name,
    }))
    .sort(
      (a, b) =>
        a.vcpus - b.vcpus || a.memoryGib - b.memoryGib || a.diskGib - b.diskGib,
    );
}

/** Every snapshot the org can see, its own and Daytona's general ones. */
async function listSnapshots(config: DaytonaConfig): Promise<SnapshotDto[]> {
  const api = new SnapshotsApi(apiConfiguration(config));
  const all: SnapshotDto[] = [];
  for (let page = 1; ; page++) {
    const { data } = await api.getAllSnapshots(
      config.organizationId,
      page,
      SNAPSHOT_PAGE_LIMIT,
      undefined,
      undefined,
      undefined,
      { timeout: SIZES_TIMEOUT_MS },
    );
    all.push(...data.items);
    if (page >= data.totalPages) return all;
  }
}

/** The ids of the regions the org may create sandboxes in. */
async function listRegionIds(config: DaytonaConfig): Promise<Set<string>> {
  const api = new OrganizationsApi(apiConfiguration(config));
  const { data } = await api.listAvailableRegions(config.organizationId, {
    timeout: SIZES_TIMEOUT_MS,
  });
  return new Set(data.map((r) => r.id));
}

/** The api-client auth the SDK uses: the key as a Bearer token. */
function apiConfiguration(config: DaytonaConfig): Configuration {
  return new Configuration({
    basePath: config.apiUrl,
    baseOptions: { headers: { Authorization: `Bearer ${config.apiKey}` } },
  });
}
