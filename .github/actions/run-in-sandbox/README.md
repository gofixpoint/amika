# Run in an Amika Sandbox

This JavaScript Action keeps GitHub Actions as the workflow orchestrator while
delegating one shell command to an Amika sandbox. The checked-in `dist/index.js`
is the executable Action bundle.

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: gofixpoint/amika/.github/actions/run-in-sandbox@v1
        id: sandbox
        with:
          amika-url: https://app.amika.dev
          reuse-branch-sandbox: "true"
          fallback-sandbox-name: ci.example.${{ github.run_id }}.${{ github.run_attempt }}
          working-directory: "."
          timeout-minutes: "15"
          job-key: unit-tests
          command: .amika/scripts/ci.sh
        env:
          AMIKA_TOKEN: ${{ secrets.AMIKA_TOKEN }}

      - name: Show delegated result
        if: always()
        run: |
          echo "sandbox-name=${{ steps.sandbox.outputs.sandbox-name }}"
          echo "sandbox-url=${{ steps.sandbox.outputs.sandbox-url }}"
          echo "conclusion=${{ steps.sandbox.outputs.conclusion }}"
          echo "exit-code=${{ steps.sandbox.outputs.exit-code }}"
```

With `reuse-branch-sandbox: true`, pull request and branch workflows first look
for a sandbox bound to the current numeric GitHub repository ID and head
branch. When none exists, `fallback-sandbox-name` names the exact-revision
sandbox created for the run. Pull request workflows execute
`pull_request.head.sha`, not GitHub's synthetic merge commit. Privileged
`pull_request_target` workflows are rejected. An explicit `sandbox` instead
requires `reuse-branch-sandbox: false` and cannot be combined with a fallback
name.

For a matrix workflow, pass a stable identity that distinguishes each copy of
the job:

```yaml
with:
  command: pnpm test
  job-key: test-node-${{ matrix.node }}
```

By default the Action emits `run-id`, `run-url`, `sandbox-id`, `sandbox-name`,
`sandbox-url`, `conclusion`, and `exit-code` outputs. Command stdout and stderr
stream into the Action step log.

For pull-request work that should not hold a GitHub runner while the sandbox is
busy, submit the run asynchronously and ask Amika to post the eventual result:

```yaml
- uses: gofixpoint/amika/.github/actions/run-in-sandbox@v1
  with:
    command: .amika/scripts/ci.sh
    wait-for-completion: "false"
    report-result: pr-comment
  env:
    AMIKA_TOKEN: ${{ secrets.AMIKA_TOKEN }}
```

This mode returns after Amika accepts the run. Only acceptance-time outputs such
as `run-id` and `run-url` are available; the Action step does not reflect the
remote command's conclusion. `pr-comment` requires a pull-request workflow.

The Action sends no GitHub token, environment variables, or workspace contents
to the sandbox-command API.

## Development

Run all commands from the repository root by filtering the workspace package:

```bash
pnpm --filter @amika/run-in-sandbox-action formatcheck
pnpm --filter @amika/run-in-sandbox-action typecheck
pnpm --filter @amika/run-in-sandbox-action lint
pnpm --filter @amika/run-in-sandbox-action test
```

`pnpm --filter @amika/run-in-sandbox-action build` refreshes the checked-in
bundle and source map.
