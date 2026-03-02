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

func (stubDocker) CreateSandbox(string, string, []ports.Mount, []string) (string, error) {
	return "", nil
}
func (stubDocker) RemoveSandbox(string) error               { return nil }
func (stubDocker) CreateVolume(string) error                { return nil }
func (stubDocker) RemoveVolume(string) error                { return nil }
func (stubDocker) CopyHostDirToVolume(string, string) error { return nil }

type stubSandboxStore struct{}

func (stubSandboxStore) Save(ports.SandboxRecord) error          { return nil }
func (stubSandboxStore) Get(string) (ports.SandboxRecord, error) { return ports.SandboxRecord{}, nil }
func (stubSandboxStore) Remove(string) error                     { return nil }
func (stubSandboxStore) List() ([]ports.SandboxRecord, error)    { return nil, nil }

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
		Clock:       stubClock{},
		IDGenerator: stubIDGenerator{},
	})
	if err != nil {
		t.Fatalf("NewService error: %v", err)
	}

	ctx := context.Background()
	if _, err := svc.CreateSandbox(ctx, amika.CreateSandboxRequest{}); !errors.Is(err, amika.ErrUnimplemented) {
		t.Fatalf("CreateSandbox err = %v, want ErrUnimplemented", err)
	}
	if _, err := svc.ExtractAuth(ctx, amika.AuthExtractRequest{}); err != nil {
		t.Fatalf("ExtractAuth err = %v, want nil", err)
	}
}
