import { defineConfig } from "vitest/config";

// Integration tests talk to a real sandbox vendor, so every step can take
// minutes and the files must not share one vendor account concurrently.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
  },
});
