/** Cover the registration request and how its failures are reported. */
import { describe, expect, it, vi } from "vitest";
import {
  AmikaApiError,
  HostTransportConflictError,
  HostTypeConflictError,
  registerHost,
  setHostSecret,
  setHostSizes,
  setHostTransport,
  setHostType,
  setHostUrl,
} from "./amika-api.js";

const API = { apiUrl: "https://app.amika.dev", apiKey: "api-key" };
const LARGE = { vcpus: 8, memoryGib: 32, diskGib: 100, diskGrowOnly: false };
const INPUT = {
  hostname: "builder",
  secretKey: "host-secret",
  sizes: { large: LARGE },
};
const HOST = {
  id: "host_1",
  hostname: "builder",
  url: null,
  org_id: "org_1",
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};

function responding(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response);
}

function apiErrorBody(status: number, code: string, message: string) {
  return Response.json(
    { type: "error", error_code: code, message },
    { status },
  );
}

describe("registerHost", () => {
  it("posts the hostname, secret and sizes with the API key", async () => {
    const fetcher = responding(Response.json(HOST, { status: 201 }));
    await registerHost(API, INPUT, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.amika.dev/api/v0beta1/hosts",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer api-key",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          hostname: "builder",
          secret: "host-secret",
          sizes: { large: LARGE },
        }),
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([
    [201, true],
    [200, false],
  ])("treats HTTP %i as created=%s", async (status, created) => {
    const fetcher = responding(Response.json(HOST, { status }));
    expect(await registerHost(API, INPUT, fetcher)).toEqual({
      // `HOST` carries no `transport_mode`, as a control plane older than
      // the field answers; such a plane serves listening hosts only, so the
      // schema reads its silence as `listen` rather than leaving it unset.
      host: {
        id: "host_1",
        hostname: "builder",
        url: null,
        transport_mode: "listen",
      },
      created,
    });
  });

  it.each([
    [
      401,
      "Amika rejected the API key while trying to register the host (unauthorized: details)",
    ],
    [
      403,
      "Amika refused to register the host with this API key (forbidden: details)",
    ],
    [409, "failed to register the host (host_hostname_conflict: details)"],
  ])("explains HTTP %i", async (status, message) => {
    const code = {
      401: "unauthorized",
      403: "forbidden",
      409: "host_hostname_conflict",
    }[status] as string;
    const fetcher = responding(apiErrorBody(status, code, "details"));
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      new AmikaApiError(message, code),
    );
  });

  it("asks for a transport only when given one", async () => {
    const fetcher = responding(Response.json(HOST, { status: 201 }));
    await registerHost(API, { ...INPUT, transportMode: "tunnel" }, fetcher);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      hostname: "builder",
      secret: "host-secret",
      sizes: { large: LARGE },
      transport_mode: "tunnel",
    });
  });

  it("tells a host in another transport apart from other conflicts", async () => {
    const fetcher = responding(
      apiErrorBody(409, "host_transport_conflict", "in listen mode"),
    );
    const refused = registerHost(
      API,
      { ...INPUT, transportMode: "tunnel" },
      fetcher,
    );
    await expect(refused).rejects.toBeInstanceOf(HostTransportConflictError);
    await expect(refused).rejects.toThrow(
      "failed to register the host (host_transport_conflict: in listen mode)",
    );
  });

  it.each([
    [
      401,
      "Unauthorized",
      "Amika rejected the API key while trying to register the host (HTTP 401: Unauthorized)",
    ],
    [
      403,
      "No organization ID",
      "Amika refused to register the host with this API key (HTTP 403: No organization ID)",
    ],
  ])("explains the sign-in check's HTTP %i", async (status, error, message) => {
    // What the control plane's sign-in check actually sends.
    const fetcher = responding(Response.json({ error }, { status }));
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      new AmikaApiError(message),
    );
  });

  it("says a redirect was refused rather than that Amika is unreachable", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("fetch failed", {
        cause: new Error("unexpected redirect"),
      }),
    );
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      /answered with a redirect, which is refused/,
    );
  });

  it("falls back to the status when the error body is not an API error", async () => {
    const fetcher = responding(
      new Response("<html>bad gateway", { status: 502 }),
    );
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      "failed to register the host (HTTP 502)",
    );
  });

  it("names the network failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
      }),
    );
    const failure = registerHost(API, INPUT, fetcher);
    await expect(failure).rejects.toThrow(
      "cannot reach Amika at https://app.amika.dev: ECONNREFUSED",
    );
  });

  it("reports a timeout", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      "cannot reach Amika at https://app.amika.dev: no response within 30s",
    );
  });

  it("rejects a success response that is not a host", async () => {
    const fetcher = responding(Response.json({ ok: true }, { status: 201 }));
    await expect(registerHost(API, INPUT, fetcher)).rejects.toThrow(
      "Amika returned an unexpected host response",
    );
  });

  it("never includes the API key or secret in an error", async () => {
    for (const response of [
      apiErrorBody(500, "internal_error", "Failed to save host"),
      new Response("host-secret api-key", { status: 500 }),
    ]) {
      const error = await registerHost(API, INPUT, responding(response)).catch(
        (caught: unknown) => caught as Error,
      );
      expect(String(error)).not.toMatch(/host-secret|api-key/);
    }
  });
});

