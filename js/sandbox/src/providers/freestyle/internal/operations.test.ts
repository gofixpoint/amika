import { beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { SandboxCtx } from "../../../logger";
import { SANDBOX_ORG_ID_LABEL } from "../../../constants";
import type { FreestyleConfig } from "../config";
import type {
  CreateSandboxProviderInput,
  SandboxService,
} from "../../provider";
import {
  createFreestyleSandbox,
  listFreestyleSandboxes,
  mapFreestyleSandboxState,
  refreshFreestyleUrls,
  syncFreestyleRoutes,
} from "./operations";

const createVm = vi.fn();
const refVm = vi.fn();
const listVms = vi.fn();
const listSnapshots = vi.fn();
const deleteMapping = vi.fn();
const listMappings = vi.fn();
const createMapping = vi.fn();

vi.mock("./client", () => ({
  createFreestyleClient: () => ({
    vms: {
      create: createVm,
      ref: refVm,
      list: listVms,
      snapshots: { list: listSnapshots },
    },
    domains: {
      mappings: {
        delete: deleteMapping,
        list: listMappings,
        create: createMapping,
      },
    },
  }),
  FREESTYLE_CONTROL_PLANE_TIMEOUT_MS: 1000,
}));

function svc(name: string, containerPort: number): SandboxService {
  return {
    name,
    url: "",
    hostPort: containerPort,
    containerPort,
    protocol: "tcp",
  };
}

const config: FreestyleConfig = { apiKey: "test-key" };

function ctx(): SandboxCtx {
  return { logger: pino({ enabled: false }), childCtx: () => ctx() };
}

function createInput(
  overrides?: Partial<CreateSandboxProviderInput>,
): CreateSandboxProviderInput {
  return {
    name: "my-sandbox",
    snapshot: "snap_123",
    services: [],
    labels: { [SANDBOX_ORG_ID_LABEL]: "org_abc123" },
    ...overrides,
  };
}

describe("createFreestyleSandbox org gating", () => {
  beforeEach(() => {
    createVm.mockReset();
    refVm.mockReset();
    listSnapshots.mockReset();
    // No snapshot matches by name, so the ref is used as the snapshot id.
    listSnapshots.mockResolvedValue({ snapshots: [] });
    createVm.mockResolvedValue({ vmId: "vm_1", domains: [] });
  });

  it("folds the org id into the VM name", async () => {
    await createFreestyleSandbox(ctx(), config, createInput());

    expect(createVm).toHaveBeenCalledTimes(1);
    expect(createVm.mock.calls[0][0]).toMatchObject({
      name: "org_abc123/my-sandbox",
      snapshotId: "snap_123",
    });
  });

  it("falls back to the bare name when no org label is present", async () => {
    await createFreestyleSandbox(
      ctx(),
      config,
      createInput({ labels: undefined }),
    );

    expect(createVm.mock.calls[0][0]).toMatchObject({ name: "my-sandbox" });
  });

  it("never resizes the VM (size is baked into the snapshot)", async () => {
    await createFreestyleSandbox(
      ctx(),
      config,
      createInput({
        resources: { vcpus: 2, memoryGib: 16, diskGib: 24 },
      }),
    );

    expect(refVm).not.toHaveBeenCalled();
  });
});

describe("createFreestyleSandbox snapshot resolution", () => {
  beforeEach(() => {
    createVm.mockReset();
    refVm.mockReset();
    listSnapshots.mockReset();
    createVm.mockResolvedValue({ vmId: "vm_1", domains: [] });
  });

  it("resolves a preset snapshot name to its bootable id", async () => {
    listSnapshots.mockResolvedValue({
      snapshots: [
        {
          snapshotId: "snap_real",
          name: "amika-coder-m",
          state: "ready",
          createdAt: "2024-01-01T00:00:00Z",
        },
      ],
    });

    await createFreestyleSandbox(
      ctx(),
      config,
      createInput({ snapshot: "amika-coder-m" }),
    );

    expect(createVm.mock.calls[0][0]).toMatchObject({
      snapshotId: "snap_real",
    });
  });

  it("uses a non-preset reference verbatim as the snapshot id", async () => {
    listSnapshots.mockResolvedValue({ snapshots: [] });

    await createFreestyleSandbox(
      ctx(),
      config,
      createInput({ snapshot: "snap_captured" }),
    );

    expect(createVm.mock.calls[0][0]).toMatchObject({
      snapshotId: "snap_captured",
    });
  });

  it("throws a clear error when a preset snapshot has not been built", async () => {
    listSnapshots.mockResolvedValue({ snapshots: [] });

    await expect(
      createFreestyleSandbox(
        ctx(),
        config,
        createInput({ snapshot: "amika-coder-xl" }),
      ),
    ).rejects.toThrow(/amika-coder-xl.*not found/);
    expect(createVm).not.toHaveBeenCalled();
  });

  // An opaque `vms.create` 500 (the "Background provisioning failed" path)
  // should name the failing step and keep the original error as `cause` so the
  // provider trace id survives into the logs.
  it("labels a clone-snapshot failure and preserves the original error", async () => {
    listSnapshots.mockResolvedValue({ snapshots: [] });
    const providerError = new Error("INTERNAL_ERROR: Internal server error");
    createVm.mockRejectedValue(providerError);

    await expect(
      createFreestyleSandbox(ctx(), config, createInput()),
    ).rejects.toMatchObject({
      message:
        "freestyle create: clone snapshot: INTERNAL_ERROR: Internal server error",
      cause: providerError,
    });
  });
});

describe("mapFreestyleSandboxState", () => {
  it("maps every raw Freestyle VM state onto the canonical vocabulary", () => {
    const cases: Record<string, string> = {
      building: "creating",
      starting: "starting",
      running: "running",
      suspending: "suspending",
      suspended: "suspended",
      stopped: "suspended",
      lost: "failed",
    };
    for (const [raw, expected] of Object.entries(cases)) {
      expect(mapFreestyleSandboxState(raw), raw).toBe(expected);
    }
  });

  it("maps the synthesized absent-VM sentinel and junk to unknown", () => {
    expect(mapFreestyleSandboxState("unknown")).toBe("unknown");
    expect(mapFreestyleSandboxState("")).toBe("unknown");
  });
});

describe("listFreestyleSandboxes", () => {
  beforeEach(() => listVms.mockReset());

  const sizing = { vcpuCount: 2, memSizeMib: 4096, rootfsSizeMb: 10240 };

  it("maps each VM to its org (from the name), state, and GiB sizing", async () => {
    listVms.mockResolvedValue({
      vms: [
        { id: "vm_1", name: `${"org_abc"}/my-box`, state: "running", sizing },
      ],
    });

    const listings = await listFreestyleSandboxes(config);

    expect(listings).toEqual([
      {
        providerSandboxId: "vm_1",
        orgId: "org_abc",
        state: "running",
        // 4096 MiB → 4 GiB, 10240 MiB → 10 GiB.
        sizing: { vcpus: 2, memoryGib: 4, diskGib: 10 },
      },
    ]);
  });

  it("reports a null org for a VM name with no org prefix", async () => {
    listVms.mockResolvedValue({
      vms: [{ id: "vm_1", name: "legacy-box", state: "running", sizing }],
    });

    expect((await listFreestyleSandboxes(config))[0]?.orgId).toBeNull();
  });

  it("skips soft-deleted VMs still lingering in the list", async () => {
    listVms.mockResolvedValue({
      vms: [
        { id: "vm_live", name: "org_a/live", state: "running", sizing },
        {
          id: "vm_gone",
          name: "org_a/gone",
          state: "suspended",
          deleted: true,
          sizing,
        },
      ],
    });

    const ids = (await listFreestyleSandboxes(config)).map(
      (l) => l.providerSandboxId,
    );
    expect(ids).toEqual(["vm_live"]);
  });

  it("skips VMs whose sizing the API omits", async () => {
    listVms.mockResolvedValue({
      vms: [
        { id: "vm_sized", name: "org_a/ok", state: "running", sizing },
        { id: "vm_unsized", name: "org_a/no-size", state: "running" },
      ],
    });

    const ids = (await listFreestyleSandboxes(config)).map(
      (l) => l.providerSandboxId,
    );
    expect(ids).toEqual(["vm_sized"]);
  });
});

describe("syncFreestyleRoutes", () => {
  const mapping = (
    vmId: string,
    port: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: `map_${vmId}_${port}`,
    domain: `amika-${vmId}-${port}.style.dev`,
    vmId,
    vmPort: port,
    ownershipId: "own_1",
    createdAt: "2026-01-01",
    unmappedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    deleteMapping.mockReset();
    deleteMapping.mockResolvedValue({});
    listMappings.mockReset();
    createMapping.mockReset();
    createMapping.mockResolvedValue({});
  });

  it("deletes a stale Amika mapping and leaves desired + foreign ones alone", async () => {
    // The account-wide enumeration: a stale Amika mapping (port 3000, no
    // longer desired), a live desired one, another VM's mapping, and a
    // user's custom domain on THIS vm (not the deterministic shape).
    const account = [
      mapping("vm_abc", 3000),
      mapping("vm_abc", 60998),
      mapping("vm_other", 3000),
      { ...mapping("vm_abc", 8080), domain: "myapp.example.com" },
    ];
    listMappings.mockImplementation(
      (opts?: { domain?: string; cursor?: string }) => {
        if (opts?.domain) {
          // Per-domain existence probes in the create pass: everything desired
          // already has a live mapping.
          return Promise.resolve({
            mappings: [mapping("vm_abc", 60998)].filter(
              (m) => m.domain === opts.domain,
            ),
          });
        }
        const offset = opts?.cursor ? parseInt(opts.cursor, 10) : 0;
        return Promise.resolve({ mappings: account.slice(offset) });
      },
    );

    await syncFreestyleRoutes({ apiKey: "test-key" }, "vm_abc", [
      svc("Coding Agent", 60998),
    ]);

    // Only the stale Amika-owned mapping for THIS vm is torn down — never
    // another VM's mapping, never a custom domain a user mapped out-of-band.
    expect(deleteMapping).toHaveBeenCalledTimes(1);
    expect(deleteMapping).toHaveBeenCalledWith({
      domain: "amika-vm_abc-3000.style.dev",
    });
  });

  it("keeps a shared-port domain while any desired service uses the port", async () => {
    listMappings.mockImplementation(
      (opts?: { domain?: string; cursor?: string }) => {
        const offset =
          !opts?.domain && opts?.cursor ? parseInt(opts.cursor, 10) : 0;
        return Promise.resolve({
          mappings: [mapping("vm_abc", 3000)]
            .filter((m) => !opts?.domain || m.domain === opts.domain)
            .slice(offset),
        });
      },
    );

    // Two services share port 3000; one was deleted, the survivor keeps it in
    // the desired set — the per-port domain must survive.
    await syncFreestyleRoutes({ apiKey: "test-key" }, "vm_abc", [
      svc("web-2", 3000),
    ]);
    expect(deleteMapping).not.toHaveBeenCalled();
  });

  it("creates a missing mapping for a desired port (soft-deleted re-created)", async () => {
    listMappings.mockImplementation((opts?: { domain?: string }) => {
      if (opts?.domain) {
        // The domain only has a soft-deleted record — must be re-created.
        return Promise.resolve({
          mappings: [
            mapping("vm_abc", 3000, { unmappedAt: "2026-01-02" }),
          ].filter((m) => m.domain === opts.domain),
        });
      }
      // Account-wide enumeration: empty on every page.
      return Promise.resolve({ mappings: [] });
    });

    await syncFreestyleRoutes({ apiKey: "test-key" }, "vm_abc", [
      svc("web", 3000),
    ]);
    expect(createMapping).toHaveBeenCalledWith({
      domain: "amika-vm_abc-3000.style.dev",
      vmId: "vm_abc",
      vmPort: 3000,
    });
  });

  it("paginates the account-wide enumeration to exhaustion (offset-based)", async () => {
    // The SDK's `cursor` is a stringified OFFSET (`parseInt(cursor, 10)` in
    // freestyle@0.1.63) and its response carries no continuation token. The
    // stale mapping only appears past the first full page — reconciling from
    // page one alone would leave it publicly routed.
    const account = [
      ...Array.from({ length: 100 }, (_, i) => mapping("vm_other", 10_000 + i)),
      mapping("vm_abc", 3000),
    ];
    listMappings.mockImplementation(
      (opts?: { domain?: string; cursor?: string; limit?: number }) => {
        if (opts?.domain) return Promise.resolve({ mappings: [] });
        const offset = opts?.cursor ? parseInt(opts.cursor, 10) : 0;
        return Promise.resolve({
          mappings: account.slice(offset, offset + (opts?.limit ?? 10)),
        });
      },
    );

    await syncFreestyleRoutes({ apiKey: "test-key" }, "vm_abc", []);
    expect(deleteMapping).toHaveBeenCalledWith({
      domain: "amika-vm_abc-3000.style.dev",
    });
  });

  it("does not treat a clamped short page as exhaustion", async () => {
    // A server that clamps `limit` (here to 10) returns short pages long
    // before the listing is drained; termination must be on an EMPTY page or
    // the stale mapping past the clamp horizon is never seen.
    const account = [
      ...Array.from({ length: 25 }, (_, i) => mapping("vm_other", 10_000 + i)),
      mapping("vm_abc", 3000),
    ];
    listMappings.mockImplementation(
      (opts?: { domain?: string; cursor?: string }) => {
        if (opts?.domain) return Promise.resolve({ mappings: [] });
        const offset = opts?.cursor ? parseInt(opts.cursor, 10) : 0;
        return Promise.resolve({
          mappings: account.slice(offset, offset + 10),
        });
      },
    );

    await syncFreestyleRoutes({ apiKey: "test-key" }, "vm_abc", []);
    expect(deleteMapping).toHaveBeenCalledWith({
      domain: "amika-vm_abc-3000.style.dev",
    });
  });
});

