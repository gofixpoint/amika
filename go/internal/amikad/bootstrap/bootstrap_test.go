package bootstrap

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// fakeSystem records commands and serves accounts and commands from maps.
type fakeSystem struct {
	users    map[string]*user.User
	groups   map[string]bool
	commands map[string]bool
	glibc    [2]int
	glibcErr error
	runs     []string
	chowns   []string
}

func newFakeSystem() *fakeSystem {
	return &fakeSystem{
		users:    map[string]*user.User{},
		groups:   map[string]bool{},
		commands: map[string]bool{"sshd": true, "git": true, "sudo": true, "curl": true, "apt-get": true},
		glibc:    [2]int{2, 39},
	}
}

func (f *fakeSystem) LookupUser(name string) (*user.User, error) {
	if account, ok := f.users[name]; ok {
		return account, nil
	}
	return nil, user.UnknownUserError(name)
}

func (f *fakeSystem) LookupGroup(name string) (*user.Group, error) {
	if f.groups[name] {
		return &user.Group{Name: name, Gid: "1000"}, nil
	}
	return nil, user.UnknownGroupError(name)
}

func (f *fakeSystem) LookPath(name string) (string, error) {
	if f.commands[name] {
		return "/usr/bin/" + name, nil
	}
	return "", exec.ErrNotFound
}

func (f *fakeSystem) Run(_ context.Context, _ []string, name string, args ...string) error {
	f.runs = append(f.runs, strings.TrimSpace(name+" "+strings.Join(args, " ")))
	if name == "useradd" {
		username := args[len(args)-1]
		f.users[username] = &user.User{Username: username, Uid: "1000", Gid: "1000", HomeDir: args[2]}
	}
	return nil
}

func (f *fakeSystem) Chown(path string, _, _ int) error {
	f.chowns = append(f.chowns, path)
	return nil
}

func (f *fakeSystem) Glibc() ([2]int, error) { return f.glibc, f.glibcErr }

var testHooks = fstest.MapFS{
	"pre-setup.sh":                     {Data: []byte("#!/bin/bash\necho pre\n")},
	"run-hook.sh":                      {Data: []byte("#!/bin/bash\necho run\n")},
	"amika-restore-setuid.service":     {Data: []byte("[Unit]\n")},
	"amika-ipv4-options-guard.service": {Data: []byte("[Unit]\n")},
}

