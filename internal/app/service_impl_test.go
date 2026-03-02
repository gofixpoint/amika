package app

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gofixpoint/amika/internal/ports"
	"github.com/gofixpoint/amika/pkg/amika"
)

type stubDocker struct{}

func (stubDocker) CreateSandbox(string, string, []ports.Mount, []string, []ports.PortBinding) (string, error) {
	return "container-123", nil
}
func (stubDocker) RemoveSandbox(string) error               { return nil }
func (stubDocker) CreateVolume(string) error                { return nil }
func (stubDocker) RemoveVolume(string) error                { return nil }
func (stubDocker) CopyHostDirToVolume(string, string) error { return nil }

type stubSandboxStore struct{}

func (stubSandboxStore) Save(ports.SandboxRecord) error { return nil }
func (stubSandboxStore) Get(_ string) (ports.SandboxRecord, error) {
	return ports.SandboxRecord{}, errors.New("not found")
}
func (stubSandboxStore) Remove(string) error                  { return nil }
func (stubSandboxStore) List() ([]ports.SandboxRecord, error) { return nil, nil }

type stubVolumeStore struct{}

func (stubVolumeStore) Save(ports.VolumeRecord) error                   { return nil }
func (stubVolumeStore) Get(string) (ports.VolumeRecord, error)          { return ports.VolumeRecord{}, nil }
func (stubVolumeStore) Remove(string) error                             { return nil }
func (stubVolumeStore) List() ([]ports.VolumeRecord, error)             { return nil, nil }
func (stubVolumeStore) AddSandboxRef(string, string) error              { return nil }
func (stubVolumeStore) RemoveSandboxRef(string, string) error           { return nil }
func (stubVolumeStore) ForSandbox(string) ([]ports.VolumeRecord, error) { return nil, nil }

type stubFileMountStore struct{ stubVolumeStore }

type stubClock struct{}

func (stubClock) Now() time.Time { return time.Now() }

type stubIDGenerator struct{}

func (stubIDGenerator) New(prefix string) string { return prefix + "-id" }

func TestNewService_RequiresDependencies(t *testing.T) {
	_, err := NewService(Dependencies{})
	if err == nil {
		t.Fatal("expected error for missing deps")
	}
}

func TestNewService_ImplementsPublicService(t *testing.T) {
	svc, err := NewService(Dependencies{
		Docker:      stubDocker{},
		Sandboxes:   stubSandboxStore{},
		Volumes:     stubVolumeStore{},
		FileMounts:  stubFileMountStore{},
		Runner:      stubRunner{},
		Clock:       stubClock{},
		IDGenerator: stubIDGenerator{},
	})
	if err != nil {
		t.Fatalf("NewService error: %v", err)
	}

	ctx := context.Background()
	if _, err := svc.CreateSandbox(ctx, amika.CreateSandboxRequest{}); !errors.Is(err, amika.ErrInvalidArgument) {
		t.Fatalf("CreateSandbox err = %v, want ErrInvalidArgument", err)
	}
	if _, err := svc.CreateSandbox(ctx, amika.CreateSandboxRequest{Name: "new-sb", Provider: "docker", Image: "img"}); err != nil {
		t.Fatalf("CreateSandbox unexpected err = %v", err)
	}
	if _, err := svc.CreateSandbox(ctx, amika.CreateSandboxRequest{
		Name:     "sb-invalid-port",
		Provider: "docker",
		Image:    "img",
		Ports: []amika.PortBinding{
			{HostPort: 0, ContainerPort: 80},
		},
	}); !errors.Is(err, amika.ErrInvalidArgument) {
		t.Fatalf("CreateSandbox invalid ports err = %v, want ErrInvalidArgument", err)
	}
	if _, err := svc.DeleteSandbox(ctx, amika.DeleteSandboxRequest{Names: []string{"missing"}}); !errors.Is(err, amika.ErrNotFound) {
		t.Fatalf("DeleteSandbox err = %v, want ErrNotFound", err)
	}
	if err := svc.ConnectSandbox(ctx, amika.ConnectSandboxRequest{Name: "missing"}); !errors.Is(err, amika.ErrNotFound) {
		t.Fatalf("ConnectSandbox err = %v, want ErrNotFound", err)
	}
	if _, err := svc.ExtractAuth(ctx, amika.AuthExtractRequest{}); err != nil {
		t.Fatalf("ExtractAuth err = %v, want nil", err)
	}
}

type stubRunner struct{}

func (stubRunner) Run(context.Context, string, []string, ports.RunOptions) (ports.RunResult, error) {
	return ports.RunResult{}, nil
}
