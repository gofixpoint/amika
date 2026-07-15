package sandboxcmd

// sandbox_scp.go implements `amika sandbox scp`, a thin wrapper around the
// system scp binary that resolves sandbox references and sandbox/scp URIs to
// concrete SSH destinations before delegating the actual copy to scp.

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
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
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
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

	userSetPort, userSetStrict, userJumpHost := scanUserOptions(plan.scpArgv)

	rewritten := make([]string, 0, len(plan.scpArgv))
	usage := remoteUsage{jumpHost: userJumpHost}
	var sandboxOpts []string // ssh options carried by the sandbox destination

	optionsEnded := false
	for i := 0; i < len(plan.scpArgv); i++ {
		tok := plan.scpArgv[i]

		// scp uses OpenBSD getopt: option parsing stops at the first operand (or
		// an explicit "--"), after which every token — even a dash-prefixed one —
		// is a file operand, not an option. Until then, forward scp's options
		// (and their arguments) untouched; an option that takes its argument in
		// the following token (e.g. "-J bastion:22", "-o ProxyCommand=...",
		// "-i key") passes both tokens through, since the argument may use
		// "host:port" syntax that must not be mistaken for a copy endpoint.
		if !optionsEnded {
			if tok == "--" {
				optionsEnded = true
				rewritten = append(rewritten, tok)
				continue
			}
			if len(tok) >= 2 && tok[0] == '-' {
				if consumesNextArg(tok) && i+1 < len(plan.scpArgv) {
					rewritten = append(rewritten, tok, plan.scpArgv[i+1])
					i++
				} else {
					rewritten = append(rewritten, tok)
				}
				continue
			}
			optionsEnded = true
		}

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
			usage.sandbox = true
			usage.sandboxPort = d.Port
			sandboxOpts = d.Options

		case strings.HasPrefix(tok, "scp://"):
			operand, hasPort, err := parseSCPURI(tok)
			if err != nil {
				return nil, err
			}
			rewritten = append(rewritten, operand)
			usage.external = true
			// A URI with an explicit port is self-porting (scp reads the port
			// from the operand and ignores -P for that host), so it never needs
			// the global -P. A portless URI, like a native "host:path", takes its
			// port from -P or the user's SSH config, so the global -P applies.
			if !hasPort {
				usage.portDependentExternal = true
			}

		case isSandboxRef(tok, plan.sandbox):
			d, err := getDest()
			if err != nil {
				return nil, err
			}
			path := tok[len(plan.sandbox)+1:]
			rewritten = append(rewritten, remoteSpec(d, path))
			usage.sandbox = true
			usage.sandboxPort = d.Port
			sandboxOpts = d.Options

		default:
			// A native "host:path" (not the sandbox) is a remote scp already
			// understands; pass it through but count it so the guard below only
			// trips when every source and target is local. Its port is unknown
			// (it may come from the user's SSH config), so a global -P would
			// apply to it.
			if looksLikeRemote(tok) {
				usage.external = true
				usage.portDependentExternal = true
			}
			rewritten = append(rewritten, tok)
		}
	}

	if !usage.sandbox && !usage.external {
		return nil, fmt.Errorf("no remote source or target found; reference the sandbox as %s:PATH or sbox://%s/PATH, or use an scp:// URI", plan.sandbox, plan.sandbox)
	}

	// The resolved sandbox destination may itself carry ssh options set by the
	// server. Fold any host-key policy or jump host it names into the same
	// decision as the user's flags (both are forwarded verbatim below): otherwise
	// the injected accept-new — prepended ahead of them, and ssh honors the first
	// value of a keyword — would override a stricter server policy or silently
	// relax a server-supplied jump host to trust-on-first-use. Ports are not
	// folded: ParseDestination extracts them into d.Port, and a stray -P in the
	// options is rejected by firstNonSCPOption below.
	if len(sandboxOpts) > 0 {
		_, destStrict, destJump := scanUserOptions(sandboxOpts)
		userSetStrict = userSetStrict || destStrict
		usage.jumpHost = usage.jumpHost || destJump
	}

	opts, err := scpConnectionOptions(usage, userSetStrict, userSetPort)
	if err != nil {
		return nil, err
	}

	// The sandbox's own ssh options (e.g. -i, -F, -o ProxyCommand) apply to the
	// whole scp invocation, so they can be forwarded only when the sandbox is the
	// sole remote. In a mixed copy they would also hit the external host, so the
	// copy is rejected rather than misrouting it.
	if len(sandboxOpts) > 0 {
		// scp and ssh share many option letters but not their meanings (ssh's
		// -P is a connection tag, scp's is a port; -W/-L/-R/-D have no scp
		// equivalent). Forwarding such an option would fail or, worse, be
		// silently reinterpreted, so reject it rather than misapply it.
		if bad, ok := firstNonSCPOption(sandboxOpts); ok {
			return nil, fmt.Errorf("the connection to sandbox %q needs ssh option %q, which scp does not support (or interprets differently); connect with `amika sandbox ssh` instead, or copy via an intermediate host", plan.sandbox, bad)
		}
		if usage.external {
			return nil, fmt.Errorf("the connection to sandbox %q requires ssh options %v, which scp applies to the whole copy and cannot scope to the sandbox when an external host is also involved; copy to or from the sandbox in a separate command", plan.sandbox, sandboxOpts)
		}
		opts = append(opts, sandboxOpts...)
	}

	return append(opts, rewritten...), nil
}

