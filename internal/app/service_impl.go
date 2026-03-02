package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/gofixpoint/amika/internal/auth"
	"github.com/gofixpoint/amika/internal/materialize"
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

// CreateSandbox creates and persists a sandbox record after creating the backing runtime sandbox.
func (s *Service) CreateSandbox(_ context.Context, req amika.CreateSandboxRequest) (amika.Sandbox, error) {
	provider := req.Provider
	if provider == "" {
		provider = "docker"
	}
	if provider != "docker" {
		return amika.Sandbox{}, fmt.Errorf("%w: unsupported provider %q", amika.ErrInvalidArgument, provider)
	}
	if req.Name == "" {
		return amika.Sandbox{}, fmt.Errorf("%w: sandbox name is required", amika.ErrInvalidArgument)
	}
	if _, err := s.deps.Sandboxes.Get(req.Name); err == nil {
		return amika.Sandbox{}, fmt.Errorf("%w: sandbox %q already exists", amika.ErrInvalidArgument, req.Name)
	}

	containerID, err := s.deps.Docker.CreateSandbox(req.Name, req.Image, toPortMounts(req.Mounts, req.Volumes), req.Env)
	if err != nil {
		return amika.Sandbox{}, fmt.Errorf("%w: %v", amika.ErrDependency, err)
	}

	now := time.Now().UTC()
	if s.deps.Clock != nil {
		now = s.deps.Clock.Now().UTC()
	}
	rec := ports.SandboxRecord{
		Name:        req.Name,
		Provider:    provider,
		ContainerID: containerID,
		Image:       req.Image,
		CreatedAt:   now.Format(time.RFC3339),
		Preset:      req.Preset,
		Mounts:      toPortMounts(req.Mounts, req.Volumes),
		Env:         req.Env,
	}
	if err := s.deps.Sandboxes.Save(rec); err != nil {
		return amika.Sandbox{}, fmt.Errorf("%w: %v", amika.ErrInternal, err)
	}

	return amika.Sandbox{
		Name:        rec.Name,
		Provider:    rec.Provider,
		ContainerID: rec.ContainerID,
		Image:       rec.Image,
		CreatedAt:   rec.CreatedAt,
		Preset:      rec.Preset,
		Mounts:      toPublicMounts(rec.Mounts),
		Env:         rec.Env,
	}, nil
}

// DeleteSandbox removes one or more sandboxes and their backing runtime sandboxes.
func (s *Service) DeleteSandbox(_ context.Context, req amika.DeleteSandboxRequest) (amika.DeleteSandboxResult, error) {
	deleted := make([]string, 0, len(req.Names))
	for _, name := range req.Names {
		rec, err := s.deps.Sandboxes.Get(name)
		if err != nil {
			return amika.DeleteSandboxResult{}, fmt.Errorf("%w: sandbox %q", amika.ErrNotFound, name)
		}
		if rec.Provider == "docker" {
			if err := s.deps.Docker.RemoveSandbox(name); err != nil {
				return amika.DeleteSandboxResult{}, fmt.Errorf("%w: %v", amika.ErrDependency, err)
			}
		}
		if err := s.deps.Sandboxes.Remove(name); err != nil {
			return amika.DeleteSandboxResult{}, fmt.Errorf("%w: %v", amika.ErrInternal, err)
		}
		deleted = append(deleted, name)
	}

	return amika.DeleteSandboxResult{Deleted: deleted}, nil
}

