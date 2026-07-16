import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Functional tests live under test/functional/ (and any *.functional.test.ts
    // file) and hit a real server. Run them via `pnpm test:functional` instead.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "test/functional/**/*.test.ts",
      "**/*.functional.test.ts",
    ],
  },
});
