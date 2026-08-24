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
//   - sshv1 (hidden; provider-native SSH, superseded by ssh)
//   - codev1 (hidden; provider-native SSH, superseded by code)
//
// ssh and code run over Amika's direct WebSocket SSH transport. Their sshv1 and
// codev1 predecessors use the provider's own SSH route and stay registered, but
// hidden, so existing scripts keep working.
//
// It also owns sandbox-specific flag parsing, local and remote execution
// helpers, git-backed mount preparation, rwcopy materialization, cleanup
// behavior, and command-local tests.
package sandboxcmd
