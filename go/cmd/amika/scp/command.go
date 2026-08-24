// Package scpcmd builds the top-level `amika scp` command: a thin wrapper
// around the system scp binary that resolves sandbox references and sandbox/scp
// URIs to concrete SSH destinations before delegating the copy to scp.
//
// NewV2 builds `scp`, which carries the copy over Amika's direct WebSocket SSH
// transport. NewV1 builds the superseded `scpv1`, which resolves each sandbox to
// a provider-native SSH destination instead; it stays registered, but hidden, so
// existing scripts keep working. The V1/V2 suffixes name the two transport
// generations, which is why the current command is built by NewV2.
package scpcmd

import "github.com/spf13/cobra"

// NewV1 builds the hidden `amika scpv1` command.
func NewV1() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "scpv1 <source> ... <target>",
		Short: "Copy files to or from sandboxes over provider-native SSH (superseded by \"scp\")",
		Long: `Copy files between the local machine, sandboxes, and SSH hosts using scp, over
the provider's own SSH route.

"amika scp" is the supported way to copy files; it uses Amika's direct WebSocket
transport. This command is the earlier provider-native route, kept and hidden so
existing scripts keep working. Prefer "amika scp".

Every argument is forwarded to the system scp binary unchanged, so all the usual
scp flags (-r, -p, -C, -v, ...) work. Sources and targets may be given in any of
these forms:

  PATH                              a local path
  NAME[:PATH]                       a path in sandbox NAME (scp-style): a
                                    relative PATH is under the sandbox home, an
                                    absolute PATH is used verbatim
  sbox://NAME[/PATH]                a path in sandbox NAME (URI form): PATH is
                                    absolute and "~" is the home directory. A
                                    "/" in NAME must be percent-encoded as %2F
  scp://[user@]host[:port][/path]   a path on an arbitrary SSH host

Sandbox names are resolved wherever they appear, so a single command can copy
between two sandboxes, or between a sandbox and an SSH host. A bare "host:path"
always names a sandbox; use an scp:// URI to reach an arbitrary SSH host.

Examples:
  # Upload a file into the sandbox home
  amika scpv1 ./local.txt my-sandbox:local.txt

  # Recursively download an absolute directory from the sandbox
  amika scpv1 -r my-sandbox:/srv/out ./out

  # Copy from a sandbox to an SSH host
  amika scpv1 my-sandbox:/data.csv scp://user@host:22/tmp/data.csv

  # Print the resolved scp command instead of running it
  amika scpv1 --print ./a.txt my-sandbox:a.txt`,
		// Superseded by `amika scp`: reachable by name for existing scripts, but
		// kept out of the help listing so new users land on the current transport.
		Hidden: true,
		Args:   cobra.MinimumNArgs(1),
		// DisableFlagParsing forwards every argument to the system scp binary
		// unchanged, so scp's own single-dash options (including -o for
		// ssh_config overrides) pass through. scp streams its own copy progress
		// and cannot emit JSON, so runSCP rejects the long-form global --output
		// flag explicitly (see output.RejectFlagInArgs); the short -o is left
		// to forward, since it is scp's own option. See docs/cli-reference.md.
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSCP(cmd, args)
		},
	}
	cmd.Flags().Bool("print", false, "Print the resolved scp command instead of running it")
	return cmd
}