describe("setHostUrl", () => {
  it("replaces the host's URL while keeping its hostname and stored secret", async () => {
    const fetcher = responding(
      Response.json({ ...HOST, url: "https://abc.ngrok.app" }),
    );
    expect(
      await setHostUrl(API, HOST, "https://abc.ngrok.app", fetcher),
    ).toEqual({
      id: "host_1",
      hostname: "builder",
      url: "https://abc.ngrok.app",
      transport_mode: "listen",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.amika.dev/api/v0beta1/hosts/host_1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          hostname: "builder",
          url: "https://abc.ngrok.app",
        }),
        redirect: "error",
      }),
    );
  });

  it("explains a failure", async () => {
    const fetcher = responding(
      apiErrorBody(404, "host_not_found", "Host not found"),
    );
    await expect(
      setHostUrl(API, HOST, "https://abc.ngrok.app", fetcher),
    ).rejects.toThrow(
      "failed to set the host URL (host_not_found: Host not found)",
    );
  });
});

describe("setHostSizes", () => {
  it("replaces the host's sizes, keeping its hostname", async () => {
    const fetcher = responding(Response.json(HOST));
    await setHostSizes(API, HOST, { large: LARGE }, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.amika.dev/api/v0beta1/hosts/host_1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ hostname: "builder", sizes: { large: LARGE } }),
        redirect: "error",
      }),
    );
  });

  it("explains a failure", async () => {
    const fetcher = responding(
      apiErrorBody(400, "validation_failed", "Invalid host sizes"),
    );
    await expect(setHostSizes(API, HOST, {}, fetcher)).rejects.toThrow(
      "failed to update the host's sizes (validation_failed: Invalid host sizes)",
    );
  });
});

describe("setHostTransport", () => {
  it("clears the URL when moving a host into the tunnel", async () => {
    const fetcher = responding(Response.json(HOST));
    await setHostTransport(API, HOST, "tunnel", fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.amika.dev/api/v0beta1/hosts/host_1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          hostname: "builder",
          transport_mode: "tunnel",
          url: null,
        }),
        redirect: "error",
      }),
    );
  });

  it("leaves the URL alone when moving a host out of the tunnel", async () => {
    const fetcher = responding(Response.json(HOST));
    await setHostTransport(API, HOST, "listen", fetcher);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      hostname: "builder",
      transport_mode: "listen",
    });
  });

  it("explains a failure", async () => {
    const fetcher = responding(
      apiErrorBody(
        400,
        "host_tunnel_disabled",
        "This deployment does not offer the tunnel",
      ),
    );
    await expect(
      setHostTransport(API, HOST, "tunnel", fetcher),
    ).rejects.toThrow(
      "failed to switch the host to tunnel mode (host_tunnel_disabled: This deployment does not offer the tunnel)",
    );
  });
});

