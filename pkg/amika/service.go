package amika

import "context"

// Service defines the public API surface for running Amika operations from Go.
type Service interface {
	CreateSandbox(ctx context.Context, req CreateSandboxRequest) (Sandbox, error)
	DeleteSandbox(ctx context.Context, req DeleteSandboxRequest) (DeleteSandboxResult, error)
	ListSandboxes(ctx context.Context, req ListSandboxesRequest) (ListSandboxesResult, error)
	ConnectSandbox(ctx context.Context, req ConnectSandboxRequest) error

	Materialize(ctx context.Context, req MaterializeRequest) (MaterializeResult, error)

	ListVolumes(ctx context.Context, req ListVolumesRequest) (ListVolumesResult, error)
	DeleteVolume(ctx context.Context, req DeleteVolumeRequest) (DeleteVolumeResult, error)

	ExtractAuth(ctx context.Context, req AuthExtractRequest) (AuthExtractResult, error)
}

// Options controls construction of a public Amika service.
type Options struct{}

// NewService returns a service implementation. The current implementation is a
// skeleton to establish the public API before wiring concrete behavior.
func NewService(_ Options) Service {
	return &unimplementedService{}
}

type unimplementedService struct{}

func (s *unimplementedService) CreateSandbox(context.Context, CreateSandboxRequest) (Sandbox, error) {
	return Sandbox{}, ErrUnimplemented
}

func (s *unimplementedService) DeleteSandbox(context.Context, DeleteSandboxRequest) (DeleteSandboxResult, error) {
	return DeleteSandboxResult{}, ErrUnimplemented
}

func (s *unimplementedService) ListSandboxes(context.Context, ListSandboxesRequest) (ListSandboxesResult, error) {
	return ListSandboxesResult{}, ErrUnimplemented
}

func (s *unimplementedService) ConnectSandbox(context.Context, ConnectSandboxRequest) error {
	return ErrUnimplemented
}

func (s *unimplementedService) Materialize(context.Context, MaterializeRequest) (MaterializeResult, error) {
	return MaterializeResult{}, ErrUnimplemented
}

func (s *unimplementedService) ListVolumes(context.Context, ListVolumesRequest) (ListVolumesResult, error) {
	return ListVolumesResult{}, ErrUnimplemented
}

func (s *unimplementedService) DeleteVolume(context.Context, DeleteVolumeRequest) (DeleteVolumeResult, error) {
	return DeleteVolumeResult{}, ErrUnimplemented
}

func (s *unimplementedService) ExtractAuth(context.Context, AuthExtractRequest) (AuthExtractResult, error) {
	return AuthExtractResult{}, ErrUnimplemented
}
