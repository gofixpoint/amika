package ssh

// wslmirror.go renders and writes the Windows-side copy of the managed SSH
// config for WSL setups, where amika runs in WSL but the editors that need
// the connection state run as Windows applications.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/wslbridge"
)

// safeWindowsConfigPath accepts an absolute Windows path whose characters
// cannot alter ssh config parsing or OpenSSH %-token expansion.
var safeWindowsConfigPath = regexp.MustCompile(`^[A-Za-z]:\\[^/*?:"<>|%\r\n\t'` + "`" + `]+$`)

// runIcacls is a seam over the Windows ACL tool, so tests observe the
// permission hardening without a Windows side.
var runIcacls = func(path, user string) error {
	cmd := exec.Command("icacls.exe", path, "/inheritance:r", "/grant:r", user+":F")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("icacls %s: %w: %s", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// RenderWindows renders the managed config for a Windows OpenSSH client.
// Provider-native host blocks pass through unchanged, since their
// destinations are reachable from Windows directly; session blocks reference
// the mirrored identity and pin files and dial through wsl.exe into the
// distribution that owns the session state.
func RenderWindows(state HostsState, target wslbridge.Target) (string, error) {
	if !safeWindowsConfigPath.MatchString(target.SSHDirWindows) {
		return "", fmt.Errorf("unsafe Windows .ssh directory %q", target.SSHDirWindows)
	}
	var b strings.Builder
	blocks := renderWindowsSessionBlocks(state, target)
	writeManagedConfig(&b, state, blocks)
	return b.String(), nil
}

// renderWindowsSessionBlocks renders one wildcard block per control plane,
// rebuilding each ProxyCommand as its wsl.exe equivalent and pointing the key
// material at the mirrored copies in the Windows .ssh directory. Blocks that
// fail validation are skipped rather than fatal, matching renderSessionBlocks:
// a bad entry must not make the whole mirror unwritable, and the v1
// provider-host flow needs no session block at all.
func renderWindowsSessionBlocks(state HostsState, target wslbridge.Target) []string {
	if state.SessionConfig == nil {
		return nil
	}
	environments := make([]string, 0, len(state.SessionProxyCommands))
	for environment := range state.SessionProxyCommands {
		environments = append(environments, environment)
	}
	sort.Strings(environments)
	blocks := make([]string, 0, len(environments))
	for _, environment := range environments {
		// The Linux renderer validates the environment inside
		// RenderSessionConfig; this path bypasses that call, so it applies
		// the same check itself before embedding the key in a Host pattern.
		if !safeAliasSegment.MatchString(environment) {
			continue
		}
		binaryPath, err := ParseProxyCommand(state.SessionProxyCommands[environment])
		if err != nil {
			continue
		}
		proxyCommand, err := BuildWSLProxyCommand(target.Distro, binaryPath)
		if err != nil {
			continue
		}
		blocks = append(blocks, renderSessionBlock(
			environment,
			proxyCommand,
			quoteWindowsPath(target.SSHDirWindows+"\\"+basedir.SSHIdentityName()),
			quoteWindowsPath(target.SSHDirWindows+"\\"+basedir.SSHKnownHostsName()),
			"",
		))
	}
	return blocks
}

// quoteWindowsPath wraps a path in the double quotes ssh config accepts, so
// profiles containing spaces parse as one value.
func quoteWindowsPath(path string) string {
	return `"` + path + `"`
}

// MirrorToWindows publishes the current managed SSH state to the Windows
// side: it renders the config for a Windows client, writes it as the
// mirrored amika.conf, adds the Include line to the Windows ssh config, and
// copies the identity and host-key pins the rendered config references,
// restricting the identity's Windows ACLs. The Windows copies are
// regenerated artifacts; the Linux-side state stays the only source of
// truth.
func MirrorToWindows(paths basedir.Paths, target wslbridge.Target) error {
	state, err := LoadState(paths)
	if err != nil {
		return err
	}
	content, err := RenderWindows(state, target)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(filepath.Join(target.SSHDir, basedir.SSHAmikaConfigName()), []byte(content), 0o600); err != nil {
		return err
	}
	if err := ensureIncludeIn(filepath.Join(target.SSHDir, basedir.SSHConfigName())); err != nil {
		return fmt.Errorf("ensure Windows ssh config include: %w", err)
	}

	identityPath, knownHostsPath, err := sessionKeyMaterialPaths(paths, state)
	if err != nil {
		return err
	}
	identityCopied, err := mirrorFile(identityPath, filepath.Join(target.SSHDir, basedir.SSHIdentityName()))
	if err != nil {
		return err
	}
	if identityCopied {
		if err := runIcacls(target.SSHDirWindows+"\\"+basedir.SSHIdentityName(), target.User); err != nil {
			return fmt.Errorf("restrict mirrored identity permissions: %w", err)
		}
	}

	_, err = mirrorFile(knownHostsPath, filepath.Join(target.SSHDir, basedir.SSHKnownHostsName()))
	return err
}

// isWSL and resolveWSLTarget are seams over WSL detection, so a test can drive
// both sides of the mirrored pin store's branch from any platform.
var (
	isWSL            = wslbridge.IsWSL
	resolveWSLTarget = wslbridge.ResolveTarget
)

// windowsMirroredPins wraps a pin store so every pin it accepts is republished
// to the Windows side, and returns the store untouched when this is not a WSL
// setup.
//
// A WSL setup is the one place where writing the Linux pin file is not enough:
// the editor is a Windows application, so the OpenSSH that verifies the host
// reads the mirrored `amika_known_hosts` in the Windows .ssh directory, which
// until now only an editor launch through `sandbox code` refreshed. Without
// this, pinning from the proxy would fix the deep links everywhere except the
// platform whose ProxyCommand exists to cross back into Linux.
func windowsMirroredPins(pins HostKeyPinStore, knownHostsFile string, warnings io.Writer) HostKeyPinStore {
	if !isWSL() {
		return pins
	}
	return mirroredPinStore{pins: pins, knownHostsFile: knownHostsFile, warnings: warnings}
}

// mirroredPinStore pins on the Linux side and republishes the Windows copy of
// the pin file.
type mirroredPinStore struct {
	pins           HostKeyPinStore
	knownHostsFile string
	warnings       io.Writer
}

// Pin writes the pin, then republishes it to the Windows side. A failed
// republish is reported rather than returned: the Windows copy is a derived
// artifact, and a stale one can only make OpenSSH refuse a host it cannot
// verify, never admit one. Failing the dial instead would end a connection
// whose pin is already mirrored, which this is not entitled to do.
func (s mirroredPinStore) Pin(alias, hostPublicKey string) error {
	if err := s.pins.Pin(alias, hostPublicKey); err != nil {
		return err
	}
	if err := s.mirror(); err != nil && s.warnings != nil {
		fmt.Fprintf(s.warnings, "warning: could not publish the host key to the Windows copy of %s: %v\n", basedir.SSHKnownHostsName(), err)
	}
	return nil
}

// mirror copies the pin file alone, rather than calling MirrorToWindows.
//
// The full mirror refreshes the config, the include line, the identity and its
// Windows ACLs before it reaches the pin file, and any of those failing would
// take the pin down with it — an absent `icacls.exe` would leave OpenSSH
// refusing a sandbox whose config and identity were perfectly usable, which is
// the failure this whole path exists to remove.
//
// Copying only the pin is also all this path is entitled to do. OpenSSH ran
// this ProxyCommand, so the Windows config that names it is already there,
// along with the identity it points at; the pin for a sandbox nobody has
// opened yet is the one file that can be missing.
func (s mirroredPinStore) mirror() error {
	target, err := resolveWSLTarget()
	if err != nil {
		return err
	}
	_, err = mirrorFile(s.knownHostsFile, filepath.Join(target.SSHDir, basedir.SSHKnownHostsName()))
	return err
}

// sessionKeyMaterialPaths names the files the rendered config's mirrored key
// references must be satisfied from. The session config records the identity
// actually in use (an imported key lives outside the default path), so the
// mirror copies that file; the defaults apply only before any session is
// configured.
func sessionKeyMaterialPaths(paths basedir.Paths, state HostsState) (identity, knownHosts string, err error) {
	if state.SessionConfig != nil {
		return state.SessionConfig.IdentityFile, state.SessionConfig.KnownHostsFile, nil
	}
	identity, err = paths.SSHIdentityFile()
	if err != nil {
		return "", "", err
	}
	knownHosts, err = paths.SSHKnownHostsFile()
	if err != nil {
		return "", "", err
	}
	return identity, knownHosts, nil
}

// mirrorFile copies src to dst when src exists, reporting whether it copied.
// The copy is a derived artifact, so it is overwritten wholesale rather than
// merged.
func mirrorFile(src, dst string) (bool, error) {
	data, err := os.ReadFile(src)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read %q: %w", src, err)
	}
	if err := writeFileAtomic(dst, data, 0o600); err != nil {
		return false, err
	}
	return true, nil
}
