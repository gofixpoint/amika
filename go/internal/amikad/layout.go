package amikad

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	"github.com/gofixpoint/amika/go/internal/amikad/sshd"
	"github.com/gofixpoint/amika/go/internal/constants"
)

// Environment variables that select and configure user mode. amikad has no
// flag for user mode: amika-hostd selects it on a bare-metal host through the
// environment it runs amikad with, so the control plane's commands are the
// same for every rig.
const (
	// EnvStateDir, when set, selects user mode and roots all amikad state.
	EnvStateDir = "AMIKAD_STATE_DIR"
	// EnvListen is the HTTP listener's host:port; user mode requires a
	// loopback IP. It overrides serve's --port.
	EnvListen = "AMIKAD_LISTEN"
	// EnvSSHDPort is the managed sshd's loopback port in user mode.
	EnvSSHDPort = "AMIKAD_SSHD_PORT"
)

const (
	rootManifestPath = "/var/lib/amikad/injected-paths.json"
	rootTokenPath    = "/var/lib/amikad/connect-token"
	rootServeLogPath = "/var/log/amikad/no-relay.log"
)

// ErrInvalidEnvironment marks user-mode configuration amikad refuses to run
// with.
var ErrInvalidEnvironment = errors.New("invalid amikad environment")

// Layout is where amikad keeps its state and how it listens.
//
// Root mode, inside a rig VM, uses fixed system paths and manages sshd for
// the image's account. User mode, on a bare-metal host, keeps everything in
// one state directory, runs as and admits only the invoking account, and
// listens on loopback only.
type Layout struct {
	UserMode     bool
	ManifestPath string
	TokenPath    string
	ServeLogPath string
	// ListenHost is the HTTP bind host; "" binds every interface.
	ListenHost string
	// ListenPort overrides serve's --port when non-zero.
	ListenPort int
	SSHD       sshd.Paths
}

// RootLayout is the layout amikad has always used inside a rig VM.
func RootLayout() Layout {
	return Layout{
		ManifestPath: rootManifestPath,
		TokenPath:    rootTokenPath,
		ServeLogPath: rootServeLogPath,
		SSHD:         sshd.DefaultPaths(),
	}
}

// ResolveLayout selects root or user mode from the environment. Without
// EnvStateDir it returns RootLayout, and refuses the other user-mode
// variables rather than silently ignoring them.
func ResolveLayout(getenv func(string) string, currentUser func() (*user.User, error)) (Layout, error) {
	stateDirectory := getenv(EnvStateDir)
	if stateDirectory == "" {
		for _, name := range []string{EnvListen, EnvSSHDPort} {
			if getenv(name) != "" {
				return Layout{}, fmt.Errorf("%w: %s requires %s", ErrInvalidEnvironment, name, EnvStateDir)
			}
		}
		return RootLayout(), nil
	}
	return resolveUserLayout(stateDirectory, getenv, currentUser)
}

// PrepareStateDirectory creates the user-mode state directory owner-only, so
// the files written into it, and the authorized_keys sshd reads from it,
// cannot be swapped by another account. Root mode's directories are created
// by the image.
func PrepareStateDirectory(layout Layout) error {
	if !layout.UserMode {
		return nil
	}
	directory := filepath.Dir(layout.TokenPath)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("%w: %s is not a directory", ErrInvalidEnvironment, EnvStateDir)
	}
	if info.Mode().Perm() == 0o700 {
		return nil
	}
	return os.Chmod(directory, 0o700)
}

