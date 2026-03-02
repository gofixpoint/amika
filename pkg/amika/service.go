package amika

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"

	"github.com/gofixpoint/amika/internal/auth"
	"github.com/gofixpoint/amika/internal/config"
	"github.com/gofixpoint/amika/internal/materialize"
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

func (s *serviceImpl) CreateSandbox(_ context.Context, req CreateSandboxRequest) (Sandbox, error) {
	provider := req.Provider
	if provider == "" {
		provider = "docker"
	}
	if provider != "docker" {
		return Sandbox{}, fmt.Errorf("%w: unsupported provider %q", ErrInvalidArgument, provider)
	}
	name := req.Name
	if name == "" {
		for {
			name = sandbox.GenerateName()
			if _, err := s.sandboxes.Get(name); err != nil {
				break
			}
		}
	} else if _, err := s.sandboxes.Get(name); err == nil {
		return Sandbox{}, fmt.Errorf("%w: sandbox %q already exists", ErrInvalidArgument, name)
	}
	mounts := make([]sandbox.MountBinding, 0, len(req.Mounts)+len(req.Volumes))
	for _, m := range req.Mounts {
		mounts = append(mounts, sandbox.MountBinding{Type: m.Type, Source: m.Source, Volume: m.Volume, Target: m.Target, Mode: m.Mode, SnapshotFrom: m.SnapshotFrom})
	}
	for _, m := range req.Volumes {
		mounts = append(mounts, sandbox.MountBinding{Type: m.Type, Source: m.Source, Volume: m.Volume, Target: m.Target, Mode: m.Mode, SnapshotFrom: m.SnapshotFrom})
	}
	containerID, err := sandbox.CreateDockerSandbox(name, req.Image, mounts, req.Env)
	if err != nil {
		return Sandbox{}, fmt.Errorf("%w: %v", ErrDependency, err)
	}
	info := sandbox.Info{Name: name, Provider: provider, ContainerID: containerID, Image: req.Image, CreatedAt: time.Now().UTC().Format(time.RFC3339), Preset: req.Preset, Mounts: mounts, Env: req.Env}
	if err := s.sandboxes.Save(info); err != nil {
		return Sandbox{}, fmt.Errorf("%w: %v", ErrInternal, err)
	}
	return Sandbox{Name: info.Name, Provider: info.Provider, ContainerID: info.ContainerID, Image: info.Image, CreatedAt: info.CreatedAt, Preset: info.Preset, Mounts: toMounts(info.Mounts), Env: info.Env}, nil
}
func (s *serviceImpl) DeleteSandbox(_ context.Context, req DeleteSandboxRequest) (DeleteSandboxResult, error) {
	deleted := make([]string, 0, len(req.Names))
	for _, name := range req.Names {
		info, err := s.sandboxes.Get(name)
		if err != nil {
			return DeleteSandboxResult{}, fmt.Errorf("%w: sandbox %q", ErrNotFound, name)
		}
		if info.Provider == "docker" {
			if err := sandbox.RemoveDockerSandbox(name); err != nil {
				return DeleteSandboxResult{}, fmt.Errorf("%w: %v", ErrDependency, err)
			}
		}
		if err := s.sandboxes.Remove(name); err != nil {
			return DeleteSandboxResult{}, fmt.Errorf("%w: %v", ErrInternal, err)
		}
		deleted = append(deleted, name)
	}
	return DeleteSandboxResult{Deleted: deleted}, nil
}
func (s *serviceImpl) ConnectSandbox(ctx context.Context, req ConnectSandboxRequest) error {
	if req.Name == "" {
		return fmt.Errorf("%w: sandbox name is required", ErrInvalidArgument)
	}
	if req.Shell == "" {
		req.Shell = "zsh"
	}
	info, err := s.sandboxes.Get(req.Name)
	if err != nil {
		return fmt.Errorf("%w: sandbox %q", ErrNotFound, req.Name)
	}
	if info.Provider != "docker" {
		return fmt.Errorf("%w: unsupported provider %q", ErrInvalidArgument, info.Provider)
	}
	args := []string{"exec", "-it", "-w", "/home/amika", req.Name, req.Shell}
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%w: %v", ErrDependency, err)
	}
	return nil
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

func (s *serviceImpl) Materialize(_ context.Context, req MaterializeRequest) (MaterializeResult, error) {
	if req.Destdir == "" {
		return MaterializeResult{}, fmt.Errorf("%w: --destdir is required", ErrInvalidArgument)
	}
	if req.Script == "" && req.Cmd == "" {
		return MaterializeResult{}, fmt.Errorf("%w: exactly one of script or cmd must be specified", ErrInvalidArgument)
	}
	if req.Script != "" && req.Cmd != "" {
		return MaterializeResult{}, fmt.Errorf("%w: --script and --cmd are mutually exclusive", ErrInvalidArgument)
	}
	workdir, err := os.MkdirTemp("", "amika-materialize-work-*")
	if err != nil {
		return MaterializeResult{}, fmt.Errorf("%w: create temp workdir: %v", ErrInternal, err)
	}
	defer os.RemoveAll(workdir)
	outdir := req.Outdir
	if outdir == "" {
		outdir = filepath.Join(workdir, "out")
	}
	if err := materialize.Run(materialize.Options{Script: req.Script, ScriptArgs: req.ScriptArgs, Cmd: req.Cmd, Workdir: workdir, Outdir: outdir, Destdir: req.Destdir, Env: req.Env}); err != nil {
		return MaterializeResult{}, fmt.Errorf("%w: %v", ErrDependency, err)
	}
	return MaterializeResult{Destdir: req.Destdir}, nil
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

func (s *serviceImpl) DeleteVolume(_ context.Context, req DeleteVolumeRequest) (DeleteVolumeResult, error) {
	deleted := make([]string, 0, len(req.Names))
	for _, name := range req.Names {
		if vol, err := s.volumes.Get(name); err == nil {
			if len(vol.SandboxRefs) > 0 && !req.Force {
				return DeleteVolumeResult{}, fmt.Errorf("%w: volume %q is in use", ErrInvalidArgument, name)
			}
			if err := sandbox.RemoveDockerVolume(name); err != nil {
				return DeleteVolumeResult{}, fmt.Errorf("%w: %v", ErrDependency, err)
			}
			if err := s.volumes.Remove(name); err != nil {
				return DeleteVolumeResult{}, fmt.Errorf("%w: %v", ErrInternal, err)
			}
			deleted = append(deleted, name)
			continue
		}
		if fm, err := s.fileMounts.Get(name); err == nil {
			if len(fm.SandboxRefs) > 0 && !req.Force {
				return DeleteVolumeResult{}, fmt.Errorf("%w: volume %q is in use", ErrInvalidArgument, name)
			}
			if fm.CopyPath != "" {
				if err := os.RemoveAll(filepath.Dir(fm.CopyPath)); err != nil {
					return DeleteVolumeResult{}, fmt.Errorf("%w: %v", ErrInternal, err)
				}
			}
			if err := s.fileMounts.Remove(name); err != nil {
				return DeleteVolumeResult{}, fmt.Errorf("%w: %v", ErrInternal, err)
			}
			deleted = append(deleted, name)
			continue
		}
		return DeleteVolumeResult{}, fmt.Errorf("%w: volume %q", ErrNotFound, name)
	}
	return DeleteVolumeResult{Deleted: deleted}, nil
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
