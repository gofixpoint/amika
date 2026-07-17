package scpcmd

// stream.go copies files between the local machine and a sandbox by streaming
// over an ssh exec channel instead of running scp.
//
// Why: Daytona's linux-vm SSH gateway does not deliver the client's channel-EOF
// (half-close) to a non-interactive remote command. scp and sftp both finish the
// transfer but then block forever waiting for the remote transfer sink to see
// end-of-input and close the channel, which never happens. The only shape that
// tears down cleanly is a remote process that EXITS ON ITS OWN. So:
//
//   - download: `ssh dest -- cat <remote>`      (remote cat hits file EOF, exits)
//   - upload:   `local | ssh dest -- head -c N > <remote>`  (head exits after N)
//   - directories use tar, still fronted by `head -c N` on upload so the remote
//     never waits for an EOF that will not arrive.
//
// This is a workaround for the gateway bug; only local<->sandbox copies use it.
// External scp:// hosts and local-only copies keep the real scp path, which has
// no such teardown problem.

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

// streamPlan is a local<->sandbox copy to be streamed over ssh.
type streamPlan struct {
	upload      bool   // true: local -> sandbox; false: sandbox -> local
	recursive   bool   // -r was passed
	sandboxName string // sandbox to resolve
	remotePath  string // absolute path inside the sandbox
	localPath   string // path on the local machine
}

// operand kinds for classifying an scp source/target token.
const (
	opLocal = iota
	opSandbox
	opExternal
)

type operand struct {
	kind        int
	sandboxName string // opSandbox
	remotePath  string // opSandbox, resolved to an absolute sandbox path
	localPath   string // opLocal
}

// planStreamTransfer inspects the residual scp argv and, if it is a simple
// local<->sandbox copy (exactly one local operand and one sandbox operand),
// returns a streamPlan and true. Any other shape — an external scp:// host,
// local-only, sandbox<->sandbox, or more than two operands — returns false so
// the caller falls back to the scp path. A malformed sandbox URI returns an
// error.
func planStreamTransfer(plan scpPlan) (streamPlan, bool, error) {
	operands, recursive := splitOperandsAndFlags(plan.scpArgv)
	if len(operands) != 2 {
		return streamPlan{}, false, nil
	}
	src, err := classifyOperand(operands[0])
	if err != nil {
		return streamPlan{}, false, err
	}
	dst, err := classifyOperand(operands[1])
	if err != nil {
		return streamPlan{}, false, err
	}
	switch {
	case src.kind == opLocal && dst.kind == opSandbox:
		return streamPlan{upload: true, recursive: recursive, sandboxName: dst.sandboxName, remotePath: dst.remotePath, localPath: src.localPath}, true, nil
	case src.kind == opSandbox && dst.kind == opLocal:
		return streamPlan{upload: false, recursive: recursive, sandboxName: src.sandboxName, remotePath: src.remotePath, localPath: dst.localPath}, true, nil
	default:
		return streamPlan{}, false, nil
	}
}

// splitOperandsAndFlags separates scp operands from option flags (mirroring
// scp's getopt: options stop at the first operand or a "--"), and reports
// whether -r (recursive) was among the options.
func splitOperandsAndFlags(argv []string) (operands []string, recursive bool) {
	optionsEnded := false
	for i := 0; i < len(argv); i++ {
		tok := argv[i]
		if !optionsEnded {
			if tok == "--" {
				optionsEnded = true
				continue
			}
			if len(tok) >= 2 && tok[0] == '-' {
				// Walk the option-letter cluster (stopping at the first arg-taking
				// letter, whose attached value is not options) looking for -r.
				for _, c := range tok[1:] {
					if c == 'r' {
						recursive = true
					}
					if strings.ContainsRune(scpArgOptions, c) {
						break
					}
				}
				if consumesNextArg(tok) && i+1 < len(argv) {
					i++
				}
				continue
			}
			optionsEnded = true
		}
		operands = append(operands, tok)
	}
	return operands, recursive
}

