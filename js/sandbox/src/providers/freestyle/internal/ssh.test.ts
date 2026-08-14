import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FreestyleConfig } from "../config";
import {
  _buildFreestyleSshDestination,
  _decodeFreestyleSshHandle,
  _encodeFreestyleSshHandle,
  createFreestyleSshAccess,
  revokeFreestyleSshAccess,
} from "./ssh";

const grantVm = vi.fn();
const createToken = vi.fn();
const revokeToken = vi.fn();
const createIdentity = vi.fn();
const refIdentity = vi.fn();
const deleteIdentity = vi.fn();

vi.mock("./client", () => ({
  createFreestyleClient: () => ({
    identities: {
      create: createIdentity,
      ref: refIdentity,
      delete: deleteIdentity,
    },
  }),
}));

const config: FreestyleConfig = { apiKey: "test-key" };

beforeEach(() => {
  for (const fn of [
    grantVm,
    createToken,
    revokeToken,
    createIdentity,
    refIdentity,
    deleteIdentity,
  ]) {
    fn.mockReset();
  }
  createIdentity.mockResolvedValue({
    identityId: "id_1",
    identity: {
      permissions: { vms: { grant: grantVm } },
      tokens: { create: createToken },
    },
  });
  createToken.mockResolvedValue({ tokenId: "tok_1", token: "secret-xyz" });
  refIdentity.mockReturnValue({ tokens: { revoke: revokeToken } });
  grantVm.mockResolvedValue(undefined);
  revokeToken.mockResolvedValue(undefined);
  deleteIdentity.mockResolvedValue(undefined);
});

describe("_buildFreestyleSshDestination", () => {
  it("builds a vmId+user:token@host destination for the amika user", () => {
    expect(_buildFreestyleSshDestination("vm_abc", "tok123")).toBe(
      "vm_abc+amika:tok123@vm-ssh.freestyle.sh",
    );
  });
});

describe("Freestyle SSH revocation handle", () => {
  it("round-trips identity and token ids", () => {
    const handle = _encodeFreestyleSshHandle({
      identityId: "id_1",
      tokenId: "tok_1",
    });
    expect(_decodeFreestyleSshHandle(handle)).toEqual({
      identityId: "id_1",
      tokenId: "tok_1",
    });
  });

  it("encodes to a URL/SSH-safe string (no secret token inside)", () => {
    const handle = _encodeFreestyleSshHandle({
      identityId: "id_1",
      tokenId: "tok_1",
    });
    expect(handle).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(handle).not.toContain("secret-xyz");
  });

  it("throws on a malformed handle", () => {
    expect(() => _decodeFreestyleSshHandle("not-base64-json!!")).toThrow(
      /Malformed/,
    );
  });
});

describe("createFreestyleSshAccess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints an identity, grants the VM, and returns a usable destination", async () => {
    const access = await createFreestyleSshAccess(config, "vm_abc", 8 * 60);

    // Grant is scoped to one VM and only the amika user (least privilege).
    expect(grantVm).toHaveBeenCalledWith({
      vmId: "vm_abc",
      allowedUsers: ["amika"],
    });
    // The secret token lives only in the destination.
    expect(access.sshDestination).toBe(
      "vm_abc+amika:secret-xyz@vm-ssh.freestyle.sh",
    );
    // `token` is the revocation handle (identity + token ids), not the secret.
    expect(_decodeFreestyleSshHandle(access.token)).toEqual({
      identityId: "id_1",
      tokenId: "tok_1",
    });
    // Advisory expiry derived from the requested window.
    expect(access.expiresAt.toISOString()).toBe("2026-06-21T08:00:00.000Z");
  });

  // An opaque provider 500 (e.g. granting access to a VM that isn't ready)
  // should name the failing step and keep the original error as `cause` so the
  // provider trace id survives into the logs.
  it("labels the failing step and preserves the original error as cause", async () => {
    const providerError = new Error("INTERNAL_ERROR: Internal server error");
    grantVm.mockRejectedValue(providerError);

    await expect(
      createFreestyleSshAccess(config, "vm_abc", 8 * 60),
    ).rejects.toMatchObject({
      message:
        "freestyle ssh: grant vm access: INTERNAL_ERROR: Internal server error",
      cause: providerError,
    });
    // The step that fails first short-circuits the rest.
    expect(createToken).not.toHaveBeenCalled();
  });
});

describe("revokeFreestyleSshAccess", () => {
  it("revokes the token and deletes the identity from the handle", async () => {
    const handle = _encodeFreestyleSshHandle({
      identityId: "id_1",
      tokenId: "tok_1",
    });

    await revokeFreestyleSshAccess(config, handle);

    expect(refIdentity).toHaveBeenCalledWith({ identityId: "id_1" });
    expect(revokeToken).toHaveBeenCalledWith({ tokenId: "tok_1" });
    expect(deleteIdentity).toHaveBeenCalledWith({ identityId: "id_1" });
  });

  it("still deletes the identity when the token revoke fails", async () => {
    revokeToken.mockRejectedValue(new Error("already revoked"));
    const handle = _encodeFreestyleSshHandle({
      identityId: "id_1",
      tokenId: "tok_1",
    });

    await revokeFreestyleSshAccess(config, handle);

    expect(deleteIdentity).toHaveBeenCalledWith({ identityId: "id_1" });
  });
});
