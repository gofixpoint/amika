// Package wslbridge spans the WSL boundary: amika runs as a Linux binary
// inside a WSL distribution while the user's editors run as Windows
// applications. It detects WSL, resolves the Windows user's paths through
// interop, and locates Windows editor executables, so callers can mirror
// connection state to the Windows side and launch editors there.
package wslbridge

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// readProcVersion is a seam over the kernel version file, so tests can decide
// whether the process looks like it runs under WSL.
var readProcVersion = func() ([]byte, error) { return os.ReadFile("/proc/version") }

// runInterop is a seam over interop execution: Windows-side helper programs
// invoked from WSL, whose answers the caller cannot compute on its own. Tests
// stub it to answer without a Windows side.
var runInterop = func(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("run %s: %w: %s", name, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// userProfileLine matches one drive-anchored Windows path, the shape a valid
// %USERPROFILE% expansion must have. Matching the whole line keeps leading
// interop noise from being mistaken for the value.
var userProfileLine = regexp.MustCompile(`(?m)^[A-Za-z]:\\[^\r\n]*$`)

// IsWSL reports whether this process runs inside the Windows Subsystem for
// Linux, where the user's editors are Windows applications. Any failure to
// read the kernel version means not WSL.
func IsWSL() bool {
	version, err := readProcVersion()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(version)), "microsoft")
}

// Distro returns the name of the WSL distribution this process runs in, which
// a Windows-side proxy command must pin so it re-enters the distribution that
// owns amika's state.
func Distro() (string, error) {
	distro := os.Getenv("WSL_DISTRO_NAME")
	if distro == "" {
		return "", fmt.Errorf("WSL_DISTRO_NAME is not set; run amika from an interactive WSL shell")
	}
	return distro, nil
}

// Target names the Windows side an editor launch needs: the user's .ssh
// directory in both path spellings, the WSL distribution a proxy command must
// re-enter, and the Windows account name used for ACL grants.
type Target struct {
	SSHDir        string
	SSHDirWindows string
	Distro        string
	User          string
}

// ResolveTarget collects the Windows-side facts the SSH mirror and the editor
// launch need. It fails rather than guesses when interop cannot answer.
func ResolveTarget() (Target, error) {
	distro, err := Distro()
	if err != nil {
		return Target{}, err
	}
	profile, err := UserProfile()
	if err != nil {
		return Target{}, err
	}
	sshDirWindows := profile + "\\.ssh"
	sshDir, err := toWSLPath(sshDirWindows)
	if err != nil {
		return Target{}, err
	}
	user := profile[strings.LastIndexByte(profile, '\\')+1:]
	if user == "" {
		return Target{}, fmt.Errorf("derive Windows account name from profile %q", profile)
	}
	return Target{SSHDir: sshDir, SSHDirWindows: sshDirWindows, Distro: distro, User: user}, nil
}

// UserProfile returns the Windows user profile directory (for example
// C:\Users\name) by asking cmd.exe to expand %USERPROFILE%.
func UserProfile() (string, error) {
	cmdExe, err := ResolveWindowsBin("cmd.exe")
	if err != nil {
		return "", fmt.Errorf("locate cmd.exe (is WSL interop enabled?): %w", err)
	}
	out, err := runInterop(cmdExe, "/c", "echo", "%USERPROFILE%")
	if err != nil {
		return "", fmt.Errorf("expand %%USERPROFILE%% (is WSL interop enabled?): %w", err)
	}
	out = strings.ReplaceAll(out, "\r\n", "\n")
	lines := userProfileLine.FindAllString(out, -1)
	if len(lines) == 0 {
		return "", fmt.Errorf("cmd.exe returned %q for %%USERPROFILE%%", strings.TrimSpace(out))
	}
	return strings.TrimSpace(lines[len(lines)-1]), nil
}

// editorInstalls maps a VS Code-family CLI name to its Windows install folder
// and executable, covering the default per-user locations used when the CLI
// cannot be found on the Windows PATH.
var editorInstalls = map[string]struct{ dir, exe string }{
	"code":   {"Microsoft VS Code", "Code.exe"},
	"cursor": {"Cursor", "Cursor.exe"},
}

