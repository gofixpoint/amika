/**
 * What a Daytona API key's organization can boot. A create from a snapshot
 * cannot set resources, so the org's snapshots fix its sizes. A size counts
 * when a snapshot of the configured sandbox class (`linux-vm` with `useVm`,
 * else `container`) is active and served where a create goes: the
 * configured `target` region, else any of the org's regions. Daytona refuses
 * a create from a snapshot that region does not serve ("Snapshot ... is not
 * available in region ...").
 *
 * With no `target`, a create goes to the org's default region, which an API
 * key cannot read. A snapshot that only another of the org's regions serves
 * is then listed, and its create fails.
 *
 * Each size says who owns its snapshot: Daytona's general snapshots are the
 * provider's, the rest the org's own. The caller decides which it boots.
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
 * the snapshot that boots it. Empty when the org can boot none.
 */
export async function listDaytonaAccountSizes(
  config: DaytonaConfig,
): Promise<AccountSize[]> {
  const [snapshots, regionIds] = await Promise.all([
    listSnapshots(config),
    listCreateRegionIds(config),
  ]);
  const sandboxClass = config.useVm
    ? SandboxClass.LINUX_VM
    : SandboxClass.CONTAINER;
  return snapshots
    .filter(
      (s) =>
        s.state === SnapshotState.ACTIVE &&
        (s.sandboxClass ?? SandboxClass.CONTAINER) === sandboxClass &&
        (s.regionIds ?? []).some((id) => regionIds.has(id)),
    )
    .map((s) => ({
      vcpus: s.cpu,
      memoryGib: s.mem,
      diskGib: s.disk,
      image: s.name,
      imageOwner: s.general ? ("provider" as const) : ("account" as const),
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

/**
 * The ids of the regions a create may go to: the configured `target` (named
 * by id or name), else every region the org may create sandboxes in.
 */
async function listCreateRegionIds(
  config: DaytonaConfig,
): Promise<Set<string>> {
  const api = new OrganizationsApi(apiConfiguration(config));
  const { data } = await api.listAvailableRegions(config.organizationId, {
    timeout: SIZES_TIMEOUT_MS,
  });
  const regions = config.target
    ? data.filter((r) => r.id === config.target || r.name === config.target)
    : data;
  return new Set(regions.map((r) => r.id));
}

/** The api-client auth the SDK uses: the key as a Bearer token. */
function apiConfiguration(config: DaytonaConfig): Configuration {
  return new Configuration({
    basePath: config.apiUrl,
    baseOptions: { headers: { Authorization: `Bearer ${config.apiKey}` } },
  });
}