// remoteUsage summarizes the remotes referenced by an scp argv: whether the
// sandbox and/or an external SSH host appears, the sandbox's port, and whether
// any external remote depends on the global -P for its port.
//
// scp carries per-endpoint ports two ways: an operand's own "scp://host:PORT/..."
// URI (self-porting, overrides -P for that host) or a single global -P that
// applies to every operand without a URI port. External remotes are emitted so
// they self-port whenever they name a port, so the only remote left needing the
// global -P is the sandbox (rendered as "host:path"). portDependentExternal
// flags an external remote — a native "host:path" or a portless scp:// URI —
// that would be swept up by a -P injected for the sandbox.
type remoteUsage struct {
	sandbox               bool // any sandbox reference
	external              bool // any non-sandbox remote (scp:// URI or native host:path)
	sandboxPort           int  // the sandbox's port (0 = implicit, i.e. scp's default 22)
	portDependentExternal bool // an external remote whose port a global -P would apply to
	jumpHost              bool // a jump host (-J / -o ProxyJump) is in play
}

// scpConnectionOptions builds the scp options implied by the resolved remotes:
// an accept-new host-key policy for sandbox connections and a single -P port for
// the sandbox. scp's getopt stops at the first non-option argument, so these
// must be prepended ahead of the sources and target.
//
// Both options are global to the whole scp invocation, so each is emitted only
// when it cannot mis-apply to another remote:
//
//   - The relaxed host-key policy is injected only when the sandbox is the sole
//     remote; an external host — or a jump host (-J / -o ProxyJump), which scp's
//     global -o would also relax to trust-on-first-use — keeps the user's normal
//     SSH config.
//   - -P carries the sandbox's port. External remotes that name a port already
//     self-port via their scp:// URI (overriding -P for that host), so -P only
//     serves the sandbox. It is rejected, rather than forced, when a
//     port-dependent external remote (a native "host:path" or portless scp://
//     URI) would be swept onto the sandbox's port; that remote should name its
//     port with an scp://host:PORT/path URI or be copied separately. A sandbox
//     port that is scp's default 22 (whether implicit or stated explicitly)
//     needs no -P at all.
func scpConnectionOptions(usage remoteUsage, userSetStrict, userSetPort bool) ([]string, error) {
	var opts []string
	if usage.sandbox && !usage.external && !usage.jumpHost && !userSetStrict {
		opts = append(opts, "-o", "StrictHostKeyChecking=accept-new")
	}
	// Port 22 is scp's default, so an explicit :22 needs no -P — and injecting
	// one would needlessly trip the mixed-port guard against a port-dependent
	// external remote that also resolves to the default 22.
	if !userSetPort && usage.sandboxPort != 0 && usage.sandboxPort != 22 {
		if usage.portDependentExternal {
			return nil, fmt.Errorf("cannot copy between the sandbox on port %d and a remote whose port is unspecified: scp would apply a single -P to both. Give the other remote an explicit port with an scp://host:PORT/path URI, or copy to or from the sandbox in a separate command", usage.sandboxPort)
		}
		opts = append(opts, "-P", strconv.Itoa(usage.sandboxPort))
	}
	return opts, nil
}

