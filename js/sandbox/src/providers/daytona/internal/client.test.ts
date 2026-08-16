import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaytonaConfig } from "../config";
import { getDaytonaClient } from "./client";

vi.mock("@daytonaio/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@daytonaio/sdk")>();
  return { ...actual, Daytona: vi.fn() };
});

const { Daytona } = await import("@daytonaio/sdk");

// A factory, not a shared object: the cache is keyed on config identity, so a
// module-level config would let one case's client bleed into the next.
const config = (): DaytonaConfig => ({
  apiKey: "key",
  apiUrl: "https://daytona.example",
  target: "us-west-2",
  organizationId: undefined,
  useVm: false,
});

describe("getDaytonaClient", () => {
  beforeEach(() => {
    vi.mocked(Daytona).mockReset();
    // Regular function (not an arrow) so it works as a constructor with `new`.
    vi.mocked(Daytona).mockImplementation(function () {
      return {} as InstanceType<typeof Daytona>;
    });
  });

  it("builds the client once per config and reuses it", () => {
    // The point of the cache: the SDK constructor opens a Socket.IO connection,
    // and operations resolve their client per call. Repeated calls with the
    // config the caller holds for the process must not each open one.
    const cfg = config();

    const first = getDaytonaClient(cfg);
    const second = getDaytonaClient(cfg);

    expect(second).toBe(first);
    expect(Daytona).toHaveBeenCalledTimes(1);
  });

  it("builds a separate client per config object", () => {
    // Keyed on identity, not on field values — two configs that happen to be
    // field-identical are still two callers, and a caller that rebuilds its
    // config gets a client matching it.
    const first = getDaytonaClient(config());
    const second = getDaytonaClient(config());

    expect(second).not.toBe(first);
    expect(Daytona).toHaveBeenCalledTimes(2);
  });

  it("passes the configured target through and omits an unset organization", () => {
    getDaytonaClient(config());

    expect(Daytona).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "key",
        apiUrl: "https://daytona.example",
        target: "us-west-2",
      }),
    );
    expect(vi.mocked(Daytona).mock.calls[0]?.[0]).not.toHaveProperty(
      "organizationId",
    );
  });

  it("scopes to the organization when one is configured", () => {
    getDaytonaClient({ ...config(), organizationId: "org-1" });

    expect(Daytona).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1" }),
    );
  });
});
