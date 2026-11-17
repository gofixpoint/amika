// Package bootstrap installs the Amika runtime onto a rig that booted the
// provider's own image instead of an Amika base image: sudo, the rig user
// and its sudo rule, the directories amikad and the lifecycle hooks use, and
// the hooks themselves. OpenSSH server, when the image lacks it, is a default of
// `amikad install` (EnsureOpenSSHServer).
//
// It is what the base image's runtime steps do (sandbox-image/steps 50 and
// 70), run at create instead of at image build, and it is idempotent: the
// control plane runs it on every create and start of such a rig, and a run
// on a bootstrapped machine changes nothing.
package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/user"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// User is the rig user on every provider. The embedded lifecycle hooks name
// it, so it is not configurable.
const User = "amika"

// MarkerPath records the amikad version that last bootstrapped the machine.
const MarkerPath = "/var/lib/amikad/runtime-version"

// minimumGlibc is the oldest glibc the toolchain's prebuilt binaries (Node,
// gh, the agent CLIs) run on.
var minimumGlibc = [2]int{2, 28}

// Options configures a bootstrap run.
type Options struct {
	// Home is the home directory given to User when bootstrap creates it;
	// an existing user keeps its own. Defaults to /home/amika.
	Home string
	// Version is written to MarkerPath.
	Version string
}

// Bootstrapper runs the bootstrap against a filesystem root and a system.
type Bootstrapper struct {
	// Root prefixes every path written; "/" in production.
	Root string
	// System runs commands and looks up accounts.
	System System
	// Hooks are the lifecycle hooks written to /usr/lib/amikad.
	Hooks fs.FS
	// Log receives one line per change.
	Log io.Writer
}

// ErrUnsupportedImage marks an image amikad cannot install the runtime on.
var ErrUnsupportedImage = errors.New("unsupported image")

// Run installs whatever of the runtime is missing.
func (b *Bootstrapper) Run(ctx context.Context, options Options) error {
	options = withDefaults(options)
	if err := b.checkLibc(); err != nil {
		return err
	}
	// The lifecycle hooks run their steps through sudo.
	if _, err := b.ensureCommand(ctx, "sudo", "sudo", nil); err != nil {
		return err
	}
	account, err := b.ensureUser(ctx, options)
	if err != nil {
		return err
	}
	if err := b.ensureDirectories(account); err != nil {
		return err
	}
	if err := b.writeHooks(); err != nil {
		return err
	}
	return b.writeFile(MarkerPath, []byte(options.Version+"\n"), 0o644, false)
}

func withDefaults(options Options) Options {
	if options.Home == "" {
		options.Home = "/home/" + User
	}
	return options
}

func (b *Bootstrapper) path(p string) string {
	return filepath.Join(b.Root, filepath.FromSlash(p))
}

func (b *Bootstrapper) logf(format string, args ...any) {
	if b.Log != nil {
		fmt.Fprintf(b.Log, format+"\n", args...)
	}
}

func (b *Bootstrapper) checkLibc() error {
	version, err := b.System.Glibc()
	if err != nil {
		return fmt.Errorf("%w: needs glibc %d.%d or newer (musl images such as Alpine are not supported): %v",
			ErrUnsupportedImage, minimumGlibc[0], minimumGlibc[1], err)
	}
	if version[0] < minimumGlibc[0] || (version[0] == minimumGlibc[0] && version[1] < minimumGlibc[1]) {
		return fmt.Errorf("%w: glibc %d.%d is older than %d.%d",
			ErrUnsupportedImage, version[0], version[1], minimumGlibc[0], minimumGlibc[1])
	}
	return nil
}

// sshdPaths are where images ship sshd when it is not on PATH.
var sshdPaths = []string{"/usr/sbin/sshd", "/usr/bin/sshd"}

// EnsureOpenSSHServer installs OpenSSH server with the image's package
// manager when the image has no sshd, and reports whether it did. amikad
// runs its own sshd on loopback and never uses the system's service.
func (b *Bootstrapper) EnsureOpenSSHServer(ctx context.Context) (bool, error) {
	return b.ensureCommand(ctx, "sshd", "openssh-server", sshdPaths)
}

