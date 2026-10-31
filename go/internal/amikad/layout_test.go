package amikad

import (
	"errors"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/constants"
)

func testEnv(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func testUser(name string) func() (*user.User, error) {
	return func() (*user.User, error) { return &user.User{Username: name}, nil }
}

func TestResolveLayoutWithoutStateDirIsRootMode(t *testing.T) {
	layout, err := ResolveLayout(testEnv(nil), testUser("operator"))
	if err != nil {
		t.Fatalf("ResolveLayout: %v", err)
	}
	if layout.UserMode {
		t.Fatal("root layout reported user mode")
	}
	if layout.ManifestPath != "/var/lib/amikad/injected-paths.json" ||
		layout.TokenPath != "/var/lib/amikad/connect-token" ||
		layout.ServeLogPath != "/var/log/amikad/no-relay.log" {
		t.Fatalf("root paths changed: %+v", layout)
	}
	if layout.SSHD.Unprivileged || layout.SSHD.Port != constants.ManagedSSHDPort {
		t.Fatalf("root sshd paths changed: %+v", layout.SSHD)
	}
	listen := (&DaemonOperations{layout: layout}).resolveListen(DefaultPort)
	if listen.bind != ":60999" || listen.port != DefaultPort || listen.probe != "127.0.0.1:60999" {
		t.Fatalf("root listen = %+v, want every interface on --port", listen)
	}
}

func TestResolveLayoutRefusesUserModeVariablesWithoutStateDir(t *testing.T) {
	for _, name := range []string{EnvListen, EnvSSHDPort} {
		_, err := ResolveLayout(testEnv(map[string]string{name: "127.0.0.1:1234"}), testUser("operator"))
		if !errors.Is(err, ErrInvalidEnvironment) {
			t.Fatalf("%s without %s: error = %v, want ErrInvalidEnvironment", name, EnvStateDir, err)
		}
	}
}

func TestResolveUserLayoutKeepsAllStateInStateDir(t *testing.T) {
	stateDirectory := "/srv/hostd/amikad"
	layout, err := ResolveLayout(testEnv(map[string]string{
		EnvStateDir: stateDirectory + "/",
		EnvListen:   "127.0.0.1:41001",
		EnvSSHDPort: "41002",
	}), testUser("Operator"))
	if err != nil {
		t.Fatalf("ResolveLayout: %v", err)
	}
	if !layout.UserMode || !layout.SSHD.Unprivileged {
		t.Fatalf("layout = %+v, want user mode", layout)
	}
	for _, path := range []string{
		layout.ManifestPath,
		layout.TokenPath,
		layout.ServeLogPath,
		layout.SSHD.Config,
		layout.SSHD.HostPrivateKey,
		layout.SSHD.HostPublicKey,
		layout.SSHD.AuthorizedKeys,
		layout.SSHD.PID,
	} {
		if !strings.HasPrefix(path, stateDirectory+"/") {
			t.Fatalf("user-mode path %q escapes %s", path, stateDirectory)
		}
	}
	if layout.SSHD.AuthorizedKeys != filepath.Join(stateDirectory, "authorized_keys") {
		t.Fatalf("authorized keys = %q, want a file in the state directory", layout.SSHD.AuthorizedKeys)
	}
	if layout.SSHD.RuntimeDirectory != "" {
		t.Fatalf("user mode must not create a privsep directory, got %q", layout.SSHD.RuntimeDirectory)
	}
	if layout.SSHD.AllowUser != "Operator" || layout.SSHD.Port != 41002 {
		t.Fatalf("sshd = %+v, want AllowUser Operator on port 41002", layout.SSHD)
	}
	listen := (&DaemonOperations{layout: layout}).resolveListen(DefaultPort)
	if listen.bind != "127.0.0.1:41001" || listen.port != 41001 || listen.probe != "127.0.0.1:41001" {
		t.Fatalf("user listen = %+v, want AMIKAD_LISTEN to override --port", listen)
	}
}

func TestResolveUserLayoutDefaultsToLoopbackOnServePort(t *testing.T) {
	layout, err := ResolveLayout(testEnv(map[string]string{EnvStateDir: "/srv/amikad"}), testUser("operator"))
	if err != nil {
		t.Fatalf("ResolveLayout: %v", err)
	}
	listen := (&DaemonOperations{layout: layout}).resolveListen(4242)
	if listen.bind != "127.0.0.1:4242" || listen.port != 4242 {
		t.Fatalf("user listen = %+v, want loopback on --port", listen)
	}
	if layout.SSHD.Port != constants.ManagedSSHDPort {
		t.Fatalf("sshd port = %d, want default %d", layout.SSHD.Port, constants.ManagedSSHDPort)
	}
}

func TestResolveUserLayoutListenMustBeLoopbackIP(t *testing.T) {
	for _, listen := range []string{
		"0.0.0.0:41001",
		":41001",
		"10.0.0.5:41001",
		"localhost:41001",
		"[::]:41001",
		"127.0.0.1",
		"127.0.0.1:0",
		"127.0.0.1:70000",
	} {
		_, err := ResolveLayout(testEnv(map[string]string{
			EnvStateDir: "/srv/amikad",
			EnvListen:   listen,
		}), testUser("operator"))
		if !errors.Is(err, ErrInvalidEnvironment) {
			t.Errorf("AMIKAD_LISTEN=%q: error = %v, want ErrInvalidEnvironment", listen, err)
		}
	}
	for listen, bind := range map[string]string{
		"127.0.0.1:41001": "127.0.0.1:41001",
		"127.0.0.9:41001": "127.0.0.9:41001",
		"[::1]:41001":     "[::1]:41001",
	} {
		layout, err := ResolveLayout(testEnv(map[string]string{
			EnvStateDir: "/srv/amikad",
			EnvListen:   listen,
		}), testUser("operator"))
		if err != nil {
			t.Fatalf("AMIKAD_LISTEN=%q: %v", listen, err)
		}
		if got := (&DaemonOperations{layout: layout}).resolveListen(DefaultPort).bind; got != bind {
			t.Fatalf("AMIKAD_LISTEN=%q bind = %q, want %q", listen, got, bind)
		}
	}
}

func TestResolveUserLayoutRejectsUnsafeConfiguration(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"relative state dir": {EnvStateDir: "amikad"},
		"bad sshd port":      {EnvStateDir: "/srv/amikad", EnvSSHDPort: "ssh"},
		"zero sshd port":     {EnvStateDir: "/srv/amikad", EnvSSHDPort: "0"},
		"shared port":        {EnvStateDir: "/srv/amikad", EnvListen: "127.0.0.1:5000", EnvSSHDPort: "5000"},
		"space in path":      {EnvStateDir: "/Users/x/Library/Application Support/amikad"},
		"percent in path":    {EnvStateDir: "/srv/100%/amikad"},
		"newline in path":    {EnvStateDir: "/srv/a\nb/amikad"},
		"apostrophe in path": {EnvStateDir: "/home/o'neil/amikad"},
		"backslash in path":  {EnvStateDir: `/srv/a\b/amikad`},
	} {
		if _, err := ResolveLayout(testEnv(env), testUser("operator")); !errors.Is(err, ErrInvalidEnvironment) {
			t.Errorf("%s: error = %v, want ErrInvalidEnvironment", name, err)
		}
	}
	if _, err := ResolveLayout(
		testEnv(map[string]string{EnvStateDir: "/srv/amikad"}),
		testUser("evil user"),
	); err == nil {
		t.Fatal("account name with whitespace was accepted for AllowUsers")
	}
}

