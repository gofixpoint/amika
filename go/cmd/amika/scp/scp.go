package scpcmd

// scp.go implements `amika scp`. It resolves sandbox references (a bare
// "NAME:PATH" or an "sbox://NAME/PATH" URI) and "scp://" URIs to concrete scp
// destinations, prepends the connection options implied by the resolved
// sandboxes, and hands the rewritten argv to the system scp binary.

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

// sandboxHome is the login user's home directory inside every sandbox. A
// relative sandbox path, a bare "~", or a leading "~/" resolves against it.
const sandboxHome = "/home/amika"

// destResolver resolves a sandbox name to its concrete SSH destination.
type destResolver func(name string) (ssh.Destination, error)

// scpPlan is the parsed form of an `amika scp` invocation: the residual argv
// handed to scp (its flags, sources, and target in original order) and whether
// to print the command instead of running it.
type scpPlan struct {
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

	// The remote API mints the sandbox connection, so authentication is required
	// the first time a sandbox is resolved. A copy that references only scp://
	// hosts performs no API call and needs no auth.
	var client *apiclient.Client
	resolve := func(name string) (ssh.Destination, error) {
		if client == nil {
			if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
				return ssh.Destination{}, err
			}
			client = runmode.NewRemoteClient()
		}
		return resolveSandboxDestination(client, name)
	}

	// A local<->sandbox copy is streamed over an ssh exec channel rather than run
	// through scp: Daytona's linux-vm SSH gateway does not deliver channel-EOF to
	// a non-interactive remote, so scp (and sftp) hang after the transfer
	// completes. See stream.go. Every other shape keeps the scp path below.
	sp, stream, err := planStreamTransfer(plan)
	if err != nil {
		return err
	}
	if stream {
		return runStreamTransfer(cmd, sp, resolve, plan.printOnly)
	}

	scpArgs, err := buildSCPInvocation(plan, resolve)
	if err != nil {
		return err
	}

	if plan.printOnly {
		fmt.Fprintln(cmd.OutOrStdout(), formatCommand(append([]string{"scp"}, scpArgs...)))
		return nil
	}

	return execSCP(scpArgs)
}

// parseSCPArgs splits the raw argv into the residual scp argv and the amika-level
// --print flag. Because scp uses only single-dash options, the double-dash
// --print can never collide with a real scp flag.
func parseSCPArgs(rawArgs []string) (scpPlan, error) {
	var plan scpPlan
	for _, arg := range rawArgs {
		if arg == "--print" {
			plan.printOnly = true
			continue
		}
		plan.scpArgv = append(plan.scpArgv, arg)
	}
	if len(plan.scpArgv) == 0 {
		return scpPlan{}, fmt.Errorf("missing operands; usage: amika scp <source> ... <target>")
	}
	return plan, nil
}

