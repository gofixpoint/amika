package amika

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
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
	if req.SetupScript != "" && req.SetupScriptText != "" {
		return Sandbox{}, fmt.Errorf("%w: SetupScript and SetupScriptText are mutually exclusive", ErrInvalidArgument)
	}
	ports, err := normalizePortBindings(req.Ports)
	if err != nil {
		return Sandbox{}, err
	}

	resolvedImage, err := sandbox.ResolveAndEnsureImage(sandbox.PresetImageOptions{
		Image:              req.Image,
		Preset:             req.Preset,
		ImageFlagChanged:   req.Image != "",
		DefaultBuildPreset: "coder",
	})
	if err != nil {
		return Sandbox{}, fmt.Errorf("%w: %v", ErrDependency, err)
	}
	req.Image = resolvedImage.Image

	mounts := toSandboxMountBindings(req.Mounts, req.Volumes)
	cleanupSetupScript := func() {}
	setupScriptMount, cleanup, err := resolveSetupScriptMount(name, req.SetupScript, req.SetupScriptText)
	if err != nil {
		return Sandbox{}, err
	}
	if setupScriptMount != nil {
		mounts = append(mounts, *setupScriptMount)
		cleanupSetupScript = cleanup
	}
	cleanupGitRepo := func() {}
	if req.GitRepo != "" {
		gitMount, gitCleanup, err := s.resolveGitRepoMount(name, req.GitRepo)
		if err != nil {
			cleanupSetupScript()
			return Sandbox{}, err
		}
		mounts = append(mounts, gitMount)
		cleanupGitRepo = gitCleanup
	}
	containerID, err := sandbox.CreateDockerSandbox(name, req.Image, mounts, req.Env, toSandboxPortBindings(ports))
	if err != nil {
		cleanupSetupScript()
		cleanupGitRepo()
		return Sandbox{}, fmt.Errorf("%w: %v", ErrDependency, err)
	}
	info := sandbox.Info{
		Name:        name,
		Provider:    provider,
		ContainerID: containerID,
		Image:       req.Image,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Preset:      req.Preset,
		Mounts:      mounts,
		Env:         req.Env,
		Ports:       toSandboxPortBindings(ports),
	}
	if err := s.sandboxes.Save(info); err != nil {
		return Sandbox{}, fmt.Errorf("%w: %v", ErrInternal, err)
	}
	return Sandbox{
		Name:        info.Name,
		Provider:    info.Provider,
		ContainerID: info.ContainerID,
		Image:       info.Image,
		CreatedAt:   info.CreatedAt,
		Preset:      info.Preset,
		Mounts:      toMounts(info.Mounts),
		Env:         info.Env,
		Ports:       toPortBindings(info.Ports),
	}, nil
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
		out = append(out, Sandbox{
			Name:        it.Name,
			Provider:    it.Provider,
			ContainerID: it.ContainerID,
			Image:       it.Image,
			CreatedAt:   it.CreatedAt,
			Preset:      it.Preset,
			Mounts:      toMounts(it.Mounts),
			Env:         it.Env,
			Ports:       toPortBindings(it.Ports),
		})
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

func toSandboxMountBindings(mounts []Mount, volumes []Mount) []sandbox.MountBinding {
	out := make([]sandbox.MountBinding, 0, len(mounts)+len(volumes))
	for _, m := range mounts {
		out = append(out, sandbox.MountBinding{Type: m.Type, Source: m.Source, Volume: m.Volume, Target: m.Target, Mode: m.Mode, SnapshotFrom: m.SnapshotFrom})
	}
	for _, m := range volumes {
		out = append(out, sandbox.MountBinding{Type: m.Type, Source: m.Source, Volume: m.Volume, Target: m.Target, Mode: m.Mode, SnapshotFrom: m.SnapshotFrom})
	}
	return out
}

