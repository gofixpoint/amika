/**
 * Shared helpers for adding context to errors and inspecting error chains.
 */

/**
 * A step label for {@link withStepContext}. A function form is evaluated only on
 * failure, for context that is expensive or only knowable after the error (e.g.
 * reading provider state once a call has already thrown).
 */
export type StepLabel = string | (() => string | Promise<string>);

/**
 * The error {@link withStepContext} always throws. Carries any caller `fields`
 * as a structured property so a handler can hoist them into a log; with no
 * fields it behaves like an ordinary wrapped `Error` (same message prefixing,
 * same `cause` chain) to be treated like any unexpected failure.
 */
export class StepContextError extends Error {
  // Assigned via `Object.defineProperty` in the constructor (non-enumerable);
  // `declare` keeps the type without emitting an enumerable field.
  declare readonly fields: Record<string, unknown>;

  constructor(
    message: string,
    fields: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StepContextError";
    // Non-enumerable so the logger's `redactError` (which copies enumerable own
    // properties) doesn't duplicate the fields onto the logged error; the error
    // handler reads `err.fields` directly and hoists them under `stepContext`.
    Object.defineProperty(this, "fields", {
      value: fields,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
}

/**
 * Run `run`, and if it throws, rethrow a *new* Error whose message is
 * `${step}: ${original message}`, preserving the original error as `cause`.
 *
 * Providers (notably Freestyle) surface opaque `INTERNAL_ERROR` 500s whose
 * message is just "Internal server error" plus a provider trace id, with no
 * indication of which call produced it. When several such calls run in sequence
 * (mint SSH = create identity -> grant VM -> create token; start = resume ->
 * rerun lifecycle), the failure log can't say which one failed. Prefixing the
 * step here makes it explicit.
 *
 * Wrapping (rather than mutating the caught error) keeps the original intact:
 * the logger's `redactError` follows `cause` recursively, so the provider's
 * class name and `traceId` are still logged under `err.cause`, and the global
 * error handler walks the `cause` chain so the underlying class still
 * surfaces at the top level.
 *
 * Any `fields` are carried on the thrown {@link StepContextError} so a handler
 * can log them.
 */
export async function withStepContext<T>(
  step: StepLabel,
  run: () => Promise<T>,
  fields?: Record<string, unknown>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const prefix = typeof step === "function" ? await step() : step;
    const message = err instanceof Error ? err.message : String(err);
    throw new StepContextError(`${prefix}: ${message}`, fields ?? {}, {
      cause: err,
    });
  }
}
