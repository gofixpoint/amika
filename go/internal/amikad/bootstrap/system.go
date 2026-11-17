package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// System is the part of the machine bootstrap reads or changes outside the
// filesystem: accounts, commands, and the C library.
type System interface {
	LookupUser(name string) (*user.User, error)
	LookupGroup(name string) (*user.Group, error)
	LookPath(name string) (string, error)
	// Run runs name with args; env adds to the inherited environment.
	Run(ctx context.Context, env []string, name string, args ...string) error
	Chown(path string, uid, gid int) error
	// Glibc returns the glibc version as {major, minor}, or an error on a
	// machine without glibc.
	Glibc() ([2]int, error)
}

// OSSystem is the real machine. Command output goes to Output.
type OSSystem struct {
	Output io.Writer
}

// LookupUser looks name up in the account database.
func (OSSystem) LookupUser(name string) (*user.User, error) { return user.Lookup(name) }

// LookupGroup looks name up in the group database.
func (OSSystem) LookupGroup(name string) (*user.Group, error) { return user.LookupGroup(name) }

// LookPath finds name on PATH, then in the sbin directories a minimal PATH
// often lacks.
func (OSSystem) LookPath(name string) (string, error) {
	if found, err := exec.LookPath(name); err == nil {
		return found, nil
	}
	for _, dir := range []string{"/usr/local/sbin", "/usr/sbin", "/sbin"} {
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", exec.ErrNotFound
}

// Run runs a command and streams its output to s.Output.
func (s OSSystem) Run(ctx context.Context, env []string, name string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Env = append(os.Environ(), env...)
	if s.Output != nil {
		command.Stdout = s.Output
		command.Stderr = s.Output
	}
	return command.Run()
}

// Chown changes a path's owner.
func (OSSystem) Chown(path string, uid, gid int) error { return os.Chown(path, uid, gid) }

var glibcPattern = regexp.MustCompile(`glibc (\d+)\.(\d+)`)

// Glibc asks getconf for the glibc version.
func (OSSystem) Glibc() ([2]int, error) {
	out, err := exec.Command("getconf", "GNU_LIBC_VERSION").Output()
	if err != nil {
		if matches, _ := filepath.Glob("/lib/ld-musl-*"); len(matches) > 0 {
			return [2]int{}, errors.New("the image uses musl")
		}
		return [2]int{}, fmt.Errorf("getconf GNU_LIBC_VERSION: %w", err)
	}
	match := glibcPattern.FindStringSubmatch(strings.TrimSpace(string(out)))
	if match == nil {
		return [2]int{}, fmt.Errorf("unexpected getconf output %q", out)
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	return [2]int{major, minor}, nil
}