func normalizePortBindings(in []PortBinding) ([]PortBinding, error) {
	out := make([]PortBinding, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, p := range in {
		hostIP := strings.TrimSpace(p.HostIP)
		if hostIP == "" {
			hostIP = "127.0.0.1"
		}
		if p.HostPort < 1 || p.HostPort > 65535 {
			return nil, fmt.Errorf("%w: HostPort %d must be between 1 and 65535", ErrInvalidArgument, p.HostPort)
		}
		if p.ContainerPort < 1 || p.ContainerPort > 65535 {
			return nil, fmt.Errorf("%w: ContainerPort %d must be between 1 and 65535", ErrInvalidArgument, p.ContainerPort)
		}
		protocol := strings.ToLower(strings.TrimSpace(p.Protocol))
		if protocol == "" {
			protocol = "tcp"
		}
		if protocol != "tcp" && protocol != "udp" {
			return nil, fmt.Errorf("%w: Protocol %q must be tcp or udp", ErrInvalidArgument, p.Protocol)
		}
		key := fmt.Sprintf("%s:%d/%s", hostIP, p.HostPort, protocol)
		if seen[key] {
			return nil, fmt.Errorf("%w: duplicate published port binding %s", ErrInvalidArgument, key)
		}
		seen[key] = true
		out = append(out, PortBinding{
			HostIP:        hostIP,
			HostPort:      p.HostPort,
			ContainerPort: p.ContainerPort,
			Protocol:      protocol,
		})
	}
	return out, nil
}

func toSandboxPortBindings(in []PortBinding) []sandbox.PortBinding {
	out := make([]sandbox.PortBinding, 0, len(in))
	for _, p := range in {
		out = append(out, sandbox.PortBinding{
			HostIP:        p.HostIP,
			HostPort:      p.HostPort,
			ContainerPort: p.ContainerPort,
			Protocol:      p.Protocol,
		})
	}
	return out
}

func toPortBindings(in []sandbox.PortBinding) []PortBinding {
	out := make([]PortBinding, 0, len(in))
	for _, p := range in {
		out = append(out, PortBinding{
			HostIP:        p.HostIP,
			HostPort:      p.HostPort,
			ContainerPort: p.ContainerPort,
			Protocol:      p.Protocol,
		})
	}
	return out
}

// parseGitRepoURL validates gitRepo and returns the repository name derived
// from the last path component of the URL (with any .git suffix removed).
func parseGitRepoURL(gitRepo string) (string, error) {
	if gitRepo == "" {
		return "", fmt.Errorf("GitRepo must not be empty")
	}
	switch {
	case strings.HasPrefix(gitRepo, "https://"),
		strings.HasPrefix(gitRepo, "http://"),
		strings.HasPrefix(gitRepo, "ssh://"):
		u, err := url.Parse(gitRepo)
		if err != nil || u.Host == "" {
			return "", fmt.Errorf("%w: invalid GitRepo URL %q", ErrInvalidArgument, gitRepo)
		}
		return repoNameFromPath(u.Path), nil
	case strings.HasPrefix(gitRepo, "file:///"):
		p := strings.TrimPrefix(gitRepo, "file://")
		if !filepath.IsAbs(p) {
			return "", fmt.Errorf("%w: file:// GitRepo must use an absolute path: %q", ErrInvalidArgument, gitRepo)
		}
		return repoNameFromPath(p), nil
	case strings.HasPrefix(gitRepo, "file://"):
		// file:// with non-absolute path (e.g. file://relative) is rejected
		return "", fmt.Errorf("%w: file:// GitRepo must use an absolute path (use file:///...): %q", ErrInvalidArgument, gitRepo)
	}
	// SCP-style: [user@]host:path
	if isScpStyleURL(gitRepo) {
		colon := strings.Index(gitRepo, ":")
		return repoNameFromPath(gitRepo[colon+1:]), nil
	}
	return "", fmt.Errorf("%w: unsupported GitRepo URL scheme %q", ErrInvalidArgument, gitRepo)
}

// repoNameFromPath returns the last path component with any .git suffix removed.
func repoNameFromPath(p string) string {
	name := path.Base(p)
	return strings.TrimSuffix(name, ".git")
}

// isScpStyleURL reports whether s looks like SCP-style SSH syntax: [user@]host:path.
// Strings containing "://" are URL schemes and are not SCP-style.
func isScpStyleURL(s string) bool {
	if strings.Contains(s, "://") {
		return false
	}
	at := strings.Index(s, "@")
	colon := strings.Index(s, ":")
	if colon < 0 {
		return false
	}
	if at >= 0 {
		return colon > at+1
	}
	// no @: host:path — colon must not be at position 0 and path must follow
	return colon > 0 && colon < len(s)-1
}

// resolveGitRepoMount clones gitRepo to a temp directory, copies it into a
// Docker volume, and returns a volume MountBinding targeting the sandbox
// workspace. The returned cleanup func removes the volume on error; call it
// only on failure paths.
func (s *serviceImpl) resolveGitRepoMount(sandboxName, gitRepo string) (sandbox.MountBinding, func(), error) {
	repoName, err := parseGitRepoURL(gitRepo)
	if err != nil {
		return sandbox.MountBinding{}, func() {}, err
	}

	tmpDir, err := os.MkdirTemp("", "amika-git-clone-*")
	if err != nil {
		return sandbox.MountBinding{}, func() {}, fmt.Errorf("%w: create temp dir for git clone: %v", ErrInternal, err)
	}
	cloneDst := filepath.Join(tmpDir, repoName)

	cloneURL := gitRepo
	if strings.HasPrefix(gitRepo, "file:///") {
		cloneURL = strings.TrimPrefix(gitRepo, "file://")
	}

	cmd := exec.Command("git", "clone", cloneURL, cloneDst)
	if out, err := cmd.CombinedOutput(); err != nil {
		_ = os.RemoveAll(tmpDir)
		return sandbox.MountBinding{}, func() {}, fmt.Errorf("%w: git clone %q failed: %s", ErrDependency, gitRepo, strings.TrimSpace(string(out)))
	}

	volumeName := fmt.Sprintf("amika-git-%s-%s-%d", sandboxName, repoName, time.Now().UnixNano())
	if err := sandbox.CreateDockerVolume(volumeName); err != nil {
		_ = os.RemoveAll(tmpDir)
		return sandbox.MountBinding{}, func() {}, fmt.Errorf("%w: create git volume: %v", ErrDependency, err)
	}
	if err := sandbox.CopyHostDirToVolume(volumeName, cloneDst); err != nil {
		_ = os.RemoveAll(tmpDir)
		_ = sandbox.RemoveDockerVolume(volumeName)
		return sandbox.MountBinding{}, func() {}, fmt.Errorf("%w: copy git repo to volume: %v", ErrInternal, err)
	}
	_ = os.RemoveAll(tmpDir) // volume is the source of truth from here

	volInfo := sandbox.VolumeInfo{
		Name:        volumeName,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		CreatedBy:   "git-repo",
		SourcePath:  gitRepo,
		SandboxRefs: []string{sandboxName},
	}
	if err := s.volumes.Save(volInfo); err != nil {
		_ = sandbox.RemoveDockerVolume(volumeName)
		return sandbox.MountBinding{}, func() {}, fmt.Errorf("%w: save git volume state: %v", ErrInternal, err)
	}

	cleanup := func() {
		_ = s.volumes.Remove(volumeName)
		_ = sandbox.RemoveDockerVolume(volumeName)
	}
	mount := sandbox.MountBinding{
		Type:         "volume",
		Volume:       volumeName,
		Target:       path.Join(sandbox.SandboxWorkdir, repoName),
		Mode:         "rw",
		SnapshotFrom: gitRepo,
	}
	return mount, cleanup, nil
}

func resolveSetupScriptMount(name, setupScriptPath, setupScriptText string) (*sandbox.MountBinding, func(), error) {
	const setupScriptTarget = "/opt/setup.sh"

	if setupScriptPath != "" {
		absSetupScript, err := filepath.Abs(setupScriptPath)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: failed to resolve SetupScript path %q: %v", ErrInvalidArgument, setupScriptPath, err)
		}
		if _, err := os.Stat(absSetupScript); err != nil {
			return nil, nil, fmt.Errorf("%w: SetupScript %q is not accessible: %v", ErrInvalidArgument, absSetupScript, err)
		}
		return &sandbox.MountBinding{
			Type:   "bind",
			Source: absSetupScript,
			Target: setupScriptTarget,
			Mode:   "ro",
		}, func() {}, nil
	}
	if setupScriptText == "" {
		return nil, func() {}, nil
	}

	stateDir, err := config.StateDir()
	if err != nil {
		return nil, nil, fmt.Errorf("%w: resolve state directory for SetupScriptText: %v", ErrInternal, err)
	}
	setupScriptDir := filepath.Join(stateDir, "setup-scripts")
	if err := os.MkdirAll(setupScriptDir, 0o755); err != nil {
		return nil, nil, fmt.Errorf("%w: create setup scripts directory: %v", ErrInternal, err)
	}

	prefix := "inline-setup-"
	if trimmedName := strings.TrimSpace(name); trimmedName != "" {
		safeName := strings.NewReplacer("/", "-", "\\", "-", "*", "-").Replace(trimmedName)
		prefix += safeName + "-"
	}
	tmpFile, err := os.CreateTemp(setupScriptDir, prefix+"*.sh")
	if err != nil {
		return nil, nil, fmt.Errorf("%w: create SetupScriptText file: %v", ErrInternal, err)
	}
	defer tmpFile.Close()

	if _, err := tmpFile.WriteString(setupScriptText); err != nil {
		_ = os.Remove(tmpFile.Name())
		return nil, nil, fmt.Errorf("%w: write SetupScriptText file: %v", ErrInternal, err)
	}
	if err := tmpFile.Chmod(0o755); err != nil {
		_ = os.Remove(tmpFile.Name())
		return nil, nil, fmt.Errorf("%w: set permissions on SetupScriptText file: %v", ErrInternal, err)
	}

	return &sandbox.MountBinding{
		Type:   "bind",
		Source: tmpFile.Name(),
		Target: setupScriptTarget,
		Mode:   "ro",
	}, func() { _ = os.Remove(tmpFile.Name()) }, nil
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