// classifyOperand determines whether a source/target token is a local path, a
// sandbox reference, or an external scp:// host, resolving a sandbox reference
// to its absolute remote path.
func classifyOperand(tok string) (operand, error) {
	switch {
	case strings.HasPrefix(tok, "sbox://"):
		name, p, err := parseSboxURI(tok)
		if err != nil {
			return operand{}, err
		}
		return operand{kind: opSandbox, sandboxName: name, remotePath: resolveSandboxURIPath(p)}, nil
	case strings.HasPrefix(tok, "scp://"):
		return operand{kind: opExternal}, nil
	case looksLikeRemote(tok):
		name, p := splitSandboxRef(tok)
		return operand{kind: opSandbox, sandboxName: name, remotePath: resolveSandboxScpPath(p)}, nil
	default:
		return operand{kind: opLocal, localPath: tok}, nil
	}
}

// runStreamTransfer resolves the sandbox destination and performs the copy over
// an ssh exec channel.
func runStreamTransfer(cmd *cobra.Command, sp streamPlan, resolve destResolver, printOnly bool) error {
	dest, err := resolve(sp.sandboxName)
	if err != nil {
		return err
	}
	base := streamSSHArgs(dest)

	switch {
	case sp.upload && sp.recursive:
		return streamUploadDir(cmd, base, sp, printOnly)
	case sp.upload:
		return streamUploadFile(cmd, base, sp, printOnly)
	case sp.recursive:
		return streamDownloadDir(cmd, base, sp, printOnly)
	default:
		return streamDownloadFile(cmd, base, sp, printOnly)
	}
}

// streamSSHArgs builds the ssh options and destination for a sandbox connection:
// the destination's own ssh options, an accept-new host-key policy (unless the
// destination already sets one), the port, and the [user@]host target.
func streamSSHArgs(d ssh.Destination) []string {
	var a []string
	a = append(a, d.Options...)
	if strict, _ := scanUserOptions(d.Options); !strict {
		a = append(a, "-o", "StrictHostKeyChecking=accept-new")
	}
	if d.Port != 0 {
		a = append(a, "-p", strconv.Itoa(d.Port))
	}
	host := d.Host
	if strings.Contains(host, ":") {
		host = "[" + host + "]" // bracket an IPv6 literal
	}
	if d.User != "" {
		host = d.User + "@" + host
	}
	return append(a, host)
}

// --- remote command builders (pure, so they can be unit-tested) ---

// uploadFileRemoteCmd writes exactly size bytes from stdin to remotePath. If
// remotePath is an existing directory, the file lands inside it under localBase
// (mirroring `scp file host:dir/`). `head -c size` exits on its own after size
// bytes, so the session tears down without waiting for a channel-EOF.
func uploadFileRemoteCmd(remotePath, localBase string, size int64) string {
	return fmt.Sprintf(`d=%s; if [ -d "$d" ]; then d="$d/"%s; fi; exec head -c %d > "$d"`,
		shellQuote(remotePath), shellQuote(localBase), size)
}

// uploadDirRemoteCmd extracts a size-bounded tar stream into remoteDir.
func uploadDirRemoteCmd(remoteDir string, size int64) string {
	return fmt.Sprintf(`mkdir -p %s && head -c %d | tar -x -C %s`,
		shellQuote(remoteDir), size, shellQuote(remoteDir))
}

// downloadFileRemoteCmd streams remotePath to stdout; cat exits at the file's
// own EOF.
func downloadFileRemoteCmd(remotePath string) string {
	return fmt.Sprintf(`exec cat %s`, shellQuote(remotePath))
}

// downloadDirRemoteCmd tars the directory (by name, so it extracts as a
// directory locally) to stdout; tar exits when it finishes the archive.
func downloadDirRemoteCmd(remotePath string) string {
	return fmt.Sprintf(`exec tar -c -C %s %s`,
		shellQuote(path.Dir(remotePath)), shellQuote(path.Base(remotePath)))
}

// --- transfer implementations ---

