package sandboxcmd

// sandbox_scp.go implements `amika sandbox scp`, a thin wrapper around the
// system scp binary that resolves sandbox references and sandbox/scp URIs to
// concrete SSH destinations before delegating the actual copy to scp.

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"syscall"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

var sandboxSCPCmd = &cobra.Command{
	Use:   "scp <sbox_name> [flags] <source> ... <target>",
	Short: "Copy files to or from a sandbox over SSH",
	Long: `Copy files between the local machine, a sandbox, and SSH hosts using scp.

The first argument names the sandbox this command connects to. Every remaining
argument is forwarded to the system scp binary unchanged, so all the usual scp
flags (-r, -p, -C, -v, ...) work. The only difference is that sources and
targets may be given in any of these forms:

  PATH                               a local path
  <sbox_name>:[PATH]                 a path inside the sandbox (scp-style)
  sbox://<sbox_name>/PATH            a path inside the sandbox (URI form)
  scp://[user@]host[:port][/path]    a path on an arbitrary SSH host

A bare "<sbox_name>:PATH" is treated as a sandbox reference only when its host
matches the sandbox named as the first argument; any other "host:path" is left
for scp to interpret as a normal SSH host.

Examples:
  # Upload a file into the sandbox
  amika sandbox scp my-sandbox ./local.txt my-sandbox:/home/amika/local.txt

  # Recursively download a directory from the sandbox
  amika sandbox scp my-sandbox -r my-sandbox:/home/amika/out ./out

  # Sandbox URI form
  amika sandbox scp my-sandbox ./a.txt sbox://my-sandbox/home/amika/a.txt

  # Copy from the sandbox to another SSH host
  amika sandbox scp my-sandbox my-sandbox:/data.csv scp://user@host:22/tmp/data.csv

  # Print the resolved scp command instead of running it
  amika sandbox scp --print my-sandbox ./a.txt my-sandbox:/home/amika/a.txt`,
	Args:               cobra.MinimumNArgs(1),
	DisableFlagParsing: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runSCP(cmd, args)
	},
}

// destResolver resolves a sandbox name to its concrete SSH destination.
type destResolver func(name string) (ssh.Destination, error)

// scpPlan is the parsed form of a `sandbox scp` invocation: the sandbox the
// command connects to, the residual argv handed to scp (its flags, sources, and
// target, in original order), and whether to print the command instead of
// running it.
type scpPlan struct {
	sandbox   string
	scpArgv   []string
	printOnly bool
}

func runSCP(cmd *cobra.Command, rawArgs []string) error {
	// DisableFlagParsing bypasses cobra's built-in help flag, so handle it here.
	if hasHelpFlag(rawArgs) {
		return cmd.Help()
	}

	plan, err := parseSCPArgs(rawArgs)
	if err != nil {
		return err
	}

	// scp always targets a remote host; the sandbox connection is minted from
	// the remote API, so authentication is required just like `sandbox ssh`.
	if err := runmode.RequireAuth(runmode.Remote, defaultAuthChecker); err != nil {
		return err
	}

	client, err := getRemoteClient("")
	if err != nil {
		return err
	}

	scpArgs, err := buildSCPInvocation(plan, func(name string) (ssh.Destination, error) {
		return resolveSandboxDestination(client, name)
	})
	if err != nil {
		return err
	}

	if plan.printOnly {
		fmt.Fprintln(cmd.OutOrStdout(), formatCommand(append([]string{"scp"}, scpArgs...)))
		return nil
	}

	return execSCP(scpArgs)
}

// parseSCPArgs splits the raw argv into the sandbox name, the residual scp argv,
// and any amika-level control flags. Because scp uses only single-dash options,
// the double-dash control flags below can never collide with a real scp flag.
func parseSCPArgs(rawArgs []string) (scpPlan, error) {
	var plan scpPlan
	var residual []string

	for _, arg := range rawArgs {
		switch {
		case arg == "--print":
			plan.printOnly = true
		case arg == "--local" || arg == "--local=true":
			return scpPlan{}, fmt.Errorf("scp requires a remote sandbox; omit --local")
		case arg == "--local=false", arg == "--remote", strings.HasPrefix(arg, "--remote="):
			// Remote is the only supported mode; accept and ignore these.
		case arg == "--remote-target" || strings.HasPrefix(arg, "--remote-target="):
			return scpPlan{}, fmt.Errorf("--remote-target is not yet supported")
		default:
			residual = append(residual, arg)
		}
	}

	if len(residual) == 0 {
		return scpPlan{}, fmt.Errorf("missing sandbox name; usage: amika sandbox scp <sbox_name> [flags] <source> ... <target>")
	}
	if strings.HasPrefix(residual[0], "-") {
		return scpPlan{}, fmt.Errorf("expected the sandbox name as the first argument, got %q", residual[0])
	}

	plan.sandbox = residual[0]
	plan.scpArgv = residual[1:]
	return plan, nil
}

