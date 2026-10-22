package scpcmd

// scpv2.go resolves sandbox references to managed SSH aliases and passes the
// rewritten operands to system scp over Amika's direct WebSocket transport.

import (
	"fmt"
	"strings"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/rigref"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

// aliasResolver resolves a rig reference, as written in an operand, to the
// rig's prepared v2 host alias.
type aliasResolver func(name string) (string, error)

// prepareSessionTarget is a seam over ssh.PrepareSessionTarget, so tests can
// check which rig identity an alias is built from without SSH key material.
var prepareSessionTarget = ssh.PrepareSessionTarget

// parseOnlyResolver parses each rig reference without resolving it, so a bad
// reference in any operand is reported before auth is checked or any rig is
// fetched.
func parseOnlyResolver(name string) (string, error) {
	if _, err := rigref.Parse(name); err != nil {
		return "", err
	}
	return name, nil
}

func runSCPV2(cmd *cobra.Command, rawArgs []string) error {
	// DisableFlagParsing bypasses cobra's built-in help flag, so handle it here.
	if hasHelpFlag(rawArgs) {
		return cmd.Help()
	}
	if err := output.RejectFlagInArgs(rawArgs); err != nil {
		return err
	}
	plan, err := parseSCPArgs(rawArgs)
	if err != nil {
		return err
	}

	if _, err := buildSCPV2Invocation(plan, parseOnlyResolver); err != nil {
		return err
	}

	// Resolved lazily and cached by reference: each sandbox is fetched and
	// pinned at most once, and a copy naming no sandbox performs no API call
	// and needs no auth. A name= or id= reference resolves to the rig's
	// canonical name and id here, and only those reach the alias scp dials.
	var client *apiclient.Client
	aliases := map[string]string{}
	resolve := func(name string) (string, error) {
		if alias, ok := aliases[name]; ok {
			return alias, nil
		}
		ref, err := rigref.Parse(name)
		if err != nil {
			return "", err
		}
		if client == nil {
			if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
				return "", err
			}
			client = runmode.NewRemoteClient()
		}
		sandbox, err := client.GetSandbox(ref.Selector())
		if err != nil {
			return "", rigref.Explain(ref, err)
		}
		alias, err := prepareSessionTarget(
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
	case isRigURI(tok):
		name, path, err := parseRigURI(tok)
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

// NewV2 builds the `amika scp` command.
func NewV2() *cobra.Command {
	cmd := &cobra.Command{
		Use: "scp <source> ... <target>",
		// "scpv2" is the pre-promotion name this command answered to; kept as
		// an alias so scripts and docs written against it keep working.
		Aliases: []string{"scpv2"},
		Short:   "Copy files to or from sandboxes over SSH",
		Long: `Copy files between the local machine, sandboxes, and SSH hosts using scp,
over the same direct WebSocket transport as "amika sandbox ssh".

Operands take these forms:

  PATH                              a local path
  RIG:[PATH]                        a path in rig RIG (scp-style): a relative
                                    PATH is under the rig home, an absolute
                                    PATH is used verbatim
  rig://RIG[/PATH]                  a path in rig RIG (URI form): PATH is
                                    absolute and "~" is the home directory. A
                                    "/" in RIG must be percent-encoded as %2F.
                                    sbox://RIG[/PATH] is accepted too
  scp://[user@]host[:port][/path]   a path on an arbitrary SSH host

RIG is a name or ID, or name=<name> / id=<id> (see "amika rig --help"), as in
"name=my-sandbox:out.txt". Each rig resolves to its
"<name>.<id>.<environment>.amika" alias, and the connection settings come from
the managed block in ~/.ssh/amika.conf, so a fresh session is created and the
host key re-pinned per dial. Requires an SSH identity from
"amika secret ssh-keygen".

Examples:
  # Upload a file into the sandbox home
  amika scp ./local.txt my-sandbox:local.txt

  # Recursively download an absolute directory from the sandbox
  amika scp -r my-sandbox:/srv/out ./out

  # Print the resolved scp command instead of running it
  amika scp --print ./a.txt my-sandbox:a.txt`,
		Args: cobra.MinimumNArgs(1),
		// Every argument is forwarded to system scp, so
		// scp's own single-dash options pass through untouched.
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSCPV2(cmd, args)
		},
	}
	return cmd
}