func newBootstrapper(t *testing.T, system *fakeSystem) *Bootstrapper {
	t.Helper()
	root := t.TempDir()
	// A stock image ships the CA bundle.
	certs := filepath.Join(root, "etc", "ssl", "certs")
	if err := os.MkdirAll(certs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(certs, "ca-certificates.crt"), []byte("ca"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &Bootstrapper{Root: root, System: system, Hooks: testHooks}
}

func TestBootstrapCreatesTheRuntimeOnAStockImage(t *testing.T) {
	system := newFakeSystem()
	b := newBootstrapper(t, system)
	if err := b.Run(context.Background(), Options{Home: "/data/home", Version: "0.4.0"}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(system.runs, "; "); got != "groupadd amika; useradd -m -d /data/home -s /bin/bash -g amika amika" {
		t.Fatalf("runs = %s", got)
	}
	for _, p := range []string{
		"/etc/sudoers.d/90-amika",
		"/usr/lib/amikad/pre-setup.sh",
		"/usr/lib/amikad/run-hook.sh",
		"/usr/local/etc/amikad/setup/setup.sh",
		"/usr/local/etc/amikad/setup/start.sh",
		"/usr/local/etc/amika",
		"/var/log/amikad",
		"/run/sshd",
		"/data/home/workspace",
		MarkerPath,
	} {
		if _, err := os.Stat(b.path(p)); err != nil {
			t.Errorf("missing %s: %v", p, err)
		}
	}
	if _, err := os.Stat(b.path("/usr/lib/amikad/amika-restore-setuid.service")); !errors.Is(err, os.ErrNotExist) {
		t.Error("systemd units belong to Amika's own images and must not be written")
	}
	rule, _ := os.ReadFile(b.path("/etc/sudoers.d/90-amika"))
	if string(rule) != "amika ALL=(ALL) NOPASSWD:ALL\n" {
		t.Fatalf("sudoers rule = %q", rule)
	}
	info, _ := os.Stat(b.path("/etc/sudoers.d/90-amika"))
	if info.Mode().Perm() != 0o440 {
		t.Fatalf("sudoers mode = %v, want 0440", info.Mode().Perm())
	}
}

func TestBootstrapIsIdempotentAndKeepsTheUsersOwnScripts(t *testing.T) {
	system := newFakeSystem()
	system.users["amika"] = &user.User{Username: "amika", Uid: "1000", Gid: "1000", HomeDir: "/data/home"}
	b := newBootstrapper(t, system)
	if err := b.Run(context.Background(), Options{Version: "0.4.0"}); err != nil {
		t.Fatal(err)
	}
	setup := b.path("/usr/local/etc/amikad/setup/setup.sh")
	if err := os.WriteFile(setup, []byte("pnpm install\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	system.runs, system.chowns = nil, nil
	if err := b.Run(context.Background(), Options{Version: "0.4.0"}); err != nil {
		t.Fatal(err)
	}
	if len(system.runs) != 0 || len(system.chowns) != 0 {
		t.Fatalf("second run changed the machine: runs=%v chowns=%v", system.runs, system.chowns)
	}
	if data, _ := os.ReadFile(setup); string(data) != "pnpm install\n" {
		t.Fatalf("setup.sh replaced: %q", data)
	}
}

func TestBootstrapInstallsSudoWhenTheImageLacksIt(t *testing.T) {
	system := newFakeSystem()
	delete(system.commands, "sudo")
	b := newBootstrapper(t, system)
	if err := b.Run(context.Background(), Options{Version: "0.4.0"}); err != nil {
		t.Fatal(err)
	}
	want := "apt-get update -q; apt-get install -y -q --no-install-recommends sudo"
	if got := strings.Join(system.runs, "; "); !strings.HasPrefix(got, want) {
		t.Fatalf("runs = %s, want it to start with %s", got, want)
	}
	delete(system.commands, "apt-get")
	if err := b.Run(context.Background(), Options{}); !errors.Is(err, ErrUnsupportedImage) {
		t.Fatalf("without sudo or a package manager: err = %v", err)
	}
}

func TestEnsureOpenSSHServer(t *testing.T) {
	system := newFakeSystem()
	b := newBootstrapper(t, system)
	if installed, err := b.EnsureOpenSSHServer(context.Background()); err != nil || installed {
		t.Fatalf("with sshd present: installed=%v err=%v", installed, err)
	}
	delete(system.commands, "sshd")
	installed, err := b.EnsureOpenSSHServer(context.Background())
	if err != nil || !installed {
		t.Fatalf("without sshd: installed=%v err=%v", installed, err)
	}
	want := []string{"apt-get update -q", "apt-get install -y -q --no-install-recommends openssh-server"}
	if strings.Join(system.runs, "; ") != strings.Join(want, "; ") {
		t.Fatalf("runs = %v, want %v", system.runs, want)
	}
	delete(system.commands, "apt-get")
	if _, err := b.EnsureOpenSSHServer(context.Background()); !errors.Is(err, ErrUnsupportedImage) {
		t.Fatalf("without a package manager: err = %v", err)
	}
}

func TestBootstrapRefusesUnsupportedImages(t *testing.T) {
	cases := map[string]func(*fakeSystem){
		"musl":      func(s *fakeSystem) { s.glibcErr = errors.New("the image uses musl") },
		"old glibc": func(s *fakeSystem) { s.glibc = [2]int{2, 17} },
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			system := newFakeSystem()
			setup(system)
			err := newBootstrapper(t, system).Run(context.Background(), Options{})
			if !errors.Is(err, ErrUnsupportedImage) {
				t.Fatalf("err = %v, want ErrUnsupportedImage", err)
			}
		})
	}
}
