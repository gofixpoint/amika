/**
 * Which guest port each named service of a machine listens on, and who may
 * reach it at its own name.
 *
 * smolvm publishes guest ports but stores no service names, so hostd records
 * the names a machine was created with and resolves
 * `/v0beta1/rigs/<machine>/services/<name>/...` through them. Beside the
 * port, an entry records what the control plane said of the service at its
 * public name (`<service>--<rig>.r.<org>.o.<zone>`): who Amika admits there
 * (`auth`) and whether the service sees that name in `Host`
 * (`preserveHost`). The rig's owner is kept with its services, for `owner`.
 * The file registry keeps all of it across daemon restarts; it is written
 * whole, atomically, on every change.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  SERVICE_AUTH_MODES,
  type NamedService,
  type ServiceAuth,
} from "@amika/service-auth/gateway";
import type { ServiceInput } from "./requests.js";
import type { NamedRoute } from "./tunnel-rig-route.js";

/** One service of a machine, as the control plane declared it. */
export interface ServiceEntry {
  port: number;
  /** Who Amika admits at the service's own name. */
  auth: ServiceAuth;
  /** Whether the service sees its public name in `Host`, or its loopback address. */
  preserveHost: boolean;
}

/** A service given as a bare port takes the defaults: today's behavior. */
const DEFAULT_ENTRY: Omit<ServiceEntry, "port"> = {
  auth: "organization",
  preserveHost: false,
};

export interface ServiceRegistry {
  /** The guest port of `service` on `machine`, if it was created with one. */
  port(machine: string, service: string): number | undefined;
  /** Everything recorded of `service` on `machine`, if it was created with one. */
  entry(machine: string, service: string): ServiceEntry | undefined;
  /** The Amika user id that owns `machine`, if the control plane said. */
  owner(machine: string): string | undefined;
  /**
   * Record a machine's services, replacing any from an earlier machine. A
   * bare port is a service with the defaults.
   */
  set(
    machine: string,
    services: Record<string, number | ServiceEntry>,
    owner?: string,
  ): void;
  remove(machine: string): void;
}

/** The entries a create or replace body declares, by name, defaults filled. */
export function serviceEntries(
  services: ServiceInput[],
): Record<string, ServiceEntry> {
  return Object.fromEntries(
    services.map(({ name, port, auth, preserve_host }) => [
      name,
      {
        port,
        auth: auth ?? DEFAULT_ENTRY.auth,
        preserveHost: preserve_host ?? DEFAULT_ENTRY.preserveHost,
      },
    ]),
  );
}

/** What the gateway asks of a named request, and what hostd forwards with. */
export interface NamedAccess extends NamedService {
  preserveHost: boolean;
}

/**
 * The service a tunnelled request names, with what the registry recorded
 * of it: who may have it and the `Host` it sees. A service the registry
 * does not know takes the defaults, and is then not found by its port.
 */
export function namedService(
  registry: ServiceRegistry,
  { machine, service }: NamedRoute,
): NamedAccess {
  const entry = registry.entry(machine, service);
  const owner = registry.owner(machine);
  return {
    machine,
    service,
    auth: entry?.auth ?? DEFAULT_ENTRY.auth,
    preserveHost: entry?.preserveHost ?? DEFAULT_ENTRY.preserveHost,
    ...(owner === undefined ? {} : { owner }),
  };
}

/** A registry persisted to `file`, created with private permissions. */
export function fileServiceRegistry(file: string): ServiceRegistry {
  const machines = load(file);
  const save = () => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(toFile(machines))}\n`, {
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

interface MachineRecord {
  owner?: string;
  services: Record<string, ServiceEntry>;
}

function registryOver(
  machines: Map<string, MachineRecord>,
  save: () => void,
): ServiceRegistry {
  const entry = (machine: string, service: string) => {
    const services = machines.get(machine)?.services;
    return services && Object.hasOwn(services, service)
      ? services[service]
      : undefined;
  };
  return {
    port: (machine, service) => entry(machine, service)?.port,
    entry,
    owner: (machine) => machines.get(machine)?.owner,
    set: (machine, services, owner) => {
      const entries: Record<string, ServiceEntry> = {};
      for (const [name, value] of Object.entries(services)) {
        entries[name] =
          typeof value === "number" ? { ...DEFAULT_ENTRY, port: value } : value;
      }
      machines.set(machine, {
        ...(owner === undefined ? {} : { owner }),
        services: entries,
      });
      save();
    },
    remove: (machine) => {
      if (machines.delete(machine)) save();
    },
  };
}

/**
 * The file as this version writes it. Snake case on disk, as the control
 * plane spells the fields, so a dump reads like the request that set it.
 */
const entryFileSchema = z.object({
  port: z.number().int(),
  auth: z.enum(SERVICE_AUTH_MODES),
  preserve_host: z.boolean(),
});
const fileSchema = z.object({
  version: z.literal(2),
  machines: z.record(
    z.string(),
    z.object({
      owner: z.string().optional(),
      services: z.record(z.string(), entryFileSchema),
    }),
  ),
});

/**
 * The file as earlier versions wrote it: each machine's names to ports and
 * nothing else. Every service it names takes the defaults.
 */
const legacyFileSchema = z.record(
  z.string(),
  z.record(z.string(), z.number().int()),
);

function toFile(
  machines: Map<string, MachineRecord>,
): z.infer<typeof fileSchema> {
  const out: z.infer<typeof fileSchema>["machines"] = {};
  for (const [machine, { owner, services }] of machines) {
    const entries: Record<string, z.infer<typeof entryFileSchema>> = {};
    for (const [name, { port, auth, preserveHost }] of Object.entries(
      services,
    )) {
      entries[name] = { port, auth, preserve_host: preserveHost };
    }
    out[machine] = {
      ...(owner === undefined ? {} : { owner }),
      services: entries,
    };
  }
  return { version: 2, machines: out };
}

/** An absent file is an empty registry; an unreadable one is an error. */
function load(file: string): Map<string, MachineRecord> {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const parsed: unknown = JSON.parse(contents);
  const current = fileSchema.safeParse(parsed);
  if (current.success) {
    return new Map(
      Object.entries(current.data.machines).map(([machine, record]) => {
        const services: Record<string, ServiceEntry> = {};
        for (const [name, { port, auth, preserve_host }] of Object.entries(
          record.services,
        )) {
          services[name] = { port, auth, preserveHost: preserve_host };
        }
        return [
          machine,
          {
            ...(record.owner === undefined ? {} : { owner: record.owner }),
            services,
          },
        ];
      }),
    );
  }
  return new Map(
    Object.entries(legacyFileSchema.parse(parsed)).map(([machine, ports]) => {
      const services: Record<string, ServiceEntry> = {};
      for (const [name, port] of Object.entries(ports)) {
        services[name] = { ...DEFAULT_ENTRY, port };
      }
      return [machine, { services }];
    }),
  );
}