// buildSCPInvocation rewrites the residual scp argv so sandbox and scp URI
// references become concrete scp destinations, and prepends the connection
// options (port and host-key policy) implied by the resolved sandbox. The
// sandbox destination is resolved lazily so a copy that never references the
// sandbox performs no API call.
func buildSCPInvocation(plan scpPlan, resolve destResolver) ([]string, error) {
	var (
		dest         ssh.Destination
		destResolved bool
	)
	getDest := func() (ssh.Destination, error) {
		if !destResolved {
			d, err := resolve(plan.sandbox)
			if err != nil {
				return ssh.Destination{}, err
			}
			dest = d
			destResolved = true
		}
		return dest, nil
	}

	userSetPort, userSetStrict := scanUserOptions(plan.scpArgv)

	rewritten := make([]string, 0, len(plan.scpArgv))
	ports := map[int]bool{}
	sandboxUsed := false
	remoteUsed := false

	for _, tok := range plan.scpArgv {
		switch {
		case strings.HasPrefix(tok, "sbox://"):
			name, path, err := parseSboxURI(tok)
			if err != nil {
				return nil, err
			}
			if name != plan.sandbox {
				return nil, fmt.Errorf("sandbox URI %q refers to sandbox %q, but this command connects to %q", tok, name, plan.sandbox)
			}
			d, err := getDest()
			if err != nil {
				return nil, err
			}
			rewritten = append(rewritten, remoteSpec(d, path))
			sandboxUsed, remoteUsed = true, true
			if d.Port != 0 {
				ports[d.Port] = true
			}

		case strings.HasPrefix(tok, "scp://"):
			spec, port, err := parseSCPURI(tok)
			if err != nil {
				return nil, err
			}
			rewritten = append(rewritten, spec)
			remoteUsed = true
			if port != 0 {
				ports[port] = true
			}

		case isSandboxRef(tok, plan.sandbox):
			d, err := getDest()
			if err != nil {
				return nil, err
			}
			path := tok[len(plan.sandbox)+1:]
			rewritten = append(rewritten, remoteSpec(d, path))
			sandboxUsed, remoteUsed = true, true
			if d.Port != 0 {
				ports[d.Port] = true
			}

		default:
			// A native "host:path" (not the sandbox) is a remote scp already
			// understands; pass it through but count it so the guard below only
			// trips when every source and target is local.
			if looksLikeRemote(tok) {
				remoteUsed = true
			}
			rewritten = append(rewritten, tok)
		}
	}

	if !remoteUsed {
		return nil, fmt.Errorf("no remote source or target found; reference the sandbox as %s:PATH or sbox://%s/PATH, or use an scp:// URI", plan.sandbox, plan.sandbox)
	}

	opts, err := scpConnectionOptions(sandboxUsed, userSetStrict, userSetPort, ports)
	if err != nil {
		return nil, err
	}
	return append(opts, rewritten...), nil
}

// scpConnectionOptions builds the scp options implied by the resolved remotes:
// an accept-new host-key policy for sandbox connections and a single -P port.
// scp's getopt stops at the first non-option argument, so these must be
// prepended ahead of the sources and target.
func scpConnectionOptions(sandboxUsed, userSetStrict, userSetPort bool, ports map[int]bool) ([]string, error) {
	var opts []string
	if sandboxUsed && !userSetStrict {
		opts = append(opts, "-o", "StrictHostKeyChecking=accept-new")
	}
	if !userSetPort {
		distinct := make([]int, 0, len(ports))
		for p := range ports {
			distinct = append(distinct, p)
		}
		sort.Ints(distinct)
		if len(distinct) > 1 {
			return nil, fmt.Errorf("cannot copy between remotes on different ports %v; scp uses a single port per invocation", distinct)
		}
		if len(distinct) == 1 {
			opts = append(opts, "-P", strconv.Itoa(distinct[0]))
		}
	}
	return opts, nil
}

