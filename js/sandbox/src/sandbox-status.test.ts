import { describe, expect, it } from "vitest";
import {
  deriveSandboxStatus,
  isSetupInProgress,
  parseSandboxSetupStatus,
} from "./sandbox-status";

describe("parseSandboxSetupStatus", () => {
  it("accepts every setup-track value", () => {
    expect(parseSandboxSetupStatus("ok")).toBe("ok");
    expect(parseSandboxSetupStatus("setup-running")).toBe("setup-running");
    expect(parseSandboxSetupStatus("git-failed")).toBe("git-failed");
    expect(parseSandboxSetupStatus("setup-failed")).toBe("setup-failed");
    expect(parseSandboxSetupStatus("sys-setup-failed")).toBe(
      "sys-setup-failed",
    );
  });

  it("returns null for unknown values and absent columns", () => {
    expect(parseSandboxSetupStatus(null)).toBeNull();
    expect(parseSandboxSetupStatus(undefined)).toBeNull();
    expect(parseSandboxSetupStatus("")).toBeNull();
    expect(parseSandboxSetupStatus("exploded")).toBeNull();
  });
});

describe("isSetupInProgress", () => {
  it("is true only for the in-progress setup value", () => {
    expect(isSetupInProgress("setup-running")).toBe(true);
  });

  it("is false for terminal outcomes and absent columns", () => {
    expect(isSetupInProgress("ok")).toBe(false);
    expect(isSetupInProgress("git-failed")).toBe(false);
    expect(isSetupInProgress("setup-failed")).toBe(false);
    expect(isSetupInProgress("sys-setup-failed")).toBe(false);
    expect(isSetupInProgress(null)).toBe(false);
    expect(isSetupInProgress(undefined)).toBe(false);
    expect(isSetupInProgress("exploded")).toBe(false);
  });
});

describe("deriveSandboxStatus", () => {
  it("splits initializing into creating vs starting by whether setup ever concluded", () => {
    // No recorded outcome: the first-ever initialization is still running.
    expect(
      deriveSandboxStatus({ state: "initializing", setup_status: null }),
    ).toBe("creating");
    // Any recorded outcome means this is a restart.
    expect(
      deriveSandboxStatus({ state: "initializing", setup_status: "ok" }),
    ).toBe("starting");
    expect(
      deriveSandboxStatus({
        state: "initializing",
        setup_status: "setup-failed",
      }),
    ).toBe("starting");
  });

  it("maps settled row states to the canonical vocabulary", () => {
    expect(deriveSandboxStatus({ state: "stopping" })).toBe("stopping");
    expect(deriveSandboxStatus({ state: "stopped" })).toBe("suspended");
    expect(deriveSandboxStatus({ state: "snapshotting" })).toBe("snapshotting");
    expect(deriveSandboxStatus({ state: "failed" })).toBe("failed");
    expect(deriveSandboxStatus({ state: "errored" })).toBe("failed");
  });

  it("reads an active row as running without a live state", () => {
    expect(deriveSandboxStatus({ state: "active" })).toBe("running");
  });

  it("reads an active row that is still setting up as running", () => {
    // Running-before-setup: the VM is up while the lifecycle runs, so the
    // in-progress setup track stays under the `running` lifecycle status.
    expect(
      deriveSandboxStatus({ state: "active", setup_status: "setup-running" }),
    ).toBe("running");
    expect(
      deriveSandboxStatus(
        { state: "active", setup_status: "setup-running" },
        "running",
      ),
    ).toBe("running");
  });

  it("surfaces a provider that cannot find the VM as unknown, not running", () => {
    // "unknown" is a *successful* provider answer (VM absent from the
    // listing / unfetchable) — a deleted-behind-our-back VM must not show a
    // healthy green Running.
    expect(deriveSandboxStatus({ state: "active" }, "unknown")).toBe("unknown");
  });

  it("defers to the live provider state for active rows", () => {
    expect(deriveSandboxStatus({ state: "active" }, "running")).toBe("running");
    // The provider can suspend an idle VM behind our back.
    expect(deriveSandboxStatus({ state: "active" }, "suspended")).toBe(
      "suspended",
    );
    expect(deriveSandboxStatus({ state: "active" }, "suspending")).toBe(
      "suspending",
    );
    expect(deriveSandboxStatus({ state: "active" }, "failed")).toBe("failed");
    // An active row can't be mid-create; a creation-phase live state reads as
    // coming up.
    expect(deriveSandboxStatus({ state: "active" }, "creating")).toBe(
      "starting",
    );
  });

  it("lets the row's orchestration state win over the live state during transitions", () => {
    expect(
      deriveSandboxStatus(
        { state: "initializing", setup_status: "ok" },
        "running",
      ),
    ).toBe("starting");
    expect(deriveSandboxStatus({ state: "snapshotting" }, "running")).toBe(
      "snapshotting",
    );
  });
});