// scanUserOptions reports whether the argv already sets an explicit port or
// StrictHostKeyChecking (so the defaults injected for a sandbox do not override
// a user's explicit choice), and whether it routes through a jump host (-J or
// -o ProxyJump), whose host key scp's global host-key policy would otherwise
// also relax. It matches the flags precisely so an operand that merely contains
// the text "StrictHostKeyChecking" (e.g. a file path) or a "P" does not trip it,
// and — mirroring scp's OpenBSD getopt — stops at the first operand (or a "--"),
// so a dash-prefixed file operand is not read as an option.
func scanUserOptions(argv []string) (userSetPort, userSetStrict, userJumpHost bool) {
	for i := 0; i < len(argv); i++ {
		tok := argv[i]
		// Option parsing stops at "--" or the first operand; scp treats every
		// later token as a file operand even if it begins with "-".
		if tok == "--" || len(tok) < 2 || tok[0] != '-' {
			break
		}

		// ssh_config-style option, as "-o KEY=VAL" or "-oKEY=VAL". OpenSSH also
		// accepts the "KEY VAL" form (e.g. -o "Port 2222"), so split the key on
		// the first '=' or whitespace.
		if optVal := oOptionValue(tok, argv, i); optVal != "" {
			key := optVal
			if sep := strings.IndexAny(key, "= \t"); sep >= 0 {
				key = key[:sep]
			}
			switch {
			case strings.EqualFold(key, "StrictHostKeyChecking"):
				userSetStrict = true
			case strings.EqualFold(key, "Port"):
				userSetPort = true
			case strings.EqualFold(key, "ProxyJump"):
				userJumpHost = true
			}
			if tok == "-o" {
				i++ // the value lived in the following token
			}
			continue
		}

		// Walk the option-letter cluster left to right looking for -P (port,
		// uppercase; lowercase -p is preserve) and -J (jump host). The first
		// arg-taking letter consumes the rest of the token as its attached value
		// (e.g. "-rP2222", "-Jbastion", "-i/home/me/Projects/key"), so stop there:
		// letters past it are a value, not options, and must not be scanned — a
		// capital P or J in an identity path is not the port or jump-host flag.
		for _, c := range tok[1:] {
			if c == 'P' {
				userSetPort = true
			} else if c == 'J' {
				userJumpHost = true
			}
			if strings.ContainsRune(scpArgOptions, c) {
				break // c takes the token's remainder (or the next token) as its value
			}
		}

		// Skip an option's argument in the following token so it is not read as
		// the first operand (which would end option scanning prematurely).
		if consumesNextArg(tok) && i+1 < len(argv) {
			i++
		}
	}
	return userSetPort, userSetStrict, userJumpHost
}

// oOptionValue returns the value of an "-o" ssh option written as either
// "-o VALUE" (value in the next token) or "-oVALUE" (value attached), or "" if
// tok is not an "-o" option.
func oOptionValue(tok string, argv []string, i int) string {
	if tok == "-o" {
		if i+1 < len(argv) {
			return argv[i+1]
		}
		return ""
	}
	if strings.HasPrefix(tok, "-o") {
		return tok[len("-o"):]
	}
	return ""
}

// scpArgOptions are scp's single-letter flags that take an argument (from
// scp(1)). The argument may itself use "host:port" syntax (notably -J, the jump
// host), so it must be skipped when scanning argv for copy endpoints.
const scpArgOptions = "cDFiJloPSX"

// consumesNextArg reports whether an scp option token takes the following argv
// token as its argument (rather than an attached value). It mirrors getopt: in a
// bundled cluster such as "-rP" only the first argument-taking letter takes a
// value, and it takes the following token only when nothing is attached after it
// ("-o" takes the next token; "-oVALUE" and "-rP2222" carry the value inline).
func consumesNextArg(tok string) bool {
	if len(tok) < 2 || tok[0] != '-' || tok[1] == '-' {
		return false // an operand, "-", or "--" end-of-options marker
	}
	for i := 1; i < len(tok); i++ {
		if strings.IndexByte(scpArgOptions, tok[i]) >= 0 {
			return i == len(tok)-1
		}
	}
	return false
}

// ssh option letters whose meaning is identical in scp, so a preserved sandbox
// ssh option carrying one may be forwarded to scp unchanged: the arg-taking
// -c cipher, -F config, -i identity, -J jump host, -o ssh_option, and the
// booleans -4/-6/-A/-C/-q/-v. Notably absent are letters scp reuses for a
// different meaning (ssh -P is a connection tag vs scp's port; ssh -D/-S differ)
// or does not define at all (-W, -L, -R, ...). -p and -l never appear here since
// ParseDestination extracts them into Port and User.
const (
	scpSafeArgOptionLetters  = "cFiJo"
	scpSafeBoolOptionLetters = "46ACqv"
)