// EditorExe locates the Windows application executable behind a VS Code-family
// editor CLI name ("code", "cursor") and returns its Windows path.
func EditorExe(cli string) (string, error) {
	install, ok := editorInstalls[cli]
	if !ok {
		return "", fmt.Errorf("unsupported Windows editor %q", cli)
	}
	var candidates []string
	
	// --- CHANGED BLOCK START ---
	if whereExe, err := ResolveWindowsBin("where.exe"); err == nil {
		if where, err := runInterop(whereExe, cli); err == nil {
			if line := firstLine(where); line != "" {
	// --- CHANGED BLOCK END ---
	
				if idx := strings.LastIndexByte(line, '\\'); idx > 2 {
					dir := line[:idx]
					// The CLI launcher sits one bin\ or cmd\ level below the application
					// executable, so search the install root it belongs to.
					lower := strings.ToLower(dir)
					if strings.HasSuffix(lower, "\\bin") || strings.HasSuffix(lower, "\\cmd") {
						dir = dir[:strings.LastIndexByte(dir, '\\')]
					}
					candidates = append(candidates, dir+"\\"+install.exe)
				}
			}
		}
	}
	if profile, err := UserProfile(); err == nil {
		candidates = append(candidates,
			profile+"\\AppData\\Local\\Programs\\"+install.dir+"\\"+install.exe)
	}
	for _, candidate := range candidates {
		wslPath, err := toWSLPath(candidate)
		if err != nil {
			continue
		}
		if info, err := os.Stat(wslPath); err == nil && info.Mode().IsRegular() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("no Windows %s found; install the editor on Windows", install.exe)
}

// execDetached is a seam over the detached spawn, so tests observe the argv
// without a Windows side.
var execDetached = func(name string, args ...string) error {
	// All stdio is /dev/null so the child inherits no pipe, and the process
	// is reaped in the background: the caller returns once the process is
	// spawned, not when it exits.
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer null.Close()
	cmd := exec.Command(name, args...)
	cmd.Stdin = null
	cmd.Stdout = null
	cmd.Stderr = null
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// cmdMetacharacters are the characters cmd.exe keeps interpreting even inside
// double quotes: command separators, redirection, escaping, %VAR% expansion,
// and the quote itself. Interop quoting cannot neutralize them, so no argument
// crossing into cmd.exe may contain one.
const cmdMetacharacters = "&|^<>%\""

// checkCmdArg rejects an argument cmd.exe could reinterpret as anything other
// than a literal value. The launch arguments are already constrained upstream
// (sandbox names are valid hosts, the control plane enforces repo name
// characters), so this is a second fence at the boundary itself.
func checkCmdArg(arg string) error {
	if strings.ContainsAny(arg, cmdMetacharacters) {
		return fmt.Errorf("argument %q contains a cmd.exe metacharacter", arg)
	}
	for _, r := range arg {
		if r < 0x20 {
			return fmt.Errorf("argument %q contains a control character", arg)
		}
	}
	return nil
}

// LaunchDetached starts a Windows executable through cmd.exe's start command
// and returns as soon as it is spawned. The empty title argument keeps start
// from treating a quoted executable path as the window title.
func LaunchDetached(windowsExe string, args ...string) error {
	for _, arg := range append([]string{windowsExe}, args...) {
		if err := checkCmdArg(arg); err != nil {
			return err
		}
	}
	
	cmdExe, err := ResolveWindowsBin("cmd.exe")
	if err != nil {
		return fmt.Errorf("locate cmd.exe: %w", err)
	}
	
	startArgs := append([]string{"/c", "start", "", windowsExe}, args...)
	if err := execDetached(cmdExe, startArgs...); err != nil {
		return fmt.Errorf("launch %s: %w", windowsExe, err)
	}
	return nil
}

// ResolveWindowsBin attempts to locate a core Windows executable (e.g. "cmd.exe").
// It checks the standard $PATH first. If appendWindowsPath=false in wsl.conf,
// it falls back to dynamically resolving the mount point for System32 via wslpath.
func ResolveWindowsBin(binName string) (string, error) {
	if path, err := exec.LookPath(binName); err == nil {
		return path, nil
	}

	// Fallback for strict PATH hygiene: derive mount point via wslpath.
	winPath := `C:\Windows\System32\` + binName
	wslPath, err := toWSLPath(winPath)
	if err != nil {
		return "", fmt.Errorf("resolve %s via fallback: %w", binName, err)
	}

	if info, err := os.Stat(wslPath); err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("fallback %s not found or invalid: %w", wslPath, err)
	}

	return wslPath, nil
}

// toWSLPath converts an absolute Windows path to its WSL mount path via
// wslpath, so file operations can reach it from Linux.
func toWSLPath(windowsPath string) (string, error) {
	out, err := runInterop("wslpath", "-u", windowsPath)
	if err != nil {
		return "", fmt.Errorf("convert %q to a WSL path: %w", windowsPath, err)
	}
	converted := strings.TrimSpace(out)
	if converted == "" {
		return "", fmt.Errorf("wslpath returned nothing for %q", windowsPath)
	}
	return converted, nil
}

// firstLine returns the first non-empty line of a command's output.
func firstLine(out string) string {
	for _, line := range strings.Split(out, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