describe("refreshFreestyleUrls", () => {
  const domain = "amika-vm_abc-3000.style.dev";

  beforeEach(() => {
    listMappings.mockReset();
    createMapping.mockReset();
    createMapping.mockResolvedValue({});
  });

  it("skips create when a live mapping already exists", async () => {
    listMappings.mockResolvedValue({
      mappings: [{ id: "m1", domain, createdAt: "2026-01-01T00:00:00Z" }],
    });
    const { services } = await refreshFreestyleUrls(config, "vm_abc", [
      svc("web", 3000),
    ]);
    expect(createMapping).not.toHaveBeenCalled();
    expect(services[0].url).toBe(`https://${domain}`);
  });

  it("recreates the mapping when the only match is soft-deleted (unmappedAt)", async () => {
    // A mapping torn down by the route reconcile lingers with
    // `unmappedAt` set; a service recreated on the same port must re-map it.
    listMappings.mockResolvedValue({
      mappings: [
        {
          id: "m1",
          domain,
          createdAt: "2026-01-01T00:00:00Z",
          unmappedAt: "2026-01-02T00:00:00Z",
        },
      ],
    });
    await refreshFreestyleUrls(config, "vm_abc", [svc("web", 3000)]);
    expect(createMapping).toHaveBeenCalledWith({
      domain,
      vmId: "vm_abc",
      vmPort: 3000,
    });
  });
});
