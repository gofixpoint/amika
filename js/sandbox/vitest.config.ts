import { defineConfig } from "vitest/config";

// Unit tests. Integration tests (`*.integration.test.ts`) reach real sandbox
// vendors and run under `vitest.integration.config.ts` instead.
export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
});