func TestPrepareStateDirectoryCreatesOwnerOnlyDirectory(t *testing.T) {
	stateDirectory := filepath.Join(realTempDir(t), "amikad")
	if err := os.Mkdir(stateDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	layout, err := ResolveLayout(testEnv(map[string]string{EnvStateDir: stateDirectory}), testUser("operator"))
	if err != nil {
		t.Fatal(err)
	}
	if err := PrepareStateDirectory(layout); err != nil {
		t.Fatalf("PrepareStateDirectory: %v", err)
	}
	info, err := os.Stat(stateDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("state directory mode = %o, want 700", info.Mode().Perm())
	}

	link := filepath.Join(realTempDir(t), "link")
	if err := os.Symlink(stateDirectory, link); err != nil {
		t.Fatal(err)
	}
	layout, err = ResolveLayout(testEnv(map[string]string{EnvStateDir: link}), testUser("operator"))
	if err != nil {
		t.Fatal(err)
	}
	if err := PrepareStateDirectory(layout); !errors.Is(err, ErrInvalidEnvironment) {
		t.Fatalf("symlinked state directory: error = %v, want ErrInvalidEnvironment", err)
	}
}

func TestResolveUserLayoutResolvesSymlinkedParents(t *testing.T) {
	// /home on Fedora Silverblue and /var on macOS are symlinks the operator
	// does not control; the secure writes refuse any symlink in a path.
	target := realTempDir(t)
	linked := filepath.Join(realTempDir(t), "home")
	if err := os.Symlink(target, linked); err != nil {
		t.Fatal(err)
	}
	layout, err := ResolveLayout(testEnv(map[string]string{
		EnvStateDir: filepath.Join(linked, "amikad"),
	}), testUser("operator"))
	if err != nil {
		t.Fatalf("ResolveLayout: %v", err)
	}
	if want := filepath.Join(target, "amikad", "connect-token"); layout.TokenPath != want {
		t.Fatalf("token path = %q, want %q under the resolved parent", layout.TokenPath, want)
	}
}

func TestResolveUserLayoutKeepsFinalSymlinkUnresolved(t *testing.T) {
	stateDirectory := filepath.Join(realTempDir(t), "amikad")
	if err := os.Symlink(realTempDir(t), stateDirectory); err != nil {
		t.Fatal(err)
	}
	layout, err := ResolveLayout(testEnv(map[string]string{EnvStateDir: stateDirectory}), testUser("operator"))
	if err != nil {
		t.Fatalf("ResolveLayout: %v", err)
	}
	// The state directory itself stays as named, so preparing it still finds
	// and refuses the symlink.
	if want := filepath.Join(stateDirectory, "connect-token"); layout.TokenPath != want {
		t.Fatalf("token path = %q, want %q", layout.TokenPath, want)
	}
}
