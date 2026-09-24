import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `pnpm build` emits into dist/; never run compiled copies of the tests.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