// ListSandboxes lists persisted sandbox records.
func (s *Service) ListSandboxes(context.Context, amika.ListSandboxesRequest) (amika.ListSandboxesResult, error) {
	recs, err := s.deps.Sandboxes.List()
	if err != nil {
		return amika.ListSandboxesResult{}, fmt.Errorf("%w: list sandboxes: %v", amika.ErrInternal, err)
	}
	items := make([]amika.Sandbox, 0, len(recs))
	for _, rec := range recs {
		items = append(items, amika.Sandbox{
			Name:        rec.Name,
			Provider:    rec.Provider,
			ContainerID: rec.ContainerID,
			Image:       rec.Image,
			CreatedAt:   rec.CreatedAt,
			Preset:      rec.Preset,
			Mounts:      toPublicMounts(rec.Mounts),
			Env:         rec.Env,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return amika.ListSandboxesResult{Items: items}, nil
}

// ConnectSandbox opens an interactive shell in an existing sandbox.
func (s *Service) ConnectSandbox(ctx context.Context, req amika.ConnectSandboxRequest) error {
	if req.Name == "" {
		return fmt.Errorf("%w: sandbox name is required", amika.ErrInvalidArgument)
	}
	if req.Shell == "" {
		req.Shell = "zsh"
	}
	rec, err := s.deps.Sandboxes.Get(req.Name)
	if err != nil {
		return fmt.Errorf("%w: sandbox %q", amika.ErrNotFound, req.Name)
	}
	if rec.Provider != "docker" {
		return fmt.Errorf("%w: unsupported provider %q", amika.ErrInvalidArgument, rec.Provider)
	}
	if s.deps.Runner == nil {
		return fmt.Errorf("%w: command runner unavailable", amika.ErrDependency)
	}
	args := []string{"exec", "-it", "-w", "/home/amika", req.Name, req.Shell}
	if _, err := s.deps.Runner.Run(ctx, "docker", args, ports.RunOptions{}); err != nil {
		return fmt.Errorf("%w: %v", amika.ErrDependency, err)
	}
	return nil
}

// Materialize runs local materialization flow.
func (s *Service) Materialize(_ context.Context, req amika.MaterializeRequest) (amika.MaterializeResult, error) {
	if req.Destdir == "" {
		return amika.MaterializeResult{}, fmt.Errorf("%w: --destdir is required", amika.ErrInvalidArgument)
	}
	if req.Script == "" && req.Cmd == "" {
		return amika.MaterializeResult{}, fmt.Errorf("%w: exactly one of script or cmd must be specified", amika.ErrInvalidArgument)
	}
	if req.Script != "" && req.Cmd != "" {
		return amika.MaterializeResult{}, fmt.Errorf("%w: --script and --cmd are mutually exclusive", amika.ErrInvalidArgument)
	}
	workdir, err := os.MkdirTemp("", "amika-materialize-work-*")
	if err != nil {
		return amika.MaterializeResult{}, fmt.Errorf("%w: create temp workdir: %v", amika.ErrInternal, err)
	}
	defer os.RemoveAll(workdir)
	outdir := req.Outdir
	if outdir == "" {
		outdir = filepath.Join(workdir, "out")
	}
	err = materialize.Run(materialize.Options{Script: req.Script, ScriptArgs: req.ScriptArgs, Cmd: req.Cmd, Workdir: workdir, Outdir: outdir, Destdir: req.Destdir, Env: req.Env})
	if err != nil {
		return amika.MaterializeResult{}, fmt.Errorf("%w: %v", amika.ErrDependency, err)
	}
	return amika.MaterializeResult{Destdir: req.Destdir}, nil
}

// ListVolumes lists tracked directory and file mount volumes.
func (s *Service) ListVolumes(context.Context, amika.ListVolumesRequest) (amika.ListVolumesResult, error) {
	vols, err := s.deps.Volumes.List()
	if err != nil {
		return amika.ListVolumesResult{}, fmt.Errorf("%w: list volumes: %v", amika.ErrInternal, err)
	}
	fms, err := s.deps.FileMounts.List()
	if err != nil {
		return amika.ListVolumesResult{}, fmt.Errorf("%w: list file mounts: %v", amika.ErrInternal, err)
	}
	items := make([]amika.Volume, 0, len(vols)+len(fms))
	for _, v := range vols {
		items = append(items, toPublicVolume(v, "directory"))
	}
	for _, v := range fms {
		items = append(items, toPublicVolume(v, "file"))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return amika.ListVolumesResult{Items: items}, nil
}

// DeleteVolume deletes tracked volumes or file mounts.
func (s *Service) DeleteVolume(_ context.Context, req amika.DeleteVolumeRequest) (amika.DeleteVolumeResult, error) {
	deleted := make([]string, 0, len(req.Names))
	for _, name := range req.Names {
		if vol, err := s.deps.Volumes.Get(name); err == nil {
			if len(vol.SandboxRefs) > 0 && !req.Force {
				return amika.DeleteVolumeResult{}, fmt.Errorf("%w: volume %q is in use", amika.ErrInvalidArgument, name)
			}
			if err := s.deps.Docker.RemoveVolume(name); err != nil {
				return amika.DeleteVolumeResult{}, fmt.Errorf("%w: %v", amika.ErrDependency, err)
			}
			if err := s.deps.Volumes.Remove(name); err != nil {
				return amika.DeleteVolumeResult{}, fmt.Errorf("%w: %v", amika.ErrInternal, err)
			}
			deleted = append(deleted, name)
			continue
		}
		if fm, err := s.deps.FileMounts.Get(name); err == nil {
			if len(fm.SandboxRefs) > 0 && !req.Force {
				return amika.DeleteVolumeResult{}, fmt.Errorf("%w: volume %q is in use", amika.ErrInvalidArgument, name)
			}
			if fm.CopyPath != "" {
				if err := os.RemoveAll(filepath.Dir(fm.CopyPath)); err != nil {
					return amika.DeleteVolumeResult{}, fmt.Errorf("%w: %v", amika.ErrInternal, err)
				}
			}
			if err := s.deps.FileMounts.Remove(name); err != nil {
				return amika.DeleteVolumeResult{}, fmt.Errorf("%w: %v", amika.ErrInternal, err)
			}
			deleted = append(deleted, name)
			continue
		}
		return amika.DeleteVolumeResult{}, fmt.Errorf("%w: volume %q", amika.ErrNotFound, name)
	}
	return amika.DeleteVolumeResult{Deleted: deleted}, nil
}

// ExtractAuth extracts auth env assignment lines.
func (s *Service) ExtractAuth(_ context.Context, req amika.AuthExtractRequest) (amika.AuthExtractResult, error) {
	result, err := auth.Discover(auth.Options{HomeDir: req.HomeDir, IncludeOAuth: !req.NoOAuth})
	if err != nil {
		return amika.AuthExtractResult{}, fmt.Errorf("%w: %v", amika.ErrDependency, err)
	}
	return amika.AuthExtractResult{Lines: auth.BuildEnvMap(result).Lines(req.WithExport)}, nil
}

func toPublicMounts(mounts []ports.Mount) []amika.Mount {
	out := make([]amika.Mount, 0, len(mounts))
	for _, m := range mounts {
		out = append(out, amika.Mount{Type: m.Type, Source: m.Source, Volume: m.Volume, Target: m.Target, Mode: m.Mode, SnapshotFrom: m.SnapshotFrom})
	}
	return out
}

func toPublicVolume(v ports.VolumeRecord, typ string) amika.Volume {
	return amika.Volume{Name: v.Name, Type: typ, CreatedAt: v.CreatedAt, InUse: len(v.SandboxRefs) > 0, Sandboxes: v.SandboxRefs, SourcePath: v.SourcePath}
}

func toPortMounts(mounts []amika.Mount, volumes []amika.Mount) []ports.Mount {
	out := make([]ports.Mount, 0, len(mounts)+len(volumes))
	for _, m := range mounts {
		out = append(out, ports.Mount{Type: m.Type, Source: m.Source, Volume: m.Volume, Target: m.Target, Mode: m.Mode, SnapshotFrom: m.SnapshotFrom})
	}
	for _, m := range volumes {
		out = append(out, ports.Mount{Type: m.Type, Source: m.Source, Volume: m.Volume, Target: m.Target, Mode: m.Mode, SnapshotFrom: m.SnapshotFrom})
	}
	return out
}
