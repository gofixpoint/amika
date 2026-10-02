import { AmikaError } from "../errors.js";

export function pollTiming(options: { pollMs?: number; maxWaitMs?: number }) {
  const pollMs = options.pollMs ?? 3_000;
  const maxWaitMs = options.maxWaitMs ?? 15 * 60_000;
  for (const [name, value] of Object.entries({ pollMs, maxWaitMs })) {
    if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new AmikaError(
        `wait: ${name} must be a positive integer no greater than 2147483647`,
      );
    }
  }
  return { pollMs, maxWaitMs };
}

/** Bound requests, token loading, response consumption, and poll sleeps together. */
export async function withDeadline<T>(
  maxWaitMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  timeout: () => Error,
): Promise<T> {
  const controller = new AbortController();
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  const timer = setTimeout(() => controller.abort(), maxWaitMs);
  try {
    return await Promise.race([run(controller.signal), aborted]);
  } catch (error) {
    if (controller.signal.aborted) throw timeout();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