// buildSCPInvocation rewrites the residual scp argv so sandbox references and
// scp URIs become concrete scp destinations, and prepends the connection options
// (host-key policy and any forwarded sandbox ssh options) implied by the
// resolved sandboxes. Sandbox destinations are resolved lazily and cached by
// name, so each distinct sandbox is fetched from the API at most once and a copy
// that references no sandbox performs no API call.
func buildSCPInvocation(plan scpPlan, resolve destResolver) ([]string, error) {
	userSetStrict, userJumpHost := scanUserOptions(plan.scpArgv)

	destCache := map[string]ssh.Destination{}
	getDest := func(name string) (ssh.Destination, error) {
		if d, ok := destCache[name]; ok {
			return d, nil
		}
		d, err := resolve(name)
		if err != nil {
			return ssh.Destination{}, err
		}
		destCache[name] = d
		return d, nil
	}

	rewritten := make([]string, 0, len(plan.scpArgv))
	sandboxNames := map[string]bool{} // distinct sandbox names referenced
	externalPresent := false          // any scp:// (non-sandbox) remote

	optionsEnded := false
	for i := 0; i < len(plan.scpArgv); i++ {
		tok := plan.scpArgv[i]

		// scp uses OpenBSD getopt: option parsing stops at the first operand (or
		// an explicit "--"), after which every token — even a dash-prefixed one —
		// is a file operand. Until then, forward scp's options (and their
		// arguments) untouched; an option that takes its argument in the following
		// token (e.g. "-J bastion:22", "-o ProxyCommand=...", "-i key") passes both
		// tokens through, since the argument may use "host:port" syntax that must
		// not be mistaken for a copy endpoint.
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
			d, err := getDest(name)
			if err != nil {
				return nil, err
			}
			rewritten = append(rewritten, renderSandboxOperand(d, resolveSandboxURIPath(path)))
			sandboxNames[name] = true

		case strings.HasPrefix(tok, "scp://"):
			operand, err := parseSCPURI(tok)
			if err != nil {
				return nil, err
			}
			rewritten = append(rewritten, operand)
			externalPresent = true

		case looksLikeRemote(tok):
			// A bare "host:path" always names a sandbox (an arbitrary SSH host must
			// use an scp:// URI); ':' is banned from sandbox names, so the first
			// colon is the name/path separator.
			name, path := splitSandboxRef(tok)
			d, err := getDest(name)
			if err != nil {
				return nil, err
			}
			rewritten = append(rewritten, renderSandboxOperand(d, resolveSandboxScpPath(path)))
			sandboxNames[name] = true

		default:
			// A local path. Passed through so scp reads it from/writes it to the
			// local filesystem.
			rewritten = append(rewritten, tok)
		}
	}

	if len(sandboxNames) == 0 && !externalPresent {
		return nil, fmt.Errorf("no remote source or target found; reference a sandbox as NAME:PATH or sbox://NAME/PATH, or an SSH host as scp://[user@]host[:port]/path")
	}

	// The resolved sandbox destinations may themselves carry ssh options set by
	// the server. Fold any host-key policy or jump host they name into the same
	// decision as the user's flags: scp's -o options are global, so the injected
	// accept-new must not override a stricter server policy or silently relax a
	// server-supplied jump host to trust-on-first-use.
	strictSet, jumpHost := userSetStrict, userJumpHost
	for name := range sandboxNames {
		ds, dj := scanUserOptions(destCache[name].Options)
		strictSet = strictSet || ds
		jumpHost = jumpHost || dj
	}

	var opts []string
	// Transfer to a sandbox over a plain ssh exec channel (the legacy SCP
	// protocol, -O) rather than the SFTP subsystem. Modern scp defaults to SFTP,
	// whose session teardown can hang against a sandbox's SSH gateway — the copy
	// finishes but scp never exits. -O runs `scp -t` on the far side over an exec
	// channel, the same kind `amika sandbox ssh` uses, which tears down cleanly.
	// -O is global, so it is injected whenever any remote is a sandbox; an
	// external-only copy keeps the modern SFTP protocol.
	if len(sandboxNames) > 0 {
		opts = append(opts, "-O")
	}
	// Relax host-key checking for first contact only when every remote is a
	// sandbox: sandboxes are ephemeral, so their keys are unknown on first
	// connect (accept-new still rejects a changed key). scp's -o is global, so an
	// external host or a jump host — which keep the user's ssh config — suppresses
	// it, as does a policy the user or server already set.
	if !externalPresent && !jumpHost && !strictSet {
		opts = append(opts, "-o", "StrictHostKeyChecking=accept-new")
	}

	// A sandbox destination's own ssh options (e.g. -i, -F, -o ProxyCommand) are
	// global to the scp invocation, so they can be forwarded only when a single
	// sandbox is the sole remote. With multiple sandboxes or an external host they
	// would also hit the other endpoints, so reject rather than misroute.
	for name := range sandboxNames {
		d := destCache[name]
		if len(d.Options) == 0 {
			continue
		}
		// scp and ssh share many option letters but not their meanings (ssh's -P
		// is a connection tag, scp's is a port; -W/-L/-R/-D have no scp equivalent).
		// Forwarding such an option would fail or be silently reinterpreted.
		if bad, ok := firstNonSCPOption(d.Options); ok {
			return nil, fmt.Errorf("the connection to sandbox %q needs ssh option %q, which scp does not support (or interprets differently); connect with `amika sandbox ssh` instead", name, bad)
		}
		if len(sandboxNames) > 1 || externalPresent {
			return nil, fmt.Errorf("the connection to sandbox %q requires ssh options %v, which scp applies to the whole copy and cannot scope when another remote is involved; copy to or from that sandbox in a separate command", name, d.Options)
		}
		opts = append(opts, d.Options...)
	}

	return append(opts, rewritten...), nil
}

