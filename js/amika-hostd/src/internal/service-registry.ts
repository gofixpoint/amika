/**
 * Which guest port each named service of a machine listens on.
 *
 * smolvm publishes guest ports but stores no service names, so hostd records
 * the names a machine was created with and resolves
 * `/rigs/<machine>/services/<name>/...` through them. The file registry keeps
 * the mapping across daemon restarts; it is written whole, atomically, on
 * every change.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export interface ServiceRegistry {
  /** The guest port of `service` on `machine`, if it was created with one. */
  port(machine: string, service: string): number | undefined;
  /** Record a machine's services, replacing any from an earlier machine. */
  set(machine: string, services: Record<string, number>): void;
  remove(machine: string): void;
}

/** A registry persisted to `file`, created with private permissions. */
export function fileServiceRegistry(file: string): ServiceRegistry {
  const machines = load(file);
  const save = () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(Object.fromEntries(machines))}\n`, {
      mode: 0o600,
    });
    renameSync(temp, file);
  };
  return registryOver(machines, save);
}

/** A registry that forgets everything on restart, for tests and `createApp`. */
export function memoryServiceRegistry(): ServiceRegistry {
  return registryOver(new Map(), () => {});
}

function registryOver(
  machines: Map<string, Record<string, number>>,
  save: () => void,
): ServiceRegistry {
  return {
    port: (machine, service) => {
      const services = machines.get(machine);
      return services && Object.hasOwn(services, service)
        ? services[service]
        : undefined;
    },
    set: (machine, services) => {
      machines.set(machine, services);
      save();
    },
    remove: (machine) => {
      if (machines.delete(machine)) save();
    },
  };
}

const fileSchema = z.record(z.string(), z.record(z.string(), z.number().int()));

/** An absent file is an empty registry; an unreadable one is an error. */
function load(file: string): Map<string, Record<string, number>> {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  return new Map(Object.entries(fileSchema.parse(JSON.parse(contents))));
}
