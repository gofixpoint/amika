import { DaytonaError } from "@daytonaio/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  SANDBOX_ENV_SECRETS_EXCLUDED_LABEL,
  SANDBOX_ENV_SECRETS_EXCLUDED_VALUE,
} from "../../../constants";
import {
  createDaytonaSandbox,
  deleteDaytonaSandbox,
  startDaytonaSandbox,
} from "./operations";

vi.mock("@daytonaio/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daytonaio/sdk")>();
  return {
    ...actual,
    Daytona: vi.fn(),
  };
});

// VM mode (`useVm`) bypasses the SDK and creates sandboxes through the generated
// api-client so it can set the `linux-vm` class. Mock only the client classes;
// keep the real `SandboxClass`/`SandboxState` enums.
vi.mock("@daytona/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daytona/api-client")>();
  return {
    ...actual,
    Configuration: vi.fn(),
    SandboxApi: vi.fn(),
  };
});

const { Daytona } = await import("@daytonaio/sdk");
const { SandboxApi } = await import("@daytona/api-client");

function setupMockDaytona(deleteFn: () => Promise<void>) {
  vi.mocked(Daytona).mockImplementation(function () {
    return {
      get: vi.fn().mockResolvedValue({ delete: deleteFn }),
    } as unknown as InstanceType<typeof Daytona>;
  });
}

// A fresh config object per test: the Daytona client is memoized per config
// (see `./client`), so sharing one object across tests would hand every test
// the first test's mocked client and defeat `setupMockDaytona`.
const testConfig = () => ({
  apiKey: "test-key",
  apiUrl: "https://test.daytona.io",
  target: "test-target",
  organizationId: undefined,
  useVm: false,
});