// firstNonSCPOption returns the first ssh option token in opts whose flag letter
// scp cannot accept unchanged, and true, or ("", false) if all are safe. opts is
// a flat "[flag, arg, flag, ...]" list as ParseDestination preserves it, so a
// safe option's separate argument token is skipped rather than inspected as a
// flag. Bundled option clusters are not expected in a server-minted destination,
// so only the leading flag letter of each token is examined.
func firstNonSCPOption(opts []string) (string, bool) {
	for i := 0; i < len(opts); i++ {
		tok := opts[i]
		if len(tok) < 2 || tok[0] != '-' {
			continue // an option argument
		}
		letter := rune(tok[1])
		switch {
		case strings.ContainsRune(scpSafeArgOptionLetters, letter):
			if len(tok) == 2 {
				i++ // value is in the following token
			}
		case strings.ContainsRune(scpSafeBoolOptionLetters, letter):
			// boolean; no argument to skip
		default:
			return tok, true
		}
	}
	return "", false
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

// splitURIPath splits a "scheme://authority/path" string into its parsed
// authority (for user/host/port) and the decoded remote path. The path is taken
// verbatim from the first "/" onward and percent-decoded here, rather than read
// from url.Parse's u.Path: url.Parse would split a "?" or "#" in the path into a
// query or fragment and drop it, silently truncating a remote file name that
// contains one. Only the authority (which has neither) is handed to url.Parse.
func splitURIPath(raw, scheme string) (auth *url.URL, path string, err error) {
	rest := strings.TrimPrefix(raw, scheme+"://")
	authority, rawPath := rest, ""
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		authority, rawPath = rest[:i], rest[i:]
	}
	auth, err = url.Parse(scheme + "://" + authority)
	if err != nil {
		return nil, "", err
	}
	path, err = url.PathUnescape(rawPath)
	if err != nil {
		return nil, "", err
	}
	return auth, path, nil
}

// parseSboxURI parses a "sbox://<name>/<path>" URI into the sandbox name and the
// remote path.
func parseSboxURI(raw string) (name, path string, err error) {
	u, path, err := splitURIPath(raw, "sbox")
	if err != nil {
		return "", "", fmt.Errorf("invalid sandbox URI %q: %w", raw, err)
	}
	if u.Hostname() == "" {
		return "", "", fmt.Errorf("sandbox URI %q is missing a sandbox name (expected sbox://NAME/PATH)", raw)
	}
	if u.Port() != "" {
		return "", "", fmt.Errorf("sandbox URI %q must not contain a port (expected sbox://NAME/PATH)", raw)
	}
	return u.Hostname(), path, nil
}

// parseSCPURI parses an "scp://[user@]host[:port][/path]" URI into an scp
// operand and reports whether the URI named an explicit port.
//
// A URI without a port becomes the plain "[user@]host:path" scp already
// understands, taking its port from -P or the user's SSH config. A URI with a
// port is emitted as a self-porting "scp://[user@]host:port//path" URI so scp
// connects that host on the named port regardless of -P or SSH config. The path
// is doubled behind the authority ("//path") because scp strips one leading
// slash from a URI path; this preserves the absolute path the plain form conveys.
// The path is re-escaped (not left decoded) so scp decodes it back to the same
// path — a literal "%" survives as "%25", and "@" is encoded so scp's URI parser
// does not read the path as userinfo.
func parseSCPURI(raw string) (operand string, hasPort bool, err error) {
	u, path, err := splitURIPath(raw, "scp")
	if err != nil {
		return "", false, fmt.Errorf("invalid scp URI %q: %w", raw, err)
	}
	host := u.Hostname()
	if host == "" {
		return "", false, fmt.Errorf("scp URI %q is missing a host", raw)
	}
	// url.Hostname strips the brackets Go requires around an IPv6 literal. scp
	// needs them back in both output forms so a bare "::1" is not misread as a
	// "host:port" (the portless "host:path") or left as an unbracketed URI host.
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if u.User != nil {
		if name := u.User.Username(); name != "" {
			host = name + "@" + host
		}
	}
	if p := u.Port(); p != "" {
		port, err := strconv.Atoi(p)
		if err != nil {
			return "", false, fmt.Errorf("invalid port in scp URI %q: %w", raw, err)
		}
		escPath := strings.ReplaceAll((&url.URL{Path: path}).EscapedPath(), "@", "%40")
		return fmt.Sprintf("scp://%s:%d/%s", host, port, escPath), true, nil
	}
	return host + ":" + path, false, nil
}

// resolveSandboxDestination fetches fresh SSH connection details for a sandbox
// and parses them into a destination. ParseDestination preserves any ssh options
// the server includes (beyond user/host/port) in Destination.Options so the
// caller can forward them to scp; see buildSCPInvocation for how they are scoped.
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

// hasHelpFlag reports whether the raw args request help. Only a leading
// "-h"/"--help" counts: once the first operand (the sandbox name) or a "--"
// appears, scp treats later tokens as file operands, so a copy source literally
// named "-h" is not mistaken for a help request.
func hasHelpFlag(args []string) bool {
	for _, a := range args {
		if len(a) == 0 || a[0] != '-' || a == "--" {
			break // first operand or end-of-options marker; options end here
		}
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
