package scpcmd

// scp.go parses copy operands and invokes the system scp binary.

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// sandboxHome is the login user's home directory inside every sandbox. A
// relative sandbox path, a bare "~", or a leading "~/" resolves against it.
const sandboxHome = "/home/amika"

// scpPlan is the parsed form of an `amika scp` invocation: the residual argv
// handed to scp (its flags, sources, and target in original order) and whether
// to print the command instead of running it.
type scpPlan struct {
	scpArgv   []string
	printOnly bool
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
