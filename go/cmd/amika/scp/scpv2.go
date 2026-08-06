package scpcmd

// scpv2.go implements `amika scpv2`: the same operand grammar as `amika scp`,
// carried over the beta direct WebSocket transport that backs
// `amika sandbox sshv2` instead of the v1 provider-native SSH access.
//
// The transport difference is entirely in how a sandbox reference becomes an
// scp operand. v1 resolves a sandbox to a concrete host/port/user and spells
// out connection options on the command line; v2 resolves it to its
// `<name>.<id>.amika` alias, whose User, IdentityFile, host-key policy, and
// ProxyCommand all come from the managed `Host *.amika` block in
// ~/.ssh/amika.conf. So there are no connection options to prepend here — the
// operands are rewritten and system scp is handed the rest unchanged.

import (
	"fmt"
	"strings"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

// aliasResolver resolves a sandbox name to its prepared v2 host alias.
type aliasResolver func(name string) (string, error)

func runSCPV2(cmd *cobra.Command, rawArgs []string) error {
	// DisableFlagParsing bypasses cobra's built-in help flag, so handle it here.
	if hasHelpFlag(rawArgs) {
		return cmd.Help()
	}
	if err := output.RejectFlagInArgs(rawArgs); err != nil {
		return err
	}
	if runmode.Resolve(cmd) == runmode.Local {
		return fmt.Errorf("direct WebSocket SSH requires a remote sandbox")
	}

	plan, err := parseSCPArgs(rawArgs)
	if err != nil {
		return err
	}

	// Resolved lazily and cached by name: each sandbox is fetched and pinned at
	// most once, and a copy naming no sandbox performs no API call and needs no
	// auth (the same contract as `amika scp`).
	var client *apiclient.Client
	aliases := map[string]string{}
	resolve := func(name string) (string, error) {
		if alias, ok := aliases[name]; ok {
			return alias, nil
		}
		if client == nil {
			if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
				return "", err
			}
			client = runmode.NewRemoteClient()
		}
		sandbox, err := client.GetSandbox(name)
		if err != nil {
			return "", err
		}
		alias, err := ssh.PrepareSessionTarget(
			basedir.New(""),
			client,
			sandbox.Name,
			sandbox.ID,
		)
		if err != nil {
			return "", err
		}
		aliases[name] = alias
		return alias, nil
	}

	scpArgs, err := buildSCPV2Invocation(plan, resolve)
	if err != nil {
		return err
	}
	if plan.printOnly {
		fmt.Fprintln(cmd.OutOrStdout(), formatCommand(append([]string{"scp"}, scpArgs...)))
		return nil
	}
	return execSCP(scpArgs)
}

// buildSCPV2Invocation rewrites each sandbox reference in the residual scp argv
// to its `<alias>:<absolute path>` form, leaving every flag, local path, and
// scp:// URI untouched and in its original position.
func buildSCPV2Invocation(plan scpPlan, resolve aliasResolver) ([]string, error) {
	rewritten := make([]string, 0, len(plan.scpArgv))
	for i := 0; i < len(plan.scpArgv); i++ {
		tok := plan.scpArgv[i]
		// An option and, when it takes one, its separate value pass straight
		// through — a value like "-o User=x" must never be read as an operand.
		if strings.HasPrefix(tok, "-") && tok != "-" {
			rewritten = append(rewritten, tok)
			if consumesNextArg(tok) && i+1 < len(plan.scpArgv) {
				i++
				rewritten = append(rewritten, plan.scpArgv[i])
			}
			continue
		}
		operand, err := rewriteV2Operand(tok, resolve)
		if err != nil {
			return nil, err
		}
		rewritten = append(rewritten, operand)
	}
	return rewritten, nil
}

// rewriteV2Operand converts one operand to its scp form. Sandbox references
// become alias operands; scp:// URIs and local paths are returned unchanged.
func rewriteV2Operand(tok string, resolve aliasResolver) (string, error) {
	switch {
	case strings.HasPrefix(tok, "sbox://"):
		name, path, err := parseSboxURI(tok)
		if err != nil {
			return "", err
		}
		alias, err := resolve(name)
		if err != nil {
			return "", err
		}
		return alias + ":" + resolveSandboxURIPath(path), nil
	case strings.HasPrefix(tok, "scp://"):
		return parseSCPURI(tok)
	case looksLikeRemote(tok):
		name, path := splitSandboxRef(tok)
		alias, err := resolve(name)
		if err != nil {
			return "", err
		}
		return alias + ":" + resolveSandboxScpPath(path), nil
	default:
		return tok, nil
	}
}

// NewV2 builds the `amika scpv2` command.
func NewV2() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "scpv2 <source> ... <target>",
		Short: "Copy files to or from sandboxes over the beta direct WebSocket transport",
		Long: `Copy files between the local machine, sandboxes, and SSH hosts using scp,
over the same beta direct WebSocket transport as "amika sandbox sshv2".

Operands take the same forms as "amika scp":

  PATH                              a local path
  NAME[:PATH]                       a path in sandbox NAME (scp-style): a
                                    relative PATH is under the sandbox home, an
                                    absolute PATH is used verbatim
  sbox://NAME[/PATH]                a path in sandbox NAME (URI form): PATH is
                                    absolute and "~" is the home directory. A
                                    "/" in NAME must be percent-encoded as %2F
  scp://[user@]host[:port][/path]   a path on an arbitrary SSH host

Each sandbox resolves to its "<name>.<id>.amika" alias, and the connection
settings come from the managed block in ~/.ssh/amika.conf, so a fresh session
is created and the host key re-pinned per dial. Requires an SSH identity from
"amika secret ssh-keygen".

Examples:
  # Upload a file into the sandbox home
  amika scpv2 ./local.txt my-sandbox:local.txt

  # Recursively download an absolute directory from the sandbox
  amika scpv2 -r my-sandbox:/srv/out ./out

  # Print the resolved scp command instead of running it
  amika scpv2 --print ./a.txt my-sandbox:a.txt`,
		Args: cobra.MinimumNArgs(1),
		// As with `amika scp`, every argument is forwarded to system scp, so
		// scp's own single-dash options pass through untouched.
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSCPV2(cmd, args)
		},
	}
	return cmd
}
