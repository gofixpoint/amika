# Cursor Cloud specific instructions

- **Git URL rewriting caveat:** The Cloud Agent environment has global git `url.*.insteadOf` rules that inject auth tokens into GitHub URLs. Two tests (`TestPrepareGitMount_CleanClone`, `TestSyncGitRemotes`) will fail unless you override this. Run tests with `GIT_CONFIG_GLOBAL=/dev/null make test` or `GIT_CONFIG_GLOBAL=/dev/null make ci` to avoid false failures.
- **Running the CLI:** After `make build`, the binary is at `dist/amika`. See `docs/development/testing.md` for the full smoke test plan.
