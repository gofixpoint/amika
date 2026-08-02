package amikad

import (
	"errors"
	"io"
	"testing"
)

type panicReader struct{}

func (panicReader) Read([]byte) (int, error) {
	panic("fail-closed stub read secret input")
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
