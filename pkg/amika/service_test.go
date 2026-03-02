package amika

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/gofixpoint/amika/internal/sandbox"
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

func TestCreateSandbox_InvalidProvider(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.CreateSandbox(context.Background(), CreateSandboxRequest{Provider: "podman"})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestCreateSandbox_DuplicateName(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)
	store := sandbox.NewStore(filepath.Join(dir, "sandboxes.jsonl"))
	if err := store.Save(sandbox.Info{Name: "dup", Provider: "docker"}); err != nil {
		t.Fatal(err)
	}
	svc := NewService(Options{})
	_, err := svc.CreateSandbox(context.Background(), CreateSandboxRequest{Provider: "docker", Name: "dup"})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestCreateSandbox_SetupScriptAndTextMutuallyExclusive(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.CreateSandbox(context.Background(), CreateSandboxRequest{
		Provider:        "docker",
		Name:            "sb",
		SetupScript:     "/tmp/setup.sh",
		SetupScriptText: "#!/usr/bin/env bash\necho hi\n",
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestDeleteSandbox_NotFound(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.DeleteSandbox(context.Background(), DeleteSandboxRequest{Names: []string{"missing"}})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
}

func TestConnectSandbox_Validation(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	if err := svc.ConnectSandbox(context.Background(), ConnectSandboxRequest{}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
	if err := svc.ConnectSandbox(context.Background(), ConnectSandboxRequest{Name: "missing"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
}

func TestMaterialize_RequiresDestdir(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.Materialize(context.Background(), MaterializeRequest{Cmd: "echo hi"})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("expected invalid argument, got %v", err)
	}
}

func TestDeleteVolume_NotFound(t *testing.T) {
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	svc := NewService(Options{})
	_, err := svc.DeleteVolume(context.Background(), DeleteVolumeRequest{Names: []string{"missing"}})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
}