// scanUserOptions reports whether the argv already sets an explicit port (-P) or
// StrictHostKeyChecking, so the defaults injected for a sandbox do not override
// a user's explicit choice.
func scanUserOptions(argv []string) (userSetPort, userSetStrict bool) {
	for _, tok := range argv {
		if tok == "-P" || strings.HasPrefix(tok, "-P") {
			userSetPort = true
		}
		if strings.Contains(tok, "StrictHostKeyChecking") {
			userSetStrict = true
		}
	}
	return userSetPort, userSetStrict
}

// isSandboxRef reports whether tok is a bare scp-style reference to the named
// sandbox, i.e. "<sandbox>:...". Any other "host:path" is left for scp.
func isSandboxRef(tok, sandbox string) bool {
	return strings.HasPrefix(tok, sandbox+":")
}

// looksLikeRemote applies scp's own heuristic for a remote target: a colon that
// appears before any slash marks a "host:path" spec. Local paths (which have no
// such colon) and flags return false.
func looksLikeRemote(tok string) bool {
	if strings.HasPrefix(tok, "-") {
		return false
	}
	colon := strings.Index(tok, ":")
	if colon < 0 {
		return false
	}
	slash := strings.Index(tok, "/")
	return slash < 0 || colon < slash
}

// remoteSpec renders an scp destination "[user@]host:path" from a resolved SSH
// destination. The port travels via a separate -P option, not the spec.
func remoteSpec(d ssh.Destination, path string) string {
	host := d.Host
	if d.User != "" {
		host = d.User + "@" + host
	}
	return host + ":" + path
}

// parseSboxURI parses a "sbox://<name>/<path>" URI into the sandbox name and the
// remote path.
func parseSboxURI(raw string) (name, path string, err error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", fmt.Errorf("invalid sandbox URI %q: %w", raw, err)
	}
	if u.Host == "" {
		return "", "", fmt.Errorf("sandbox URI %q is missing a sandbox name (expected sbox://NAME/PATH)", raw)
	}
	return u.Host, u.Path, nil
}

// parseSCPURI parses an "scp://[user@]host[:port][/path]" URI into an scp
// destination spec and, if present, the port.
func parseSCPURI(raw string) (spec string, port int, err error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", 0, fmt.Errorf("invalid scp URI %q: %w", raw, err)
	}
	host := u.Hostname()
	if host == "" {
		return "", 0, fmt.Errorf("scp URI %q is missing a host", raw)
	}
	if u.User != nil {
		if name := u.User.Username(); name != "" {
			host = name + "@" + host
		}
	}
	if p := u.Port(); p != "" {
		port, err = strconv.Atoi(p)
		if err != nil {
			return "", 0, fmt.Errorf("invalid port in scp URI %q: %w", raw, err)
		}
	}
	return host + ":" + u.Path, port, nil
}

// resolveSandboxDestination fetches fresh SSH connection details for a sandbox
// and parses them into a destination.
func resolveSandboxDestination(client *apiclient.Client, name string) (ssh.Destination, error) {
	info, err := client.GetSSH(name)
	if err != nil {
		return ssh.Destination{}, err
	}
	if info.SSHDestination == "" {
		return ssh.Destination{}, fmt.Errorf("server returned empty SSH destination for sandbox %q", name)
	}
	return ssh.ParseDestination(info.SSHDestination)
}

// execSCP replaces the current process with the system scp binary.
func execSCP(args []string) error {
	scpBin, err := exec.LookPath("scp")
	if err != nil {
		return fmt.Errorf("scp not found: %w", err)
	}
	return syscall.Exec(scpBin, append([]string{"scp"}, args...), os.Environ())
}

// hasHelpFlag reports whether the raw args request help.
func hasHelpFlag(args []string) bool {
	for _, a := range args {
		if a == "-h" || a == "--help" {
			return true
		}
	}
	return false
}

// formatCommand renders a command line for display, quoting arguments that
// contain shell-significant characters.
func formatCommand(args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = quoteArg(a)
	}
	return strings.Join(quoted, " ")
}

func quoteArg(s string) string {
	if s == "" {
		return "''"
	}
	const safe = "@%_-+=:,./"
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(safe, r) {
			continue
		}
		return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
	}
	return s
}
