package ssh

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/gofixpoint/amika/go/internal/basedir"
)

// aliasPrefix is prepended to a sandbox id to form its stable SSH host alias.
const aliasPrefix = "amika-"

// managedHeader marks the generated config as owned by amika. The file is fully
// regenerated from the JSON state on every change, so manual edits are lost.
const managedHeader = `# This file is managed by amika. Do not edit by hand.
# It is regenerated from the SSH hosts state on every ` + "`amika sandbox code`" + ` run.
`

// HostEntry is one managed SSH host: a stable alias for a sandbox plus the
// last-known rotating connection details used to render its config block.
type HostEntry struct {
	SandboxID   string `json:"sandbox_id"`
	SandboxName string `json:"sandbox_name"`
	HostName    string `json:"host_name"`
	User        string `json:"user"`
	Port        int    `json:"port,omitempty"`
	ExpiresAt   string `json:"expires_at,omitempty"`
}

// HostsState is the source of truth from which ~/.ssh/amika.conf is rendered.
type HostsState struct {
	Hosts []HostEntry `json:"hosts"`
}

// Alias returns the stable SSH host alias for a sandbox id. Cursor keys its
// Remote-SSH workspace (and agent chat) off this string, so it must depend only
// on the immutable id and never on the rotating connection token.
func Alias(sandboxID string) string {
	return aliasPrefix + sandboxID
}

// Destination is an ssh destination string decomposed into the parts a caller
// needs to rebuild a connection: the user, host, port, and any other ssh options
// (e.g. -i, -F, -o) preserved in their original order. Options excludes the port
// (surfaced separately as Port) and the trailing "[user@]host" target.
type Destination struct {
	User    string
	Host    string
	Port    int
	Options []string
}

// argTakingOptions are the single-letter ssh options (per ssh(1)) that consume
// the following token as their argument, excluding -p which is parsed into Port.
// They are used to group an option with its value while scanning a destination
// so the trailing "[user@]host" target is not mistaken for an option argument.
const argTakingOptions = "bBcDEeFIiJLlmOoQRSWw"

// ParseDestination decomposes an ssh destination string such as
// "token@ssh.app.daytona.io", "-p 2222 user@host", or "-i /key -o Foo=bar host"
// into its user, host, port, and remaining options. The port is returned via
// Port (from "-p PORT" or "-pPORT"); every other option is preserved in Options
// in its original order so a caller can forward it. It errors on a missing port
// value or more than one host.
func ParseDestination(dest string) (Destination, error) {
	var d Destination
	var target string
	fields := strings.Fields(dest)
	for i := 0; i < len(fields); i++ {
		f := fields[i]
		switch {
		case f == "-p":
			if i+1 >= len(fields) {
				return d, fmt.Errorf("ssh destination %q: -p requires a port", dest)
			}
			port, err := strconv.Atoi(fields[i+1])
			if err != nil {
				return d, fmt.Errorf("invalid ssh port %q: %w", fields[i+1], err)
			}
			d.Port = port
			i++
		case len(f) > 2 && strings.HasPrefix(f, "-p") && isAllDigits(f[2:]):
			port, err := strconv.Atoi(f[2:])
			if err != nil {
				return d, fmt.Errorf("invalid ssh port %q: %w", f[2:], err)
			}
			d.Port = port
		case strings.HasPrefix(f, "-"):
			d.Options = append(d.Options, f)
			if consumesFollowingArg(f) && i+1 < len(fields) {
				d.Options = append(d.Options, fields[i+1])
				i++
			}
		default:
			if target != "" {
				return d, fmt.Errorf("ssh destination %q has more than one host", dest)
			}
			target = f
		}
	}
	if target == "" {
		return d, fmt.Errorf("no ssh destination found in %q", dest)
	}
	if at := strings.LastIndex(target, "@"); at >= 0 {
		d.User = target[:at]
		d.Host = target[at+1:]
	} else {
		d.Host = target
	}
	if d.Host == "" {
		return d, fmt.Errorf("no ssh host found in %q", dest)
	}
	return d, nil
}

// consumesFollowingArg reports whether an ssh option token takes the next token
// as its argument. It mirrors getopt: in a bundled cluster only the trailing
// letter can take a value, and it takes the following token only when nothing is
// attached after it ("-i" takes the next token; "-oFoo=bar" carries it inline).
func consumesFollowingArg(tok string) bool {
	if len(tok) < 2 || tok[0] != '-' || tok[1] == '-' {
		return false
	}
	for i := 1; i < len(tok); i++ {
		if strings.IndexByte(argTakingOptions, tok[i]) >= 0 {
			return i == len(tok)-1
		}
	}
	return false
}

// isAllDigits reports whether s is non-empty and all ASCII digits.
func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// NewHostEntry builds a managed host entry for a sandbox from its ssh
// destination string and identity. The destination is parsed (rather than
// split on whitespace) so an explicit port survives into the rendered config.
func NewHostEntry(sandboxID, sandboxName, destination, expiresAt string) (HostEntry, error) {
	d, err := ParseDestination(destination)
	if err != nil {
		return HostEntry{}, err
	}
	return HostEntry{
		SandboxID:   sandboxID,
		SandboxName: sandboxName,
		HostName:    d.Host,
		User:        d.User,
		Port:        d.Port,
		ExpiresAt:   expiresAt,
	}, nil
}