// ensureCommand installs pkg with the image's package manager when command
// is neither on PATH nor at one of paths, and reports whether it did.
func (b *Bootstrapper) ensureCommand(ctx context.Context, command, pkg string, paths []string) (bool, error) {
	if _, err := b.System.LookPath(command); err == nil {
		return false, nil
	}
	for _, p := range paths {
		if _, err := os.Stat(b.path(p)); err == nil {
			return false, nil
		}
	}
	b.logf("installing %s", pkg)
	switch {
	case b.hasManager("apt-get"):
		env := []string{"DEBIAN_FRONTEND=noninteractive"}
		if err := b.System.Run(ctx, env, "apt-get", "update", "-q"); err != nil {
			return false, fmt.Errorf("apt-get update: %w", err)
		}
		if err := b.System.Run(ctx, env, "apt-get", "install", "-y", "-q", "--no-install-recommends", pkg); err != nil {
			return false, fmt.Errorf("apt-get install %s: %w", pkg, err)
		}
	case b.hasManager("dnf"):
		if err := b.System.Run(ctx, nil, "dnf", "install", "-y", "-q", pkg); err != nil {
			return false, fmt.Errorf("dnf install %s: %w", pkg, err)
		}
	default:
		return false, fmt.Errorf("%w: no %s, and no apt-get or dnf to install %s", ErrUnsupportedImage, command, pkg)
	}
	return true, nil
}

func (b *Bootstrapper) hasManager(name string) bool {
	_, err := b.System.LookPath(name)
	return err == nil
}

// ensureUser returns the rig user, creating it, its group, and its sudo
// rule when missing.
func (b *Bootstrapper) ensureUser(ctx context.Context, options Options) (*user.User, error) {
	account, err := b.System.LookupUser(User)
	if err == nil {
		uid, convErr := strconv.Atoi(account.Uid)
		if convErr != nil {
			return nil, fmt.Errorf("uid of %s: %w", User, convErr)
		}
		if err := checkHome(account.HomeDir); err != nil {
			return nil, err
		}
		if err := b.refuseForeignHome(account.HomeDir, uid); err != nil {
			return nil, err
		}
	} else {
		if err := checkHome(options.Home); err != nil {
			return nil, err
		}
		if err := b.refuseForeignHome(options.Home, -1); err != nil {
			return nil, err
		}
		if _, groupErr := b.System.LookupGroup(User); groupErr != nil {
			if err := b.System.Run(ctx, nil, "groupadd", User); err != nil {
				return nil, fmt.Errorf("groupadd %s: %w", User, err)
			}
		}
		b.logf("creating user %s with home %s", User, options.Home)
		if err := b.System.Run(ctx, nil, "useradd", "-m", "-d", options.Home, "-s", "/bin/bash", "-g", User, User); err != nil {
			return nil, fmt.Errorf("useradd %s: %w", User, err)
		}
		if account, err = b.System.LookupUser(User); err != nil {
			return nil, fmt.Errorf("look up %s after useradd: %w", User, err)
		}
	}
	rule := []byte(User + " ALL=(ALL) NOPASSWD:ALL\n")
	if err := b.writeFile("/etc/sudoers.d/90-"+User, rule, 0o440, false); err != nil {
		return nil, err
	}
	return account, nil
}

// systemDirectories are top-level directories that are never a home: the
// hooks change the ownership of the whole home.
var systemDirectories = map[string]bool{
	"bin": true, "boot": true, "dev": true, "etc": true, "lib": true,
	"lib32": true, "lib64": true, "proc": true, "run": true, "sbin": true,
	"sys": true, "usr": true,
}

// checkHome refuses a home that is not a dedicated directory: not absolute
// or not clean, /, a top-level directory, or one inside a system directory.
// Bootstrap gives the home to amika, and the hooks change the ownership of
// everything under it.
func checkHome(home string) error {
	parts := strings.Split(strings.TrimPrefix(home, "/"), "/")
	if !path.IsAbs(home) || path.Clean(home) != home || len(parts) < 2 || systemDirectories[parts[0]] {
		return fmt.Errorf("%w: %q is not a safe home for %s; it must be a dedicated directory such as /home/%s",
			ErrUnsupportedImage, home, User, User)
	}
	return nil
}

// refuseForeignHome stops bootstrap when home belongs to a user other than
// root or amika (uid amikaUID, or -1 before amika exists): the hooks change
// the ownership of amika's whole home, and Amika never takes over another
// user's home.
func (b *Bootstrapper) refuseForeignHome(home string, amikaUID int) error {
	uid, _, err := b.System.Owner(b.path(home))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("owner of %s: %w", home, err)
	}
	if uid == 0 || uid == amikaUID {
		return nil
	}
	return fmt.Errorf("%w: %s belongs to uid %d, and %s cannot take over another user's home",
		ErrUnsupportedImage, home, uid, User)
}

type directory struct {
	path      string
	mode      os.FileMode
	userOwned bool
	// keepMode leaves an existing directory's mode alone: the home keeps the
	// mode the provider gave it.
	keepMode bool
	// allowLink accepts a symlink to a directory. Only the home does: sshd
	// refuses a symlinked .ssh, and amikad never replaces what it did not
	// create.
	allowLink bool
}

