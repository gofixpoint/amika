package amikad

import (
	"context"
	"errors"
	"io"
	"testing"
)

type panicReader struct{}

func (panicReader) Read([]byte) (int, error) {
	panic("fail-closed stub read secret input")
}

type recordingOperations struct {
	UnimplementedOperations
	setupOptions SetupSSHDOptions
	serveOptions ServeOptions
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
		{"connect-token", "set"},
		{"serve"},
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
