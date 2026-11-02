import { createRequire } from "node:module";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const require = createRequire(import.meta.url);
const localRules = require("../../eslint-rules/index.cjs");

const eslintConfig = defineConfig([
  {
    ignores: ["node_modules/**", "dist/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },
  {
    plugins: { local: localRules },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "local/no-cross-package-internal": "error",
    },
  },
  // OS-dependent code lives behind `src/platforms/` (`HostPlatform`), which
  // is resolved once and passed through deps so tests choose the OS. Tests
  // may still ask which machine they run on, to pick real binaries.
  {
    files: ["**/*.{ts,mjs}"],
    ignores: ["src/platforms/**", "**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "platform",
          message:
            "Read the OS through HostPlatform (src/platforms/), passed in deps.",
        },
        {
          object: "os",
          property: "platform",
          message:
            "Read the OS through HostPlatform (src/platforms/), passed in deps.",
        },
      ],
    },
  },
]);

export default eslintConfig;
