/** Cover the service registry, including persistence across restarts. */
import {
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
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });

  it("starts empty without a file, and refuses a corrupt one", () => {
    const file = tempFile();
    expect(fileServiceRegistry(file).port("demo", "web")).toBeUndefined();
    fileServiceRegistry(file).set("demo", { web: 3000 });
    writeFileSync(file, "{not json");
    expect(() => fileServiceRegistry(file)).toThrow();
  });
});
