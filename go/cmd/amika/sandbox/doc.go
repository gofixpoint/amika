// Package sandboxcmd builds the `amika sandbox` command tree.
//
// The package owns the top-level sandbox command plus its subcommands for
// creating, listing, starting, stopping, connecting to, deleting, and
// interacting with sandboxes. The command tree currently includes:
//
//   - create
//   - list
//   - start
//   - stop
//   - connect
//   - delete
//   - ssh
//   - code
//   - agent-send
//
// It also owns sandbox-specific flag parsing, local and remote execution
// helpers, git-backed mount preparation, rwcopy materialization, cleanup
// behavior, and command-local tests.
package sandboxcmd
