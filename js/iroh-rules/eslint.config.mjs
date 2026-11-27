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
    files: ["**/*.ts"],
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
  // The library runs in Cloudflare Workers as well as Node: Web Crypto,
  // `TextEncoder` and `Uint8Array` only. Tests may use Node.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ regex: "^node:", message: "Use Web APIs only." }] },
      ],
      "no-restricted-globals": [
        "error",
        { name: "Buffer", message: "Use Uint8Array." },
        { name: "process", message: "Take configuration as arguments." },
      ],
    },
  },
]);

export default eslintConfig;
