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
//
// Shells and editors use Amika's direct WebSocket SSH transport. The root
// command adds agent-send using the shared send handler.
package sandboxcmd
