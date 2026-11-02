package sshd

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/amikad/platform"
	"github.com/gofixpoint/amika/go/internal/amikad/state"
)

// strictModesPlatform records the StrictModes check instead of walking the
// real ancestors: t.TempDir lives under the world-writable /tmp, which sshd
// (and the real check) rightly refuses.
type strictModesPlatform struct {
	platform.Platform
	checked string
	err     error
}

func (p *strictModesPlatform) CheckStrictModesPath(directory string, _ int) error {
	p.checked = directory
	return p.err
}

func testUserManager(t *testing.T) (*Manager, Paths, *strictModesPlatform) {
	t.Helper()
	stateDirectory := filepath.Join(realTempDir(t), "amikad")
	if err := os.Mkdir(stateDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	paths := UserPaths(stateDirectory, "Operator", 41002)
	paths.SSHD = "/usr/sbin/sshd"
	files := state.OSFiles{}
	store := state.NewStore(filepath.Join(stateDirectory, "injected-paths.json"), files)
	manager := NewManager(paths, store, files, &fakeKeyGenerator{}, &fakeProcessRunner{})
	fake := &strictModesPlatform{Platform: platform.Current()}
	manager.platform = fake
	return manager, paths, fake
}

func TestRenderConfigAllowsOnlyTheManagedUser(t *testing.T) {
	t.Setenv(EnvManagedUser, "")
	paths := DefaultPaths()
	if !strings.Contains(RenderConfig(paths), "\nAllowUsers amika\n") {
		t.Fatalf("default config does not admit amika:\n%s", RenderConfig(paths))
	}
	t.Setenv(EnvManagedUser, "builder")
	paths = DefaultPaths()
	config := RenderConfig(paths)
	if !strings.Contains(config, "\nAllowUsers builder\n") || strings.Contains(config, "AllowUsers amika") {
		t.Fatalf("AllowUsers does not follow %s:\n%s", EnvManagedUser, config)
	}
	if paths.AuthorizedKeys != "/home/builder/.ssh/authorized_keys" {
		t.Fatalf("authorized keys = %q", paths.AuthorizedKeys)
	}
}

func TestValidateAllowUser(t *testing.T) {
	for _, name := range []string{"amika", "Operator", "first.last", "user_1", "a-b"} {
		if err := ValidateAllowUser(name); err != nil {
			t.Errorf("ValidateAllowUser(%q) = %v, want nil", name, err)
		}
	}
	for _, name := range []string{
		"", "-amika", "two words", "tab\tname", "new\nline", "user@host", "a*", "a?", "!amika", "a,b",
		`"amika"`, "a#b", "a%u", `a\b`, strings.Repeat("a", 257),
	} {
		if err := ValidateAllowUser(name); !errors.Is(err, ErrInvalidAllowUser) {
			t.Errorf("ValidateAllowUser(%q) = %v, want ErrInvalidAllowUser", name, err)
		}
	}
}

func TestUserModeSetupKeepsStateInStateDirectory(t *testing.T) {
	skipUnlessSecureWrites(t)
	manager, paths, fake := testUserManager(t)
	if err := manager.Setup(context.Background(), SetupOptions{ForceOverwrite: true}); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	if fake.checked != filepath.Dir(paths.AuthorizedKeys) {
		t.Fatalf("StrictModes checked %q, want %q", fake.checked, filepath.Dir(paths.AuthorizedKeys))
	}
	config, err := os.ReadFile(paths.Config)
	if err != nil {
		t.Fatal(err)
	}
	for _, directive := range []string{
		"Port 41002",
		"ListenAddress 127.0.0.1",
		"AllowUsers Operator",
		"AuthorizedKeysFile " + paths.AuthorizedKeys,
		"PidFile " + paths.PID,
		"UsePAM no",
	} {
		if !strings.Contains(string(config), directive+"\n") {
			t.Fatalf("config missing %q:\n%s", directive, config)
		}
	}

	key := newTestAuthorizedKey(t)
	if err := manager.SetAuthorizedKeys(context.Background(), strings.NewReader(key+"\n")); err != nil {
		t.Fatalf("SetAuthorizedKeys: %v", err)
	}
	got, err := os.ReadFile(paths.AuthorizedKeys)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != key+"\n" {
		t.Fatalf("authorized keys = %q", got)
	}
	info, err := os.Stat(paths.AuthorizedKeys)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("authorized keys mode = %o, want 600", info.Mode().Perm())
	}
	if err := manager.ClearAuthorizedKeys(context.Background()); err != nil {
		t.Fatalf("ClearAuthorizedKeys: %v", err)
	}
}

func TestUserModeSetupFailsWhenStrictModesWouldRejectKeys(t *testing.T) {
	skipUnlessSecureWrites(t)
	manager, paths, fake := testUserManager(t)
	fake.err = platform.ErrInsecureDirectory
	if err := manager.Setup(context.Background(), SetupOptions{}); !errors.Is(err, platform.ErrInsecureDirectory) {
		t.Fatalf("Setup error = %v, want ErrInsecureDirectory", err)
	}
	if _, err := os.Stat(paths.Config); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config written despite insecure directory: %v", err)
	}
}