func resolveUserLayout(
	stateDirectory string,
	getenv func(string) string,
	currentUser func() (*user.User, error),
) (Layout, error) {
	if !filepath.IsAbs(stateDirectory) {
		return Layout{}, fmt.Errorf("%w: %s must be an absolute path", ErrInvalidEnvironment, EnvStateDir)
	}
	stateDirectory, err := resolveStateDirectory(stateDirectory)
	if err != nil {
		return Layout{}, err
	}
	account, err := currentUser()
	if err != nil {
		return Layout{}, fmt.Errorf("look up current user: %w", err)
	}
	listenHost, listenPort, err := parseLoopbackListen(getenv(EnvListen))
	if err != nil {
		return Layout{}, err
	}
	sshdPort := constants.ManagedSSHDPort
	if raw := getenv(EnvSSHDPort); raw != "" {
		if sshdPort, err = parsePort(raw); err != nil {
			return Layout{}, fmt.Errorf("%w: %s: %w", ErrInvalidEnvironment, EnvSSHDPort, err)
		}
	}
	if listenPort == sshdPort {
		return Layout{}, fmt.Errorf("%w: %s and %s use the same port", ErrInvalidEnvironment, EnvListen, EnvSSHDPort)
	}
	paths := sshd.UserPaths(stateDirectory, account.Username, sshdPort)
	if err := sshd.ValidateAllowUser(paths.AllowUser); err != nil {
		return Layout{}, fmt.Errorf("current user %q: %w", account.Username, err)
	}
	return Layout{
		UserMode:     true,
		ManifestPath: filepath.Join(stateDirectory, "injected-paths.json"),
		TokenPath:    filepath.Join(stateDirectory, "connect-token"),
		ServeLogPath: filepath.Join(stateDirectory, "log", "no-relay.log"),
		ListenHost:   listenHost,
		ListenPort:   listenPort,
		SSHD:         paths,
	}, nil
}

// resolveStateDirectory resolves symlinks in the state directory's parents,
// keeping its final component as given. The secure writes refuse a symlink at
// every level, yet the parents belong to the operator and are often linked by
// the OS itself: /home on Fedora Silverblue, and /var and /tmp on macOS. The
// final component stays unresolved, so a symlink there is still refused.
//
// The result is also checked for characters sshd cannot take in a path:
// sshd_config splits on whitespace, honours quotes and backslashes, and
// expands % tokens in AuthorizedKeysFile, so any of them would leave a config
// that sshd rejects or misreads, long after setup reported success.
func resolveStateDirectory(stateDirectory string) (string, error) {
	stateDirectory = filepath.Clean(stateDirectory)
	parent, err := filepath.EvalSymlinks(filepath.Dir(stateDirectory))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Errorf("%w: %s: resolve parent: %w", ErrInvalidEnvironment, EnvStateDir, err)
	}
	if err == nil {
		stateDirectory = filepath.Join(parent, filepath.Base(stateDirectory))
	}
	if strings.ContainsFunc(stateDirectory, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r) || strings.ContainsRune(`%"'\`, r)
	}) {
		return "", fmt.Errorf("%w: %s %q contains whitespace, %%, a quote, a backslash or a control character, which sshd_config cannot hold", ErrInvalidEnvironment, EnvStateDir, stateDirectory)
	}
	return stateDirectory, nil
}

// parseLoopbackListen accepts an IP-literal loopback host:port. A hostname,
// even "localhost", is refused: resolution could reach a non-loopback
// address. Empty keeps serve's --port on 127.0.0.1.
func parseLoopbackListen(raw string) (string, int, error) {
	if raw == "" {
		return "127.0.0.1", 0, nil
	}
	host, rawPort, err := net.SplitHostPort(raw)
	if err != nil {
		return "", 0, fmt.Errorf("%w: %s: %w", ErrInvalidEnvironment, EnvListen, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return "", 0, fmt.Errorf("%w: %s must be a loopback IP address, got %q", ErrInvalidEnvironment, EnvListen, host)
	}
	port, err := parsePort(rawPort)
	if err != nil {
		return "", 0, fmt.Errorf("%w: %s: %w", ErrInvalidEnvironment, EnvListen, err)
	}
	return ip.String(), port, nil
}

func parsePort(raw string) (int, error) {
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("invalid port %q", raw)
	}
	return port, nil
}
