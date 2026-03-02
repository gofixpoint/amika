package amika

import (
	"context"
	"errors"
	"testing"
)

func TestNewService_ReturnsService(t *testing.T) {
	svc := NewService(Options{})
	if svc == nil {
		t.Fatal("expected service, got nil")
	}
}

func TestUnimplementedService_ReturnsUnimplementedError(t *testing.T) {
	svc := NewService(Options{})
	ctx := context.Background()

	if _, err := svc.CreateSandbox(ctx, CreateSandboxRequest{}); !errors.Is(err, ErrUnimplemented) {
		t.Fatalf("CreateSandbox err = %v, want ErrUnimplemented", err)
	}
	if _, err := svc.DeleteSandbox(ctx, DeleteSandboxRequest{}); !errors.Is(err, ErrUnimplemented) {
		t.Fatalf("DeleteSandbox err = %v, want ErrUnimplemented", err)
	}
	if _, err := svc.ListSandboxes(ctx, ListSandboxesRequest{}); !errors.Is(err, ErrUnimplemented) {
		t.Fatalf("ListSandboxes err = %v, want ErrUnimplemented", err)
	}
	if err := svc.ConnectSandbox(ctx, ConnectSandboxRequest{}); !errors.Is(err, ErrUnimplemented) {
		t.Fatalf("ConnectSandbox err = %v, want ErrUnimplemented", err)
	}
	if _, err := svc.Materialize(ctx, MaterializeRequest{}); !errors.Is(err, ErrUnimplemented) {
		t.Fatalf("Materialize err = %v, want ErrUnimplemented", err)
	}
	if _, err := svc.ListVolumes(ctx, ListVolumesRequest{}); !errors.Is(err, ErrUnimplemented) {
		t.Fatalf("ListVolumes err = %v, want ErrUnimplemented", err)
	}
	if _, err := svc.DeleteVolume(ctx, DeleteVolumeRequest{}); !errors.Is(err, ErrUnimplemented) {
		t.Fatalf("DeleteVolume err = %v, want ErrUnimplemented", err)
	}
	if _, err := svc.ExtractAuth(ctx, AuthExtractRequest{}); !errors.Is(err, ErrUnimplemented) {
		t.Fatalf("ExtractAuth err = %v, want ErrUnimplemented", err)
	}
}
