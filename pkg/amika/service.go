package amika

import (
	"context"
	"fmt"
	"sort"

	"github.com/gofixpoint/amika/internal/auth"
	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/sandbox"
)

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

// NewService returns a service implementation.
func NewService(_ Options) Service {
	sandboxesFile, err := config.SandboxesStateFile()
	if err != nil {
		return &initErrorService{err: fmt.Errorf("%w: %v", ErrDependency, err)}
	}
	volumesFile, err := config.VolumesStateFile()
	if err != nil {
		return &initErrorService{err: fmt.Errorf("%w: %v", ErrDependency, err)}
	}
	fileMountsFile, err := config.FileMountsStateFile()
	if err != nil {
		return &initErrorService{err: fmt.Errorf("%w: %v", ErrDependency, err)}
	}
	return &serviceImpl{
		sandboxes:  sandbox.NewStore(sandboxesFile),
		volumes:    sandbox.NewVolumeStore(volumesFile),
		fileMounts: sandbox.NewFileMountStore(fileMountsFile),
	}
}

type serviceImpl struct {
	sandboxes  sandbox.Store
	volumes    sandbox.VolumeStore
	fileMounts sandbox.FileMountStore
}

func (s *serviceImpl) CreateSandbox(context.Context, CreateSandboxRequest) (Sandbox, error) {
	return Sandbox{}, ErrUnimplemented
}
func (s *serviceImpl) DeleteSandbox(context.Context, DeleteSandboxRequest) (DeleteSandboxResult, error) {
	return DeleteSandboxResult{}, ErrUnimplemented
}
func (s *serviceImpl) ConnectSandbox(context.Context, ConnectSandboxRequest) error {
	return ErrUnimplemented
}

func (s *serviceImpl) ListSandboxes(context.Context, ListSandboxesRequest) (ListSandboxesResult, error) {
	items, err := s.sandboxes.List()
	if err != nil {
		return ListSandboxesResult{}, fmt.Errorf("%w: %v", ErrInternal, err)
	}
	out := make([]Sandbox, 0, len(items))
	for _, it := range items {
		out = append(out, Sandbox{Name: it.Name, Provider: it.Provider, ContainerID: it.ContainerID, Image: it.Image, CreatedAt: it.CreatedAt, Preset: it.Preset, Mounts: toMounts(it.Mounts), Env: it.Env})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return ListSandboxesResult{Items: out}, nil
}

func (s *serviceImpl) Materialize(context.Context, MaterializeRequest) (MaterializeResult, error) {
	return MaterializeResult{}, ErrUnimplemented
}

func (s *serviceImpl) ListVolumes(context.Context, ListVolumesRequest) (ListVolumesResult, error) {
	vols, err := s.volumes.List()
	if err != nil {
		return ListVolumesResult{}, fmt.Errorf("%w: %v", ErrInternal, err)
	}
	fms, err := s.fileMounts.List()
	if err != nil {
		return ListVolumesResult{}, fmt.Errorf("%w: %v", ErrInternal, err)
	}
	out := make([]Volume, 0, len(vols)+len(fms))
	for _, v := range vols {
		out = append(out, Volume{Name: v.Name, Type: "directory", CreatedAt: v.CreatedAt, InUse: len(v.SandboxRefs) > 0, Sandboxes: v.SandboxRefs, SourcePath: v.SourcePath})
	}
	for _, v := range fms {
		out = append(out, Volume{Name: v.Name, Type: "file", CreatedAt: v.CreatedAt, InUse: len(v.SandboxRefs) > 0, Sandboxes: v.SandboxRefs, SourcePath: v.SourcePath})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return ListVolumesResult{Items: out}, nil
}

func (s *serviceImpl) DeleteVolume(context.Context, DeleteVolumeRequest) (DeleteVolumeResult, error) {
	return DeleteVolumeResult{}, ErrUnimplemented
}
func (s *serviceImpl) ExtractAuth(_ context.Context, req AuthExtractRequest) (AuthExtractResult, error) {
	result, err := auth.Discover(auth.Options{HomeDir: req.HomeDir, IncludeOAuth: !req.NoOAuth})
	if err != nil {
		return AuthExtractResult{}, fmt.Errorf("%w: %v", ErrDependency, err)
	}
	return AuthExtractResult{Lines: auth.BuildEnvMap(result).Lines(req.WithExport)}, nil
}

type initErrorService struct{ err error }

func (s *initErrorService) CreateSandbox(context.Context, CreateSandboxRequest) (Sandbox, error) {
	return Sandbox{}, s.err
}
func (s *initErrorService) DeleteSandbox(context.Context, DeleteSandboxRequest) (DeleteSandboxResult, error) {
	return DeleteSandboxResult{}, s.err
}
func (s *initErrorService) ListSandboxes(context.Context, ListSandboxesRequest) (ListSandboxesResult, error) {
	return ListSandboxesResult{}, s.err
}
func (s *initErrorService) ConnectSandbox(context.Context, ConnectSandboxRequest) error { return s.err }
func (s *initErrorService) Materialize(context.Context, MaterializeRequest) (MaterializeResult, error) {
	return MaterializeResult{}, s.err
}
func (s *initErrorService) ListVolumes(context.Context, ListVolumesRequest) (ListVolumesResult, error) {
	return ListVolumesResult{}, s.err
}
func (s *initErrorService) DeleteVolume(context.Context, DeleteVolumeRequest) (DeleteVolumeResult, error) {
	return DeleteVolumeResult{}, s.err
}
func (s *initErrorService) ExtractAuth(context.Context, AuthExtractRequest) (AuthExtractResult, error) {
	return AuthExtractResult{}, s.err
}

func toMounts(in []sandbox.MountBinding) []Mount {
	out := make([]Mount, 0, len(in))
	for _, m := range in {
		out = append(out, Mount{Type: m.Type, Source: m.Source, Volume: m.Volume, Target: m.Target, Mode: m.Mode, SnapshotFrom: m.SnapshotFrom})
	}
	return out
}
