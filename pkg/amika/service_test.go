package amika

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestNewService_ReturnsService(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	if svc == nil {
		t.Fatal("expected service, got nil")
	}
	if _, err := svc.ListSandboxes(context.Background(), ListSandboxesRequest{}); err != nil {
		t.Fatalf("ListSandboxes err = %v", err)
	}
}

func TestNewService_InitFailureMapsToDependencyError(t *testing.T) {
	f := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(f, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AMIKA_STATE_DIRECTORY", f)
	svc := NewService(Options{})
	_, err := svc.ListSandboxes(context.Background(), ListSandboxesRequest{})
	if !errors.Is(err, ErrInternal) {
		t.Fatalf("expected internal error, got %v", err)
	}
}
