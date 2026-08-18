import { describe, expect, it } from "vitest";
import {
  createSandboxProvider,
  isSandboxProviderName,
  type SandboxProviderDeps,
} from "./registry";
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
  freestyle: { apiKey: "k" },
  sailbox: { apiKey: "k" },
  vercel: { apiKey: "k", teamId: "t", projectId: "p" },
  resolveSnapshotId: async () => null,
};

describe("createSandboxProvider construction", () => {
  const names: SandboxProviderName[] = [
    "daytona",
    "freestyle",
    "sailbox",
    "vercel",
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

  it("gives the three real providers the full capability set", () => {
    for (const name of ["daytona", "freestyle", "sailbox", "vercel"] as const) {
      const p = createSandboxProvider(name, DEPS);
      expect(p.capabilities.lifecycle, name).toBe(true);
      expect(p.capabilities.exec, name).toBe(true);
      expect(p.capabilities.listSandboxes, name).toBe(true);
      const sbox = p.sandboxes.get("sb_1");
      expect(sbox.services, name).not.toBeNull();
      // Vercel uses no-relay SSH (services-based) and exposes no legacy `ssh`
      // namespace; Daytona and Freestyle keep the short-lived SSH capability.
      if (name === "vercel" || name === "sailbox") {
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
    // The registry table is a plain object literal; the name guard must check
    // OWN keys only, or "constructor" would resolve `Object` off the prototype
    // chain and `createSandboxProvider` would return garbage instead of
    // throwing.
    for (const name of ["toString", "constructor", "valueOf", "__proto__"]) {
      expect(isSandboxProviderName(name), name).toBe(false);
      expect(() => createSandboxProvider(name, DEPS), name).toThrow(
        SandboxProviderUnsupportedError,
      );
    }
  });
});