describe("deleteDaytonaSandbox", () => {
  it("succeeds on first attempt", async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    setupMockDaytona(deleteFn);

    await deleteDaytonaSandbox(testConfig(), "sandbox-1");

    expect(deleteFn).toHaveBeenCalledTimes(1);
  });

  it("retries on state-change error then succeeds", async () => {
    const stateChangeError = new DaytonaError(
      "Sandbox state change in progress",
      400,
    );
    const deleteFn = vi
      .fn()
      .mockRejectedValueOnce(stateChangeError)
      .mockResolvedValueOnce(undefined);
    setupMockDaytona(deleteFn);

    await deleteDaytonaSandbox(testConfig(), "sandbox-1");

    expect(deleteFn).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("throws after all retries exhausted", async () => {
    const stateChangeError = new DaytonaError(
      "Sandbox state change in progress",
      400,
    );
    const deleteFn = vi.fn().mockRejectedValue(stateChangeError);
    setupMockDaytona(deleteFn);

    await expect(
      deleteDaytonaSandbox(testConfig(), "sandbox-1"),
    ).rejects.toThrow("state change in progress");

    // 1 initial + 3 retries = 4
    expect(deleteFn).toHaveBeenCalledTimes(4);
  }, 15_000);

  it("does not retry on non-state-change errors", async () => {
    const otherError = new DaytonaError("Sandbox not found", 404);
    const deleteFn = vi.fn().mockRejectedValue(otherError);
    setupMockDaytona(deleteFn);

    await expect(
      deleteDaytonaSandbox(testConfig(), "sandbox-1"),
    ).rejects.toThrow("Sandbox not found");

    expect(deleteFn).toHaveBeenCalledTimes(1);
  });
});

describe("createDaytonaSandbox", () => {
  it("bakes the caller-supplied non-secret vars into the container env", async () => {
    // The container env is baked into snapshots and can't be scrubbed
    // afterward. The provider must pass through only the generic values the
    // caller explicitly supplies.
    const createFn = vi.fn().mockResolvedValue({ id: "sandbox-xyz" });
    vi.mocked(Daytona).mockImplementation(function () {
      return {
        create: createFn,
        snapshot: { get: vi.fn().mockResolvedValue({ state: "active" }) },
      } as unknown as InstanceType<typeof Daytona>;
    });
    const ctx = { logger: { info: vi.fn() } } as unknown as Parameters<
      typeof createDaytonaSandbox
    >[0];

    await createDaytonaSandbox(ctx, testConfig(), {
      name: "sb",
      snapshot: "snap",
      services: [],
      envVars: { CALLER_MODE: "enabled", SANDBOX_LABEL: "sb" },
      scrubSafe: true,
    });

    expect(createFn).toHaveBeenCalledTimes(1);
    const { envVars, labels } = createFn.mock.calls[0][0] as {
      envVars: Record<string, string>;
      labels: Record<string, string>;
    };

    expect(envVars).toEqual({ CALLER_MODE: "enabled", SANDBOX_LABEL: "sb" });
    // A scrub-safe base earns the clean-env marker, which lets
    // snapshot-and-delete distinguish this sandbox from ones with baked-in
    // container env secrets.
    expect(labels[SANDBOX_ENV_SECRETS_EXCLUDED_LABEL]).toBe(
      SANDBOX_ENV_SECRETS_EXCLUDED_VALUE,
    );
  });

  it("does NOT mark scrub-safe when the base snapshot is untrusted", async () => {
    // A sandbox booted from a dirty/pre-fix snapshot inherits that
    // snapshot's baked-in container ENV, so it must not get the label even
    // though this create call injects no new secrets.
    const createFn = vi.fn().mockResolvedValue({ id: "sandbox-xyz" });
    vi.mocked(Daytona).mockImplementation(function () {
      return {
        create: createFn,
        snapshot: { get: vi.fn().mockResolvedValue({ state: "active" }) },
      } as unknown as InstanceType<typeof Daytona>;
    });
    const ctx = { logger: { info: vi.fn() } } as unknown as Parameters<
      typeof createDaytonaSandbox
    >[0];

    await createDaytonaSandbox(ctx, testConfig(), {
      name: "sb",
      snapshot: "user-snapshot",
      services: [],
      labels: { "amika-org-id": "org_1" },
      scrubSafe: false,
    });

    const { labels } = createFn.mock.calls[0][0] as {
      labels: Record<string, string>;
    };
    // Pre-existing labels are preserved, but the scrub-safe marker is absent.
    expect(labels).toHaveProperty("amika-org-id", "org_1");
    expect(labels).not.toHaveProperty(SANDBOX_ENV_SECRETS_EXCLUDED_LABEL);
  });

  it("reactivates an inactive base snapshot before creating from it", async () => {
    // A base snapshot Daytona has let lapse to `inactive` must be reactivated
    // before the create — otherwise `daytona.create` rejects with "Snapshot is
    // inactive". The reactivation must happen *before* the create is issued.
    const createFn = vi.fn().mockResolvedValue({ id: "sandbox-xyz" });
    const snapshotGet = vi
      .fn()
      .mockResolvedValueOnce({ state: "inactive", name: "snap" }) // ensure's state read
      .mockResolvedValueOnce({ state: "inactive", name: "snap" }) // activate's own get
      .mockResolvedValue({ state: "active", name: "snap" }); // waitForActive poll
    const snapshotActivate = vi.fn().mockResolvedValue({ state: "pending" });
    const snapshotList = vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 1 });
    vi.mocked(Daytona).mockImplementation(function () {
      return {
        create: createFn,
        snapshot: {
          get: snapshotGet,
          activate: snapshotActivate,
          list: snapshotList,
        },
      } as unknown as InstanceType<typeof Daytona>;
    });
    const ctx = { logger: { info: vi.fn() } } as unknown as Parameters<
      typeof createDaytonaSandbox
    >[0];

    await createDaytonaSandbox(ctx, testConfig(), {
      name: "sb",
      snapshot: "snap",
      services: [],
      scrubSafe: true,
    });

    expect(snapshotActivate).toHaveBeenCalledTimes(1);
    expect(createFn).toHaveBeenCalledTimes(1);
    // Ordering: the snapshot was reactivated before the sandbox create fired.
    expect(snapshotActivate.mock.invocationCallOrder[0]).toBeLessThan(
      createFn.mock.invocationCallOrder[0],
    );
  });

  it("creates a linux-vm via the api-client when useVm is set", async () => {
    // VM mode must NOT use the SDK's create() (which can't set the class) and
    // must POST `class: "linux-vm"` through the api-client instead.
    const sdkCreateFn = vi.fn();
    vi.mocked(Daytona).mockImplementation(function () {
      return {
        create: sdkCreateFn,
        snapshot: { get: vi.fn().mockResolvedValue({ state: "active" }) },
      } as unknown as InstanceType<typeof Daytona>;
    });
    const createSandboxFn = vi
      .fn()
      .mockResolvedValue({ data: { id: "vm-sandbox-1" } });
    // createVmSandbox polls getSandbox until the VM reaches `started` before
    // returning, so the started-wait sees a running VM immediately.
    const getSandboxFn = vi
      .fn()
      .mockResolvedValue({ data: { state: "started" } });
    vi.mocked(SandboxApi).mockImplementation(function () {
      return {
        createSandbox: createSandboxFn,
        getSandbox: getSandboxFn,
      } as unknown as InstanceType<typeof SandboxApi>;
    });
    const ctx = { logger: { info: vi.fn() } } as unknown as Parameters<
      typeof createDaytonaSandbox
    >[0];

    const result = await createDaytonaSandbox(
      ctx,
      { ...testConfig(), useVm: true },
      {
        name: "sb",
        snapshot: "snap",
        services: [],
        labels: { "amika-org-id": "org_1" },
        scrubSafe: true,
      },
    );

    expect(sdkCreateFn).not.toHaveBeenCalled();
    expect(createSandboxFn).toHaveBeenCalledTimes(1);
    expect(result.providerSandboxId).toBe("vm-sandbox-1");

    const body = createSandboxFn.mock.calls[0][0] as {
      class: string;
      snapshot: string;
      target: string | undefined;
      env: Record<string, string>;
      labels: Record<string, string>;
    };
    expect(body.class).toBe("linux-vm");
    expect(body.snapshot).toBe("snap");
    expect(body.target).toBe("test-target");
    // Same env/label discipline as the container path: no secrets in the
    // container env, scrub-safe marker preserved.
    expect(body.env).toEqual({});
    expect(body.labels["amika-org-id"]).toBe("org_1");
    expect(body.labels[SANDBOX_ENV_SECRETS_EXCLUDED_LABEL]).toBe(
      SANDBOX_ENV_SECRETS_EXCLUDED_VALUE,
    );
  });
});