describe("setHostSecret", () => {
  it("replaces the host's stored secret, keeping its hostname", async () => {
    const fetcher = responding(Response.json(HOST));
    await setHostSecret(API, HOST, "new-secret", fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.amika.dev/api/v0beta1/hosts/host_1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ hostname: "builder", secret: "new-secret" }),
        redirect: "error",
      }),
    );
  });

  it("stops the request when the caller cancels it", async () => {
    const fetcher = responding(Response.json(HOST));
    const cancel = new AbortController();
    await setHostSecret(API, HOST, "new-secret", fetcher, cancel.signal);
    const signal = fetcher.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    cancel.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("reports a refusal without the secret", async () => {
    const fetcher = responding(
      apiErrorBody(404, "host_not_found", "Host not found"),
    );
    const error = await setHostSecret(API, HOST, "new-secret", fetcher).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AmikaApiError);
    expect(String(error)).toContain("update the host's secret key");
    expect(String(error)).not.toContain("new-secret");
  });
});

describe("host type", () => {
  const RESOURCES = {
    vcpus: 8,
    memoryGib: 16,
    diskGib: 460.4,
    os: "linux",
    arch: "x64",
  };
  const BARE_METAL = {
    hostType: "bare_metal" as const,
    resources: RESOURCES,
    sshUser: "jakub",
  };
  const body = (fetcher: ReturnType<typeof responding>) =>
    JSON.parse(String(fetcher.mock.calls[0][1]?.body));

  it("sends none of the bare-metal fields for a VM host", async () => {
    const fetcher = responding(Response.json(HOST, { status: 201 }));
    await registerHost(API, INPUT, fetcher);
    expect(Object.keys(body(fetcher)).sort()).toEqual([
      "hostname",
      "secret",
      "sizes",
    ]);
  });

  it("registers a bare-metal host with its resources and login account", async () => {
    const fetcher = responding(
      Response.json({ ...HOST, host_type: "bare_metal" }, { status: 201 }),
    );
    const { host } = await registerHost(
      API,
      { ...INPUT, sizes: {}, hostType: BARE_METAL },
      fetcher,
    );
    expect(body(fetcher)).toEqual({
      hostname: "builder",
      secret: "host-secret",
      sizes: {},
      host_type: "bare_metal",
      resources: RESOURCES,
      ssh_user: "jakub",
    });
    expect(host.host_type).toBe("bare_metal");
  });

  it("reads a host record without host_type, from an older control plane", async () => {
    const fetcher = responding(Response.json(HOST, { status: 200 }));
    expect((await registerHost(API, INPUT, fetcher)).host.host_type).toBe(
      undefined,
    );
  });

  it("puts a bare-metal host's report, and a VM host's switch back", async () => {
    const fetcher = responding(Response.json(HOST));
    await setHostType(API, HOST, BARE_METAL, fetcher);
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://app.amika.dev/api/v0beta1/hosts/host_1",
    );
    expect(fetcher.mock.calls[0][1]?.method).toBe("PUT");
    expect(body(fetcher)).toEqual({
      hostname: "builder",
      host_type: "bare_metal",
      resources: RESOURCES,
      ssh_user: "jakub",
    });
    const back = responding(Response.json(HOST));
    await setHostType(API, HOST, { hostType: "vm" }, back);
    expect(body(back)).toEqual({ hostname: "builder", host_type: "vm" });
  });

  it.each(["setHostType", "registerHost"])(
    "explains a host_type_conflict from %s",
    async (name) => {
      const fetcher = responding(
        apiErrorBody(409, "host_type_conflict", "host has sandboxes"),
      );
      const call =
        name === "setHostType"
          ? setHostType(API, HOST, BARE_METAL, fetcher)
          : registerHost(API, { ...INPUT, hostType: BARE_METAL }, fetcher);
      const error = await call.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(HostTypeConflictError);
      expect((error as Error).message).toBe(
        "Amika cannot make host builder bare metal: this host still has rigs; delete them before changing host type",
      );
    },
  );

  it("explains a refused switch back to VMs", async () => {
    const fetcher = responding(
      apiErrorBody(409, "host_type_conflict", "host has sandboxes"),
    );
    await expect(
      setHostType(API, HOST, { hostType: "vm" }, fetcher),
    ).rejects.toThrow(
      "Amika cannot make host builder a VM host: this host still has rigs; delete them before changing host type",
    );
  });
});
