import { defineConfig } from "vitest/config";

// Integration tests talk to a real sandbox vendor, so every step can take
// minutes and the files must not share one vendor account concurrently.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // Owns the run's audit ledger and prints the summary after every file.
    globalSetup: ["./src/providers/contract/global-setup.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    fileParallelism: false,
  },
});