// Upsert adds or replaces the entry for a sandbox id, keeping entries sorted by
// id so the rendered config is deterministic.
func (s *HostsState) Upsert(entry HostEntry) {
	for i, h := range s.Hosts {
		if h.SandboxID == entry.SandboxID {
			s.Hosts[i] = entry
			return
		}
	}
	s.Hosts = append(s.Hosts, entry)
	sort.Slice(s.Hosts, func(i, j int) bool {
		return s.Hosts[i].SandboxID < s.Hosts[j].SandboxID
	})
}

// Render produces the contents of ~/.ssh/amika.conf from the state. Each block
// is a stable `Host amika-<id>` alias preceded by the sandbox name as a comment
// so the file stays human-readable even though it is keyed by id.
func Render(state HostsState) string {
	var b strings.Builder
	b.WriteString(managedHeader)
	for _, h := range state.Hosts {
		b.WriteString("\n")
		if h.SandboxName != "" {
			fmt.Fprintf(&b, "# %s\n", h.SandboxName)
		}
		fmt.Fprintf(&b, "Host %s\n", Alias(h.SandboxID))
		fmt.Fprintf(&b, "  HostName %s\n", h.HostName)
		if h.User != "" {
			fmt.Fprintf(&b, "  User %s\n", h.User)
		}
		if h.Port != 0 {
			fmt.Fprintf(&b, "  Port %d\n", h.Port)
		}
		b.WriteString("  StrictHostKeyChecking accept-new\n")
	}
	return b.String()
}

// LoadState reads the SSH hosts state, returning an empty state if the file does
// not exist yet.
func LoadState(paths basedir.Paths) (HostsState, error) {
	var state HostsState
	path, err := paths.SSHHostsStateFile()
	if err != nil {
		return state, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return state, nil
		}
		return state, fmt.Errorf("read ssh hosts state: %w", err)
	}
	if len(data) == 0 {
		return state, nil
	}
	if err := json.Unmarshal(data, &state); err != nil {
		return state, fmt.Errorf("parse ssh hosts state %q: %w", path, err)
	}
	return state, nil
}

// SaveState writes the SSH hosts state atomically with owner-only permissions.
func SaveState(paths basedir.Paths, state HostsState) error {
	path, err := paths.SSHHostsStateFile()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode ssh hosts state: %w", err)
	}
	return writeFileAtomic(path, append(data, '\n'), 0o600)
}

// WriteAmikaConfig renders the state to ~/.ssh/amika.conf atomically.
func WriteAmikaConfig(paths basedir.Paths, state HostsState) error {
	path, err := paths.SSHAmikaConfigFile()
	if err != nil {
		return err
	}
	return writeFileAtomic(path, []byte(Render(state)), 0o600)
}

// EnsureInclude makes sure ~/.ssh/config pulls in the managed amika.conf via an
// Include directive near the top (Include must precede Host blocks to take
// effect, since ssh resolves options first-match-wins). It is idempotent and
// creates ~/.ssh/config if absent.
func EnsureInclude(paths basedir.Paths) error {
	configPath, err := paths.SSHConfigFile()
	if err != nil {
		return err
	}
	writePath, err := resolveWriteTarget(configPath)
	if err != nil {
		return err
	}
	includeLine := "Include " + basedir.SSHAmikaConfigName()

	existing, err := os.ReadFile(configPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read ssh config: %w", err)
	}
	if hasIncludeLine(string(existing), includeLine) {
		return nil
	}

	var content string
	if len(existing) == 0 {
		content = includeLine + "\n"
	} else {
		content = includeLine + "\n\n" + string(existing)
	}
	return writeFileAtomic(writePath, []byte(content), 0o600)
}

// hasIncludeLine reports whether the config already includes the managed file.
func hasIncludeLine(content, includeLine string) bool {
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		if strings.EqualFold(strings.TrimSpace(scanner.Text()), includeLine) {
			return true
		}
	}
	return false
}

// UpsertHost records (or refreshes) the managed SSH host for a sandbox: it
// updates the JSON state, regenerates ~/.ssh/amika.conf, ensures ~/.ssh/config
// includes it, and returns the stable alias to connect to. This is the single
// entry point editors use so connection details stay behind one seam.
func UpsertHost(paths basedir.Paths, entry HostEntry) (string, error) {
	state, err := LoadState(paths)
	if err != nil {
		return "", err
	}
	state.Upsert(entry)
	if err := SaveState(paths, state); err != nil {
		return "", err
	}
	if err := WriteAmikaConfig(paths, state); err != nil {
		return "", err
	}
	if err := EnsureInclude(paths); err != nil {
		return "", err
	}
	return Alias(entry.SandboxID), nil
}

// writeFileAtomic writes data to path via a temp file + rename so a concurrent
// run never observes a half-written file. The parent directory is created with
// owner-only permissions.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %q: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".amika-*")
	if err != nil {
		return fmt.Errorf("create temp file in %q: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write %q: %w", tmpName, err)
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod %q: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %q: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename %q to %q: %w", tmpName, path, err)
	}
	return nil
}

func resolveWriteTarget(path string) (string, error) {
	resolved := path
	for i := 0; i < 32; i++ {
		info, err := os.Lstat(resolved)
		if err != nil {
			if os.IsNotExist(err) {
				return resolved, nil
			}
			return "", fmt.Errorf("stat %q: %w", resolved, err)
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return resolved, nil
		}

		target, err := os.Readlink(resolved)
		if err != nil {
			return "", fmt.Errorf("read symlink %q: %w", resolved, err)
		}
		if target == "" {
			return "", fmt.Errorf("symlink %q has empty target", resolved)
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(resolved), target)
		}
		resolved = filepath.Clean(target)
	}
	return "", fmt.Errorf("too many symlinks resolving %q", path)
}
