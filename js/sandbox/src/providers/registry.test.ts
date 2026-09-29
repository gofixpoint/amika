import { describe, expect, it } from "vitest";
import { moduleLogger, type SandboxCtx } from "../logger";
import {
  createSandboxProvider,
  getSandboxAdapter,
  type SandboxProviderDeps,
} from "./registry";
import { isSandboxProviderName } from "./capabilities";
import { SandboxProviderUnsupportedError } from "./provider";
import type { SandboxProviderName } from "../types";

/**
 * Construction smoke test: every real provider must build without tripping
 * `defineProvider`'s capability-reconciliation assertion (which runs at
 * construction, not typecheck). Factories are lazy — no SDK network calls — so
 * this only exercises the assembly + assertion.
 */
const DEPS: SandboxProviderDeps = {
  daytona: { apiKey: "k", apiUrl: "https://app.daytona.io/api" },
  e2b: { apiKey: "k" },
  freestyle: { apiKey: "k" },
  vercel: { apiKey: "k", teamId: "t", projectId: "p" },
  smol: {},
  amikaHostd: { secretKey: "s" },
  resolveSnapshotId: async () => null,
};

describe("createSandboxProvider construction", () => {
  const names: SandboxProviderName[] = [
    "daytona",
    "e2b",
    "freestyle",
    "vercel",
    "smol",
    "amika-hostd",
  ];

  it.each(names)("constructs %s with a coherent object surface", (name) => {
    const p = createSandboxProvider(name, DEPS);
    // The object surface is always present; a Sandbox ref resolves without I/O
    // and its richer sub-namespaces are null-or-object.
    const sbox = p.sandboxes.get("sb_1");
    expect(sbox.id).toBe("sb_1");
    for (const ns of [sbox.ssh, sbox.services, sbox.snapshots] as const) {
      expect(ns === null || typeof ns === "object").toBe(true);
    }
  });

  it("requires the hostd config slice for providers and adapters", async () => {
    const deps = { ...DEPS, amikaHostd: null };
    expect(() => createSandboxProvider("amika-hostd", deps)).toThrow(
      /AMIKA_HOSTD_ENABLED/,
    );
    expect(() => getSandboxAdapter("amika-hostd", deps, "demo")).toThrow(
      /AMIKA_HOSTD_ENABLED/,
    );
    const adapter = await getSandboxAdapter("amika-hostd", DEPS, "demo");
    expect(adapter.exec).toBeTypeOf("function");
  });

  it("gives Smol full provisioning without service routing", async () => {
    const provider = createSandboxProvider("smol", DEPS);
    expect(provider.capabilities.lifecycle).toBe(true);
    expect(provider.capabilities.exec).toBe(true);
    expect(provider.capabilities.listSandboxes).toBe(true);
    const sandbox = provider.sandboxes.get("local");
    expect(sandbox.services).toBeNull();
    expect(sandbox.snapshots).toBeNull();
    await expect(
      sandbox.streamExec("echo hello", { onStdout: () => {} }),
    ).rejects.toThrow(SandboxProviderUnsupportedError);
    expect(() =>
      createSandboxProvider("smol", { ...DEPS, smol: null }),
    ).toThrow(/SMOL_ENABLED/);
  });

  it("gives the three real providers the full capability set", () => {
    for (const name of ["daytona", "e2b", "freestyle", "vercel"] as const) {
      const p = createSandboxProvider(name, DEPS);
      expect(p.capabilities.lifecycle, name).toBe(true);
      expect(p.capabilities.exec, name).toBe(true);
      expect(p.capabilities.listSandboxes, name).toBe(true);
      const sbox = p.sandboxes.get("sb_1");
      expect(sbox.services, name).not.toBeNull();
      // Vercel uses no-relay SSH (services-based) and exposes no legacy `ssh`
      // namespace; Daytona and Freestyle keep the short-lived SSH capability.
      if (name === "e2b" || name === "vercel") {
        expect(sbox.ssh, name).toBeNull();
      } else {
        expect(sbox.ssh, name).not.toBeNull();
      }
    }
  });

  it("rejects a retired provider name (local-docker) as unsupported", () => {
    // `local-docker` was removed from the provider-name union entirely;
    // persisted rows that still carry it resolve as unsupported, same as any
    // unknown name.
    expect(isSandboxProviderName("local-docker")).toBe(false);
    expect(() => createSandboxProvider("local-docker", DEPS)).toThrow(
      SandboxProviderUnsupportedError,
    );
  });

  it("rejects Object.prototype keys as provider names", () => {
    // The guard matches against the canonical name list, so these are rejected
    // like any other unknown name. Kept as a regression test because a guard
    // written against the registry table instead (with `in`, or any lookup that
    // walks the prototype chain) would resolve "constructor" to `Object` and
    // make `createSandboxProvider` return garbage instead of throwing.
    for (const name of ["toString", "constructor", "valueOf", "__proto__"]) {
      expect(isSandboxProviderName(name), name).toBe(false);
      expect(() => createSandboxProvider(name, DEPS), name).toThrow(
        SandboxProviderUnsupportedError,
      );
    }
  });
});

it("applies an injected host connection policy to providers and adapters", async () => {
  const visited: string[] = [];
  const blockedFetch: typeof fetch = async (input) => {
    visited.push(String(input));
    throw new Error("destination rejected");
  };
  const deps = {
    ...DEPS,
    amikaHostd: { apiUrl: "https://tenant.example", secretKey: "test-secret" },
    amikaHostdFetcher: blockedFetch,
  };
  const provider = createSandboxProvider("amika-hostd", deps);
  const sandbox = provider.sandboxes.get("demo");
  // Each operation must encounter the injected policy before any daemon I/O.
  const ctx: SandboxCtx = { logger: moduleLogger(), childCtx: () => ctx };
  const operations = [
    () =>
      provider.sandboxes.create(ctx, {
        name: "demo",
        snapshot: "ubuntu:24.04",
        services: [],
      }),
    () => provider.sandboxes.list(),
    () => sandbox.getState(),
    () => sandbox.start(),
    () => sandbox.stop(),
    () => sandbox.delete(),
    () => sandbox.exec("true"),
    () => sandbox.readFile("/tmp/file"),
    () => sandbox.writeFile("/tmp/file", "content"),
  ];
  for (const operation of operations) {
    await expect(operation()).rejects.toThrow("destination rejected");
  }
  const adapter = await getSandboxAdapter("amika-hostd", deps, "demo");
  await expect(adapter.exec("true")).rejects.toThrow("destination rejected");
  await expect(adapter.downloadFile("/tmp/file")).rejects.toThrow(
    "destination rejected",
  );
  await expect(adapter.uploadFile("content", "/tmp/file")).rejects.toThrow(
    "destination rejected",
  );
  expect(visited).toHaveLength(operations.length + 3);
  expect(
    visited.every((url) => url.startsWith("https://tenant.example/")),
  ).toBe(true);
  expect(sandbox.services).toBeNull();
});
