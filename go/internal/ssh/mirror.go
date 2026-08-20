package ssh

// mirror.go renders and writes the Windows-side copy of the managed SSH
// config for WSL setups, where amika runs in WSL but the editors that need
// the connection state run as Windows applications.

import (
	"errors"
	"fmt"
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
	blocks, err := renderWindowsSessionBlocks(state, target)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	writeManagedConfig(&b, state, blocks)
	return b.String(), nil
}

// renderWindowsSessionBlocks renders one wildcard block per control plane,
// rebuilding each ProxyCommand as its wsl.exe equivalent and pointing the key
// material at the mirrored copies in the Windows .ssh directory.
func renderWindowsSessionBlocks(state HostsState, target wslbridge.Target) ([]string, error) {
	if state.SessionConfig == nil {
		return nil, nil
	}
	environments := make([]string, 0, len(state.SessionProxyCommands))
	for environment := range state.SessionProxyCommands {
		environments = append(environments, environment)
	}
	sort.Strings(environments)
	blocks := make([]string, 0, len(environments))
	for _, environment := range environments {
		binaryPath, err := ParseProxyCommand(state.SessionProxyCommands[environment])
		if err != nil {
			return nil, fmt.Errorf("environment %s: %w", environment, err)
		}
		proxyCommand, err := BuildWSLProxyCommand(target.Distro, binaryPath)
		if err != nil {
			return nil, fmt.Errorf("environment %s: %w", environment, err)
		}
		blocks = append(blocks, renderSessionBlock(
			environment,
			proxyCommand,
			quoteWindowsPath(target.SSHDirWindows+"\\"+basedir.SSHIdentityName()),
			quoteWindowsPath(target.SSHDirWindows+"\\"+basedir.SSHKnownHostsName()),
		))
	}
	return blocks, nil
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

	identityPath, err := paths.SSHIdentityFile()
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

	knownHostsPath, err := paths.SSHKnownHostsFile()
	if err != nil {
		return err
	}
	_, err = mirrorFile(knownHostsPath, filepath.Join(target.SSHDir, basedir.SSHKnownHostsName()))
	return err
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
