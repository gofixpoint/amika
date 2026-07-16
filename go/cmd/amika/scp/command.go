// Package scpcmd builds the top-level `amika scp` command: a thin wrapper
// around the system scp binary that resolves sandbox references and sandbox/scp
// URIs to concrete SSH destinations before delegating the copy to scp.
package scpcmd

import "github.com/spf13/cobra"

// New builds the `amika scp` command.
func New() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "scp <source> ... <target>",
		Short: "Copy files to or from sandboxes over SSH",
		Long: `Copy files between the local machine, sandboxes, and SSH hosts using scp.

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
  amika scp ./local.txt my-sandbox:local.txt

  # Recursively download an absolute directory from the sandbox
  amika scp -r my-sandbox:/srv/out ./out

  # Copy from a sandbox to an SSH host
  amika scp my-sandbox:/data.csv scp://user@host:22/tmp/data.csv

  # Print the resolved scp command instead of running it
  amika scp --print ./a.txt my-sandbox:a.txt`,
		Args:               cobra.MinimumNArgs(1),
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSCP(cmd, args)
		},
	}
	cmd.Flags().Bool("print", false, "Print the resolved scp command instead of running it")
	return cmd
}
