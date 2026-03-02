package app

import (
	"context"
	"errors"

	"github.com/gofixpoint/amika/internal/ports"
	"github.com/gofixpoint/amika/pkg/amika"
)

// Dependencies aggregates application-layer dependencies.
type Dependencies struct {
	Docker      ports.DockerClient
	Sandboxes   ports.SandboxStore
	Volumes     ports.VolumeStore
	FileMounts  ports.FileMountStore
	FS          ports.Filesystem
	Runner      ports.CommandRunner
	Clock       ports.Clock
	IDGenerator ports.IDGenerator
}

// Service is the application-layer implementation backing pkg/amika.Service.
type Service struct {
	deps Dependencies
}

// NewService constructs a new application service from dependencies.
func NewService(deps Dependencies) (*Service, error) {
	if deps.Docker == nil || deps.Sandboxes == nil || deps.Volumes == nil || deps.FileMounts == nil {
		return nil, errors.New("missing required dependencies")
	}
	return &Service{deps: deps}, nil
}

// Ensure Service satisfies the public service interface.
var _ amika.Service = (*Service)(nil)

// CreateSandbox is a placeholder while behavior is migrated from CLI adapters.
func (s *Service) CreateSandbox(context.Context, amika.CreateSandboxRequest) (amika.Sandbox, error) {
	return amika.Sandbox{}, amika.ErrUnimplemented
}

// DeleteSandbox is a placeholder while behavior is migrated from CLI adapters.
func (s *Service) DeleteSandbox(context.Context, amika.DeleteSandboxRequest) (amika.DeleteSandboxResult, error) {
	return amika.DeleteSandboxResult{}, amika.ErrUnimplemented
}

// ListSandboxes is a placeholder while behavior is migrated from CLI adapters.
func (s *Service) ListSandboxes(context.Context, amika.ListSandboxesRequest) (amika.ListSandboxesResult, error) {
	return amika.ListSandboxesResult{}, amika.ErrUnimplemented
}

// ConnectSandbox is a placeholder while behavior is migrated from CLI adapters.
func (s *Service) ConnectSandbox(context.Context, amika.ConnectSandboxRequest) error {
	return amika.ErrUnimplemented
}

// Materialize is a placeholder while behavior is migrated from CLI adapters.
func (s *Service) Materialize(context.Context, amika.MaterializeRequest) (amika.MaterializeResult, error) {
	return amika.MaterializeResult{}, amika.ErrUnimplemented
}

// ListVolumes is a placeholder while behavior is migrated from CLI adapters.
func (s *Service) ListVolumes(context.Context, amika.ListVolumesRequest) (amika.ListVolumesResult, error) {
	return amika.ListVolumesResult{}, amika.ErrUnimplemented
}

// DeleteVolume is a placeholder while behavior is migrated from CLI adapters.
func (s *Service) DeleteVolume(context.Context, amika.DeleteVolumeRequest) (amika.DeleteVolumeResult, error) {
	return amika.DeleteVolumeResult{}, amika.ErrUnimplemented
}

// ExtractAuth is a placeholder while behavior is migrated from CLI adapters.
func (s *Service) ExtractAuth(context.Context, amika.AuthExtractRequest) (amika.AuthExtractResult, error) {
	return amika.AuthExtractResult{}, amika.ErrUnimplemented
}