describe("startDaytonaSandbox", () => {
  function setupMockSandbox(): {
    setAutostopInterval: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  } {
    const sandbox = {
      setAutostopInterval: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(Daytona).mockImplementation(function () {
      return {
        get: vi.fn().mockResolvedValue(sandbox),
      } as unknown as InstanceType<typeof Daytona>;
    });
    return sandbox;
  }

  it("re-applies the given interval before resuming", async () => {
    const sandbox = setupMockSandbox();

    await startDaytonaSandbox(testConfig(), "sandbox-1", 30);

    expect(sandbox.setAutostopInterval).toHaveBeenCalledWith(30);
    expect(sandbox.start).toHaveBeenCalledTimes(1);
    expect(
      sandbox.setAutostopInterval.mock.invocationCallOrder[0],
    ).toBeLessThan(sandbox.start.mock.invocationCallOrder[0]);
  });

  it("leaves the server-side interval alone when none is given", async () => {
    const sandbox = setupMockSandbox();

    await startDaytonaSandbox(testConfig(), "sandbox-1");
    await startDaytonaSandbox(testConfig(), "sandbox-1", null);

    expect(sandbox.setAutostopInterval).not.toHaveBeenCalled();
    expect(sandbox.start).toHaveBeenCalledTimes(2);
  });

  it("keeps a never-auto-stop interval of 0", async () => {
    const sandbox = setupMockSandbox();

    await startDaytonaSandbox(testConfig(), "sandbox-1", 0);

    expect(sandbox.setAutostopInterval).toHaveBeenCalledWith(0);
  });
});
