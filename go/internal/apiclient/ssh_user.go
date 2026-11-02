package apiclient

import "regexp"

// DefaultSSHUser is the login account inside every VM rig. A bare-metal rig
// logs in as the account running amika-hostd instead, which the SSH session
// descriptor reports as its ssh_user.
const DefaultSSHUser = "amika"

// maxSSHUserLength bounds an SSH login name. Linux caps account names at 32
// bytes and macOS short names are shorter still, so 64 leaves headroom without
// admitting anything pathological.
const maxSSHUserLength = 64

// sshUserPattern is the allow-list of SSH login names. It admits the
// characters POSIX portable user names use (letters of either case, digits,
// ".", "_", "-") and requires a letter, digit, or "_" first, so a name can
// never read as a command-line option.
var sshUserPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]*$`)

// ValidSSHUser reports whether name is safe to use as an SSH login name: in
// an ssh_config `User` line, as `-l <name>`, and in a `<name>@<host>`
// argument.
//
// The check is an allow-list rather than a deny-list of the dangerous
// characters, so anything outside it is refused: whitespace and control
// characters (which would end or split a config line), "@", ":", and "/"
// (which would change how a destination parses), quotes, backslash, and "#"
// (which ssh_config reads as quoting, escapes, or a comment), and "%" (which
// OpenSSH expands as a token in `User`). A leading "-" is refused too.
// Uppercase is allowed because macOS account names may contain it.
func ValidSSHUser(name string) bool {
	return len(name) <= maxSSHUserLength && sshUserPattern.MatchString(name)
}