// renderSandboxOperand renders a resolved sandbox destination and an absolute
// remote path as an scp operand. A non-default port is carried inline as a
// self-porting "scp://host:port//path" URI, so no global -P is needed (which
// could not serve two sandboxes on differing ports); scp strips one leading
// slash from a URI path, hence the doubled slash, and "@" is escaped so the path
// is not read as userinfo. The default port uses the plain "[user@]host:path".
func renderSandboxOperand(d ssh.Destination, absPath string) string {
	host := d.Host
	if strings.Contains(host, ":") {
		host = "[" + host + "]" // bracket an IPv6 literal
	}
	if d.User != "" {
		host = d.User + "@" + host
	}
	if d.Port != 0 && d.Port != 22 {
		escPath := strings.ReplaceAll((&url.URL{Path: absPath}).EscapedPath(), "@", "%40")
		return fmt.Sprintf("scp://%s:%d/%s", host, d.Port, escPath)
	}
	return host + ":" + absPath
}

// resolveSandboxScpPath resolves the path of a bare "NAME:PATH" reference to an
// absolute sandbox path: a relative path is taken under the sandbox home, an
// absolute path is used verbatim, a leading "~" expands to home, and an empty
// path means the home directory.
func resolveSandboxScpPath(path string) string {
	switch {
	case path == "", path == "~":
		return sandboxHome
	case strings.HasPrefix(path, "~/"):
		return sandboxHome + path[1:]
	case strings.HasPrefix(path, "/"):
		return path
	default:
		return sandboxHome + "/" + path
	}
}

// resolveSandboxURIPath resolves the path of an "sbox://NAME/PATH" reference,
// where parseSboxURI returns the path with its leading "/". Every path is
// absolute; a leading "~" expands to the sandbox home, and an empty path (or a
// bare "~") means the home directory.
func resolveSandboxURIPath(path string) string {
	switch {
	case path == "", path == "/~":
		return sandboxHome
	case strings.HasPrefix(path, "/~/"):
		return sandboxHome + path[2:]
	default:
		return path
	}
}

// splitSandboxRef splits a bare "NAME:PATH" reference at its first colon. It is
// only called for tokens looksLikeRemote already accepted, so a colon is present.
func splitSandboxRef(tok string) (name, path string) {
	i := strings.IndexByte(tok, ':')
	return tok[:i], tok[i+1:]
}

// parseSboxURI parses an "sbox://NAME[/PATH]" URI into the sandbox name and the
// remote path (with its leading "/"). The name is percent-decoded — a name may
// contain "/", which must be encoded as %2F so it does not begin the path — and
// url.Parse rejects a percent-encoded host, so the authority is split off and
// decoded directly rather than via url.Parse.
func parseSboxURI(raw string) (name, path string, err error) {
	rest := strings.TrimPrefix(raw, "sbox://")
	auth, rawPath := rest, ""
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		auth, rawPath = rest[:i], rest[i:]
	}
	if auth == "" {
		return "", "", fmt.Errorf("sandbox URI %q is missing a sandbox name (expected sbox://NAME/PATH)", raw)
	}
	name, err = url.PathUnescape(auth)
	if err != nil {
		return "", "", fmt.Errorf("invalid percent-encoding in sandbox URI %q: %w", raw, err)
	}
	if strings.ContainsAny(name, ": ") {
		return "", "", fmt.Errorf("sandbox URI %q decodes to an invalid sandbox name %q: ':' and spaces are not allowed", raw, name)
	}
	path, err = url.PathUnescape(rawPath)
	if err != nil {
		return "", "", fmt.Errorf("invalid percent-encoding in the path of sandbox URI %q: %w", raw, err)
	}
	return name, path, nil
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

