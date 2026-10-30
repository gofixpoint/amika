/** Cover the service registry, including persistence across restarts. */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileServiceRegistry,
  memoryServiceRegistry,
  namedService,
  serviceEntries,
} from "./service-registry.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hostd-registry-"));
  dirs.push(dir);
  return path.join(dir, "state", "services.json");
}

describe("service registry", () => {
  it("maps each machine's names to ports, and forgets a removed machine", () => {
    const registry = memoryServiceRegistry();
    registry.set("demo", { web: 3000, amikad: 60999 });
    registry.set("other", { web: 8080 });
    expect(registry.port("demo", "web")).toBe(3000);
    expect(registry.port("other", "web")).toBe(8080);
    expect(registry.port("demo", "nope")).toBeUndefined();
    // Inherited object keys are not services.
    expect(registry.port("demo", "constructor")).toBeUndefined();
    registry.remove("demo");
    expect(registry.port("demo", "web")).toBeUndefined();
  });

  it("replaces a recreated machine's services", () => {
    const registry = memoryServiceRegistry();
    registry.set("demo", { web: 3000 });
    registry.set("demo", { api: 4000 });
    expect(registry.port("demo", "web")).toBeUndefined();
    expect(registry.port("demo", "api")).toBe(4000);
  });

  it("persists across restarts in a private file", () => {
    const file = tempFile();
    const first = fileServiceRegistry(file);
    first.set("demo", { web: 3000 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fileServiceRegistry(file).port("demo", "web")).toBe(3000);
    first.remove("demo");
    expect(fileServiceRegistry(file).port("demo", "web")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 2,
      machines: {},
    });
  });

  it("starts empty without a file, and refuses a corrupt one", () => {
    const file = tempFile();
    expect(fileServiceRegistry(file).port("demo", "web")).toBeUndefined();
    fileServiceRegistry(file).set("demo", { web: 3000 });
    writeFileSync(file, "{not json");
    expect(() => fileServiceRegistry(file)).toThrow();
  });
});

describe("what a service is at its name", () => {
  it("records each entry, with the defaults for a bare port", () => {
    const registry = memoryServiceRegistry();
    registry.set("demo", {
      web: 3000,
      app: { port: 4000, auth: "public", preserveHost: true },
    });
    expect(registry.entry("demo", "web")).toEqual({
      port: 3000,
      auth: "organization",
      preserveHost: false,
    });
    expect(registry.entry("demo", "app")).toEqual({
      port: 4000,
      auth: "public",
      preserveHost: true,
    });
    expect(registry.port("demo", "app")).toBe(4000);
    expect(registry.entry("demo", "nope")).toBeUndefined();
  });

  it("keeps the owner with the services, and drops it with them", () => {
    const registry = memoryServiceRegistry();
    registry.set("demo", { web: 3000 }, "user_1");
    expect(registry.owner("demo")).toBe("user_1");
    registry.set("demo", { web: 3000 });
    expect(registry.owner("demo")).toBeUndefined();
    registry.set("demo", { web: 3000 }, "user_2");
    registry.remove("demo");
    expect(registry.owner("demo")).toBeUndefined();
  });

  it("persists entries and the owner, and reads them back", () => {
    const file = tempFile();
    fileServiceRegistry(file).set(
      "demo",
      { web: 3000, app: { port: 4000, auth: "owner", preserveHost: true } },
      "user_1",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 2,
      machines: {
        demo: {
          owner: "user_1",
          services: {
            web: { port: 3000, auth: "organization", preserve_host: false },
            app: { port: 4000, auth: "owner", preserve_host: true },
          },
        },
      },
    });
    const reopened = fileServiceRegistry(file);
    expect(reopened.owner("demo")).toBe("user_1");
    expect(reopened.entry("demo", "app")).toEqual({
      port: 4000,
      auth: "owner",
      preserveHost: true,
    });
  });

  it("reads a file from before entries: every service at the defaults, no owner", () => {
    const file = tempFile();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ demo: { web: 3000, amikad: 60999 } }));
    const registry = fileServiceRegistry(file);
    expect(registry.entry("demo", "web")).toEqual({
      port: 3000,
      auth: "organization",
      preserveHost: false,
    });
    expect(registry.owner("demo")).toBeUndefined();
    // Written back in the current form.
    registry.set("other", { api: 5000 });
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(2);
    expect(fileServiceRegistry(file).port("demo", "amikad")).toBe(60999);
  });

  it("fills a body's defaults, and answers a named request from the entry", () => {
    expect(
      serviceEntries([
        { name: "web", port: 3000 },
        { name: "app", port: 4000, auth: "public", preserve_host: true },
      ]),
    ).toEqual({
      web: { port: 3000, auth: "organization", preserveHost: false },
      app: { port: 4000, auth: "public", preserveHost: true },
    });
    const registry = memoryServiceRegistry();
    registry.set(
      "demo",
      { app: { port: 4000, auth: "owner", preserveHost: true } },
      "user_1",
    );
    expect(namedService(registry, { machine: "demo", service: "app" })).toEqual(
      {
        machine: "demo",
        service: "app",
        auth: "owner",
        preserveHost: true,
        owner: "user_1",
      },
    );
    // A service the registry does not know takes the defaults, and is then
    // not found by its port.
    expect(
      namedService(registry, { machine: "demo", service: "nope" }),
    ).toEqual({
      machine: "demo",
      service: "nope",
      auth: "organization",
      preserveHost: false,
      owner: "user_1",
    });
  });
});
