import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Separate config for functional tests against a real Amika server. The
// default vitest.config.ts excludes test/functional/ so `pnpm test` stays
// offline. Use `pnpm test:functional` (with AMIKA_API_URL and AMIKA_API_TOKEN
// set) to run these.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["test/functional/**/*.test.ts", "**/*.functional.test.ts"],
    // Fail fast (before any test runs) if pointed at a production host.
    globalSetup: ["./test/functional/global-setup.ts"],
    // Sandbox provisioning + agent-send can take several minutes.
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 15 * 60 * 1000,
    // Avoid sharing API quota across concurrent files.
    fileParallelism: false,
  },
});