// parseSCPURI parses an "scp://[user@]host[:port][/path]" URI into an scp
// operand. A URI with a port becomes a self-porting "scp://[user@]host:port//path"
// operand so scp connects that host on the named port; a portless URI becomes
// the plain "[user@]host:path" scp already understands. A password
// ("user:pass@") is rejected: scp cannot use one non-interactively. The path is
// re-escaped so scp decodes it back to the same path (a literal "%" survives as
// "%25", and "@" is encoded so scp's URI parser does not read it as userinfo).
func parseSCPURI(raw string) (operand string, err error) {
	u, path, err := splitURIPath(raw, "scp")
	if err != nil {
		return "", fmt.Errorf("invalid scp URI %q: %w", raw, err)
	}
	if u.User != nil {
		if _, hasPassword := u.User.Password(); hasPassword {
			return "", fmt.Errorf("scp URI %q includes a password, which scp cannot use non-interactively; use key-based auth or your ssh config", raw)
		}
	}
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("scp URI %q is missing a host", raw)
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]" // bracket an IPv6 literal
	}
	if u.User != nil {
		if name := u.User.Username(); name != "" {
			host = name + "@" + host
		}
	}
	if p := u.Port(); p != "" {
		port, err := strconv.Atoi(p)
		if err != nil {
			return "", fmt.Errorf("invalid port in scp URI %q: %w", raw, err)
		}
		escPath := strings.ReplaceAll((&url.URL{Path: path}).EscapedPath(), "@", "%40")
		return fmt.Sprintf("scp://%s:%d/%s", host, port, escPath), nil
	}
	return host + ":" + path, nil
}

// scanUserOptions reports whether an scp argv (the user's, or the options a
// server-minted destination carries) sets an explicit StrictHostKeyChecking
// policy or routes through a jump host (-J or -o ProxyJump), either of which
// suppresses the injected accept-new. It matches the flags precisely so an
// operand that merely contains the text "StrictHostKeyChecking" (e.g. a file
// path) does not trip it, and — mirroring scp's OpenBSD getopt — stops at the
// first operand (or a "--"), so a dash-prefixed file operand is not read as an
// option.
func scanUserOptions(argv []string) (userSetStrict, userJumpHost bool) {
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
			case strings.EqualFold(key, "ProxyJump"):
				userJumpHost = true
			}
			if tok == "-o" {
				i++ // the value lived in the following token
			}
			continue
		}

		// Walk the option-letter cluster looking for -J (jump host). The first
		// arg-taking letter consumes the rest of the token as its attached value
		// (e.g. "-Jbastion", "-i/home/me/Jump/key"), so stop there: letters past it
		// are a value, not options, and a capital J in an identity path is not the
		// jump-host flag.
		for _, c := range tok[1:] {
			if c == 'J' {
				userJumpHost = true
			}
			if strings.ContainsRune(scpArgOptions, c) {
				break
			}
		}

		// Skip an option's argument in the following token so it is not read as
		// the first operand (which would end option scanning prematurely).
		if consumesNextArg(tok) && i+1 < len(argv) {
			i++
		}
	}
	return userSetStrict, userJumpHost
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

// looksLikeRemote applies scp's own heuristic for a "host:path" remote: a colon
// that appears before any slash marks a remote spec. Local paths (which have no
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
// "-h"/"--help" counts: once the first operand or a "--" appears, scp treats
// later tokens as file operands, so a copy source literally named "-h" is not
// mistaken for a help request.
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