func streamUploadFile(cmd *cobra.Command, base []string, sp streamPlan, printOnly bool) error {
	fi, err := os.Stat(sp.localPath)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		return fmt.Errorf("%q is a directory; pass -r to copy directories", sp.localPath)
	}
	remoteCmd := uploadFileRemoteCmd(sp.remotePath, filepath.Base(sp.localPath), fi.Size())
	if printOnly {
		return printStream(cmd, base, remoteCmd, "< "+sp.localPath)
	}
	f, err := os.Open(sp.localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return runSSHStream(base, remoteCmd, f, os.Stdout)
}

func streamUploadDir(cmd *cobra.Command, base []string, sp streamPlan, printOnly bool) error {
	tmp, err := os.CreateTemp("", "amika-scp-*.tar")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	parent, name := filepath.Dir(sp.localPath), filepath.Base(sp.localPath)
	tarc := exec.Command("tar", "-c", "-C", parent, name)
	tarc.Stdout = tmp
	tarc.Stderr = os.Stderr
	if err := tarc.Run(); err != nil {
		return fmt.Errorf("packing %q: %w", sp.localPath, err)
	}
	size, err := tmp.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	remoteCmd := uploadDirRemoteCmd(sp.remotePath, size)
	if printOnly {
		return printStream(cmd, base, remoteCmd, fmt.Sprintf("< (tar of %s, %d bytes)", sp.localPath, size))
	}
	return runSSHStream(base, remoteCmd, tmp, os.Stdout)
}

func streamDownloadFile(cmd *cobra.Command, base []string, sp streamPlan, printOnly bool) error {
	target := sp.localPath
	if fi, err := os.Stat(target); err == nil && fi.IsDir() {
		target = filepath.Join(target, path.Base(sp.remotePath))
	}
	remoteCmd := downloadFileRemoteCmd(sp.remotePath)
	if printOnly {
		return printStream(cmd, base, remoteCmd, "> "+target)
	}
	f, err := os.Create(target)
	if err != nil {
		return err
	}
	defer f.Close()
	return runSSHStream(base, remoteCmd, nil, f)
}

func streamDownloadDir(cmd *cobra.Command, base []string, sp streamPlan, printOnly bool) error {
	remoteCmd := downloadDirRemoteCmd(sp.remotePath)
	if printOnly {
		return printStream(cmd, base, remoteCmd, "| tar -x -C "+sp.localPath)
	}
	if err := os.MkdirAll(sp.localPath, 0o755); err != nil {
		return err
	}
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		return fmt.Errorf("ssh not found: %w", err)
	}
	sshCmd := exec.Command(sshBin, append(append([]string{}, base...), remoteCmd)...)
	tarx := exec.Command("tar", "-x", "-C", sp.localPath)

	pr, pw := io.Pipe()
	sshCmd.Stdout = pw
	sshCmd.Stderr = os.Stderr
	tarx.Stdin = pr
	tarx.Stdout = os.Stdout
	tarx.Stderr = os.Stderr

	if err := tarx.Start(); err != nil {
		return err
	}
	sshErr := sshCmd.Run()
	pw.Close()
	tarErr := tarx.Wait()
	if sshErr != nil {
		return sshErr
	}
	return tarErr
}

// runSSHStream runs `ssh <base> <remoteCmd>` with the given stdin/stdout wired
// to the local end of the transfer. A nil stdin connects the child to the null
// device (so ssh never blocks on the terminal).
func runSSHStream(base []string, remoteCmd string, stdin io.Reader, stdout io.Writer) error {
	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		return fmt.Errorf("ssh not found: %w", err)
	}
	c := exec.Command(sshBin, append(append([]string{}, base...), remoteCmd)...)
	c.Stdin = stdin
	c.Stdout = stdout
	c.Stderr = os.Stderr
	return c.Run()
}

// printStream renders the resolved ssh command for --print, with a note showing
// how the local file is piped.
func printStream(cmd *cobra.Command, base []string, remoteCmd, redir string) error {
	full := append([]string{"ssh"}, base...)
	full = append(full, remoteCmd)
	fmt.Fprintln(cmd.OutOrStdout(), formatCommand(full)+"  "+redir)
	return nil
}

// shellQuote wraps s in single quotes for safe interpolation into a remote
// POSIX shell command.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
