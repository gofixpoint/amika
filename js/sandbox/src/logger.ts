/**
 * Minimal logging + context contract the provider layer codes against.
 *
 * The package does not depend on any caller-side context class or on `pino`
 * directly; it defines the small structural surface the providers actually use
 * (`ctx.logger` + `ctx.childCtx`). Any context object with a `pino`-style
 * logger satisfies {@link SandboxCtx} structurally, so callers pass their
 * existing context unchanged.
 */

/** The subset of a structured logger (e.g. `pino.Logger`) the providers use. */
export interface Logger {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Provider-facing request context: a logger plus child-context derivation. */
export interface SandboxCtx {
  readonly logger: Logger;
  childCtx(bindings: Record<string, unknown>): SandboxCtx;
}

/**
 * A minimal console-backed {@link Logger}, for the few module-scoped call sites
 * that log outside a request context (e.g. best-effort SSH bridge warnings).
 * Real structured logging flows in through `SandboxCtx.logger`; this is a
 * dependency-free fallback so the package needs no logging library.
 */
export function moduleLogger(bindings: Record<string, unknown> = {}): Logger {
  const emit =
    (level: "info" | "warn" | "error" | "debug") =>
    (objOrMsg: object | string, msg?: string) => {
      const [obj, message] =
        typeof objOrMsg === "string" ? [{}, objOrMsg] : [objOrMsg, msg];
      console[level]({ ...bindings, ...obj }, message ?? "");
    };
  return {
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: emit("debug"),
    child: (childBindings) => moduleLogger({ ...bindings, ...childBindings }),
  };
}
