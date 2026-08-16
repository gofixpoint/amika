import { describe, expect, it } from "vitest";
import { sandboxProviderConfigsFromEnv } from "./config-from-env";

const BASE = { DAYTONA_API_KEY: "dk" };

describe("sandboxProviderConfigsFromEnv", () => {
  it("builds the Daytona slice with defaults and leaves the others null", () => {
    const { daytona, freestyle, vercel } = sandboxProviderConfigsFromEnv(BASE);
    expect(daytona).toEqual({
      apiKey: "dk",
      apiUrl: "https://app.daytona.io/api",
      target: undefined,
      organizationId: undefined,
      useVm: false,
      useWebSocket: false,
    });
    expect(freestyle).toBeNull();
    expect(vercel).toBeNull();
  });

  it("throws when the required Daytona key is missing", () => {
    expect(() => sandboxProviderConfigsFromEnv({})).toThrow(/DAYTONA_API_KEY/);
  });

  it("reads Daytona overrides and lenient ENABLE_DAYTONA_VM", () => {
    const { daytona } = sandboxProviderConfigsFromEnv({
      ...BASE,
      DAYTONA_API_URL: "https://custom",
      DAYTONA_TARGET: "eu",
      DAYTONA_ORGANIZATION_ID: "org_1",
      ENABLE_DAYTONA_VM: "on", // lenient token
    });
    expect(daytona).toMatchObject({
      apiUrl: "https://custom",
      target: "eu",
      organizationId: "org_1",
      useVm: true,
    });
  });

  it("leaves the Daytona event stream off unless ENABLE_DAYTONA_WEBSOCKET is set", () => {
    expect(sandboxProviderConfigsFromEnv(BASE).daytona.useWebSocket).toBe(
      false,
    );
    expect(
      sandboxProviderConfigsFromEnv({ ...BASE, ENABLE_DAYTONA_WEBSOCKET: "on" })
        .daytona.useWebSocket,
    ).toBe(true);
  });

  it("gates Freestyle on FREESTYLE_ENABLED=true and toggles snapshotPersistence", () => {
    expect(
      sandboxProviderConfigsFromEnv({ ...BASE, FREESTYLE_ENABLED: "1" })
        .freestyle,
    ).toBeNull(); // strict: only exactly "true" enables

    const on = sandboxProviderConfigsFromEnv({
      ...BASE,
      FREESTYLE_ENABLED: "true",
      FREESTYLE_API_KEY: "fk",
      FREESTYLE_STAGING_SNAPSHOTS: "true",
    }).freestyle;
    expect(on).toEqual({
      apiKey: "fk",
      apiUrl: undefined,
      snapshotPersistence: "sticky",
    });

    const persistent = sandboxProviderConfigsFromEnv({
      ...BASE,
      FREESTYLE_ENABLED: "true",
      FREESTYLE_API_KEY: "fk",
    }).freestyle;
    expect(persistent?.snapshotPersistence).toBe("persistent");
  });

  it("gates Vercel on VERCEL_ENABLED=true and requires its credentials", () => {
    // Enabled but missing credentials → throws for the first missing var.
    expect(() =>
      sandboxProviderConfigsFromEnv({ ...BASE, VERCEL_ENABLED: "true" }),
    ).toThrow(/VERCEL_TOKEN/);

    const vercel = sandboxProviderConfigsFromEnv({
      ...BASE,
      VERCEL_ENABLED: "true",
      VERCEL_TOKEN: "vt",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "proj",
    }).vercel;
    expect(vercel).toEqual({ apiKey: "vt", teamId: "team", projectId: "proj" });
  });
});
