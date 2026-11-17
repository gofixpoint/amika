package amikad

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type panicReader struct{}

func (panicReader) Read([]byte) (int, error) {
	panic("fail-closed stub read secret input")
}

type recordingOperations struct {
	UnimplementedOperations
	setupOptions     SetupSSHDOptions
	serveOptions     ServeOptions
	bootstrapOptions BootstrapOptions
	installOptions   InstallOptions
	installInput     string
	waitOptions      WaitReadyOptions
}

func (o *recordingOperations) Bootstrap(_ context.Context, options BootstrapOptions) error {
	o.bootstrapOptions = options
	return nil
}

func (o *recordingOperations) InstallToolchain(_ context.Context, options InstallOptions, lockfile io.Reader) error {
	o.installOptions = options
	data, err := io.ReadAll(lockfile)
	o.installInput = string(data)
	return err
}

func (o *recordingOperations) WaitReady(_ context.Context, options WaitReadyOptions) error {
	o.waitOptions = options
	return nil
}

func (o *recordingOperations) SetupSSHD(_ context.Context, options SetupSSHDOptions) error {
	o.setupOptions = options
	return nil
}

func (o *recordingOperations) Serve(_ context.Context, options ServeOptions) error {
	o.serveOptions = options
	return nil
}

func TestCommandTopology(t *testing.T) {
	cmd := NewCommand(UnimplementedOperations{})
	for _, path := range [][]string{
		{"setup", "sshd"},
		{"host-key", "show"},
		{"authorized-keys", "set"},
		{"authorized-keys", "clear"},
		{"connect-token", "set"},
		{"serve"},
		{"bootstrap"},
		{"install"},
		{"wait-ready"},
	} {
		found, _, err := cmd.Find(path)
		if err != nil {
			t.Fatalf("find %v: %v", path, err)
		}
		if found == cmd {
			t.Fatalf("path %v resolved to root command", path)
		}
	}
}

func TestUnimplementedConnectTokenDoesNotReadSecret(t *testing.T) {
	cmd := NewCommand(UnimplementedOperations{})
	cmd.SetArgs([]string{"connect-token", "set"})
	cmd.SetIn(panicReader{})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)

	err := cmd.Execute()
	if !errors.Is(err, ErrNotImplemented) {
		t.Fatalf("execute error = %v, want ErrNotImplemented", err)
	}
}

func TestSetupSSHDForceOverwriteFlag(t *testing.T) {
	operations := &recordingOperations{}
	cmd := NewCommand(operations)
	cmd.SetArgs([]string{"setup", "sshd", "--force-overwrite"})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)

	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !operations.setupOptions.ForceOverwrite {
		t.Fatal("ForceOverwrite = false, want true")
	}
}

func TestServeBackgroundFlag(t *testing.T) {
	operations := &recordingOperations{}
	cmd := NewCommand(operations)
	cmd.SetArgs([]string{"serve", "--beta-no-relay", "--bg", "--port", "61000"})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)

	if err := cmd.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !operations.serveOptions.Background || !operations.serveOptions.BetaNoRelay || operations.serveOptions.Port != 61000 {
		t.Fatalf("serve options = %+v", operations.serveOptions)
	}
}

func TestBootstrapInstallAndWaitReadyFlags(t *testing.T) {
	operations := &recordingOperations{}
	run := func(stdin string, args ...string) {
		t.Helper()
		cmd := NewCommand(operations)
		cmd.SetArgs(args)
		cmd.SetIn(strings.NewReader(stdin))
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		if err := cmd.Execute(); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}

	run("", "bootstrap", "--home", "/data/home")
	if err := func() error {
		cmd := NewCommand(operations)
		cmd.SetArgs([]string{"bootstrap", "--user", "bob"})
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		return cmd.Execute()
	}(); err == nil {
		t.Fatal("bootstrap accepted --user; the hooks support only amika")
	}
	if operations.bootstrapOptions.Home != "/data/home" {
		t.Fatalf("bootstrap options = %+v", operations.bootstrapOptions)
	}

	run(`{"schema":2}`, "install")
	got := operations.installOptions
	if got.Lockfile != "-" || len(got.Deps) != 0 || len(got.Without) != 0 || got.Background || operations.installInput != `{"schema":2}` {
		t.Fatalf("install defaults = %+v input %q", got, operations.installInput)
	}
	run("", "install", "--lockfile", "/var/lib/amikad/toolchain.lock.json",
		"--dep", "opencode", "--dep", "pi-web", "--without", "gh", "--background")
	got = operations.installOptions
	if got.Lockfile != "/var/lib/amikad/toolchain.lock.json" ||
		strings.Join(got.Deps, ",") != "opencode,pi-web" ||
		strings.Join(got.Without, ",") != "gh" || !got.Background {
		t.Fatalf("install flags = %+v", got)
	}

	run("", "wait-ready", "--timeout", "3s")
	if operations.waitOptions.Port != DefaultPort || operations.waitOptions.Timeout != 3*time.Second {
		t.Fatalf("wait-ready options = %+v", operations.waitOptions)
	}
}