// ensureDirectories creates what the image's step 50 creates.
func (b *Bootstrapper) ensureDirectories(account *user.User) error {
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return fmt.Errorf("uid of %s: %w", account.Username, err)
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return fmt.Errorf("gid of %s: %w", account.Username, err)
	}
	home := account.HomeDir
	directories := []directory{
		{path: home, mode: 0o755, userOwned: true, keepMode: true, allowLink: true},
		{path: path.Join(home, ".ssh"), mode: 0o700, userOwned: true},
		{path: path.Join(home, "workspace"), mode: 0o755, userOwned: true},
		{path: "/var/log/amika", mode: 0o755, userOwned: true},
		{path: "/usr/lib/amika", mode: 0o755, userOwned: true},
		{path: "/usr/local/etc/amika", mode: 0o755, userOwned: true},
		{path: "/var/lib/amika", mode: 0o755, userOwned: true},
		{path: "/var/log/amikad", mode: 0o755},
		{path: "/usr/lib/amikad", mode: 0o755},
		{path: "/usr/local/etc/amikad/setup", mode: 0o755},
		{path: "/var/lib/amikad", mode: 0o755},
		{path: "/run/sshd", mode: 0o755},
	}
	for _, dir := range directories {
		owner := [2]int{0, 0}
		if dir.userOwned {
			owner = [2]int{uid, gid}
		}
		if err := b.ensureDirectory(dir, owner); err != nil {
			return err
		}
	}
	for _, script := range []string{"setup.sh", "start.sh"} {
		if err := b.writeFile("/usr/local/etc/amikad/setup/"+script, []byte("exit 0\n"), 0o755, true); err != nil {
			return err
		}
	}
	return nil
}

// ensureDirectory creates dir, or repairs an existing one: an image can ship
// one of these directories with another mode or owner, and amikad's sshd
// refuses a .ssh that is not 0700. It changes nothing that is already right.
func (b *Bootstrapper) ensureDirectory(dir directory, owner [2]int) error {
	target := b.path(dir.path)
	info, err := os.Lstat(target)
	if err == nil && info.Mode()&os.ModeSymlink != 0 {
		if !dir.allowLink {
			return fmt.Errorf("%w: %s is a symlink; amikad needs a real directory there", ErrUnsupportedImage, dir.path)
		}
		info, err = os.Stat(target)
	}
	created := errors.Is(err, fs.ErrNotExist)
	switch {
	case created:
		if err := os.MkdirAll(target, dir.mode); err != nil {
			return err
		}
		if info, err = os.Stat(target); err != nil {
			return err
		}
	case err != nil:
		return err
	case !info.IsDir():
		return fmt.Errorf("%s exists and is not a directory", dir.path)
	}
	if (created || !dir.keepMode) && info.Mode().Perm() != dir.mode {
		if err := os.Chmod(target, dir.mode); err != nil {
			return err
		}
		if !created {
			b.logf("set the mode of %s to %o", dir.path, dir.mode)
		}
	}
	uid, gid, err := b.System.Owner(target)
	if err != nil {
		return fmt.Errorf("owner of %s: %w", dir.path, err)
	}
	if uid != owner[0] || gid != owner[1] {
		if err := b.System.Chown(target, owner[0], owner[1]); err != nil {
			return fmt.Errorf("chown %s: %w", dir.path, err)
		}
	}
	return nil
}

// writeHooks installs every embedded hook script, replacing older copies:
// the hooks belong to the amikad version that ships them.
func (b *Bootstrapper) writeHooks() error {
	entries, err := fs.ReadDir(b.Hooks, ".")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sh") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		data, err := fs.ReadFile(b.Hooks, name)
		if err != nil {
			return err
		}
		if err := b.writeFile("/usr/lib/amikad/"+name, data, 0o755, false); err != nil {
			return err
		}
	}
	return nil
}

// ensureFileMode sets p's mode when it differs: a hook with the right
// content but no execute bit still fails to run.
func (b *Bootstrapper) ensureFileMode(p string, mode os.FileMode) error {
	target := b.path(p)
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	if info.Mode().Perm() == mode {
		return nil
	}
	b.logf("set the mode of %s to %o", p, mode)
	return os.Chmod(target, mode)
}

// writeFile writes data to p unless it already holds exactly data. With
// keepExisting, an existing file's content is left alone whatever it holds
// (the user's setup.sh, for example). Either way, the mode is set.
func (b *Bootstrapper) writeFile(p string, data []byte, mode os.FileMode, keepExisting bool) error {
	target := b.path(p)
	if current, err := os.ReadFile(target); err == nil {
		if keepExisting || string(current) == string(data) {
			return b.ensureFileMode(p, mode)
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	temporary := filepath.Join(filepath.Dir(target), ".amikad-"+filepath.Base(target))
	if err := os.WriteFile(temporary, data, mode); err != nil {
		return err
	}
	if err := os.Chmod(temporary, mode); err != nil {
		os.Remove(temporary)
		return err
	}
	b.logf("wrote %s", p)
	return os.Rename(temporary, target)
}
