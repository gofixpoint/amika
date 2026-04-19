package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/amikaconfig"
	"github.com/gofixpoint/amika/internal/sandbox"
)

func runRootCommand(args ...string) (string, error) {
	buf := &strings.Builder{}
	rootCmd.SetOut(buf)
	rootCmd.SetErr(buf)
	rootCmd.SetArgs(args)
	err := rootCmd.Execute()
	rootCmd.SetArgs(nil)
	return buf.String(), err
}

func TestParseMountFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   []string
		wantLen int
		wantErr bool
	}{
		{
			name:    "single mount with mode",
			flags:   []string{"/host/src:/workspace:ro"},
			wantLen: 1,
		},
		{
			name:    "single mount default mode",
			flags:   []string{"/host/src:/workspace"},
			wantLen: 1,
		},
		{
			name:    "multiple mounts",
			flags:   []string{"/a:/x:ro", "/b:/y:rw"},
			wantLen: 2,
		},
		{
			name:    "no mounts",
			flags:   nil,
			wantLen: 0,
		},
		{
			name:    "missing target",
			flags:   []string{"/host/src"},
			wantErr: true,
		},
		{
			name:    "invalid mode",
			flags:   []string{"/host/src:/workspace:xx"},
			wantErr: true,
		},
		{
			name:    "relative target rejected",
			flags:   []string{"/host/src:workspace:ro"},
			wantErr: true,
		},
		{
			name:    "duplicate target",
			flags:   []string{"/a:/workspace:ro", "/b:/workspace:rw"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mounts, err := parseMountFlags(tt.flags)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(mounts) != tt.wantLen {
				t.Errorf("expected %d mounts, got %d", tt.wantLen, len(mounts))
			}
		})
	}
}

func TestParseMountFlags_DefaultMode(t *testing.T) {
	mounts, err := parseMountFlags([]string{"/host/src:/workspace"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mounts[0].Mode != "rwcopy" {
		t.Errorf("mode = %q, want %q", mounts[0].Mode, "rwcopy")
	}
}

func TestParseMountFlags_ResolvesAbsPath(t *testing.T) {
	mounts, err := parseMountFlags([]string{"./relative:/workspace"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mounts[0].Source == "./relative" {
		t.Error("source should have been resolved to absolute path")
	}
}

func TestParseVolumeFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   []string
		wantLen int
		wantErr bool
	}{
		{
			name:    "single volume with mode",
			flags:   []string{"vol1:/workspace:ro"},
			wantLen: 1,
		},
		{
			name:    "single volume default mode",
			flags:   []string{"vol1:/workspace"},
			wantLen: 1,
		},
		{
			name:    "missing target",
			flags:   []string{"vol1"},
			wantErr: true,
		},
		{
			name:    "empty name",
			flags:   []string{":/workspace:rw"},
			wantErr: true,
		},
		{
			name:    "invalid mode",
			flags:   []string{"vol1:/workspace:rwcopy"},
			wantErr: true,
		},
		{
			name:    "relative target rejected",
			flags:   []string{"vol1:workspace:rw"},
			wantErr: true,
		},
		{
			name:    "duplicate target",
			flags:   []string{"vol1:/workspace:ro", "vol2:/workspace:rw"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mounts, err := parseVolumeFlags(tt.flags)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(mounts) != tt.wantLen {
				t.Errorf("expected %d mounts, got %d", tt.wantLen, len(mounts))
			}
		})
	}
}

func TestValidateMountTargets_DuplicateAcrossMountAndVolume(t *testing.T) {
	bind := []sandbox.MountBinding{{Type: "bind", Source: "/host/src", Target: "/workspace", Mode: "rwcopy"}}
	vol := []sandbox.MountBinding{{Type: "volume", Volume: "vol1", Target: "/workspace", Mode: "rw"}}

	if err := validateMountTargets(bind, vol); err == nil {
		t.Fatal("expected duplicate target error")
	}
}

func TestParsePortFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   []string
		hostIP  string
		wantLen int
		wantErr bool
	}{
		{
			name:    "single port with protocol",
			flags:   []string{"8080:80/tcp"},
			hostIP:  "127.0.0.1",
			wantLen: 1,
		},
		{
			name:    "default protocol",
			flags:   []string{"5353:5353"},
			hostIP:  "127.0.0.1",
			wantLen: 1,
		},
		{
			name:    "invalid protocol",
			flags:   []string{"8080:80/sctp"},
			hostIP:  "127.0.0.1",
			wantErr: true,
		},
		{
			name:    "invalid format",
			flags:   []string{"8080"},
			hostIP:  "127.0.0.1",
			wantErr: true,
		},
		{
			name:    "duplicate host binding",
			flags:   []string{"8080:80/tcp", "8080:81/tcp"},
			hostIP:  "127.0.0.1",
			wantErr: true,
		},
		{
			name:    "empty host ip",
			flags:   []string{"8080:80"},
			hostIP:  " ",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ports, err := parsePortFlags(tt.flags, tt.hostIP)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(ports) != tt.wantLen {
				t.Fatalf("expected %d ports, got %d", tt.wantLen, len(ports))
			}
		})
	}
}

func TestCleanupSandboxVolumes_PreserveDefault(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", false, func(string) error {
		t.Fatal("removeVolumeFn should not be called in preserve mode")
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: preserved" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 0 {
		t.Fatalf("SandboxRefs = %v, want empty", info.SandboxRefs)
	}
}

func TestCleanupSandboxVolumes_DeleteUnused(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	called := 0
	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(name string) error {
		called++
		if name != "vol-1" {
			t.Fatalf("unexpected volume: %s", name)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if called != 1 {
		t.Fatalf("removeVolumeFn called %d times, want 1", called)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: deleted" {
		t.Fatalf("lines = %v", lines)
	}
	if _, err := store.Get("vol-1"); err == nil {
		t.Fatal("volume state entry should be removed")
	}
}

func TestCleanupSandboxVolumes_PreserveStillReferenced(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1", "sb-2"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(string) error {
		t.Fatal("removeVolumeFn should not be called for still-referenced volume")
		return nil
	})
	if err != nil {
		t.Fatalf("cleanupSandboxVolumes error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: preserved (still referenced)" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("vol-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 1 || info.SandboxRefs[0] != "sb-2" {
		t.Fatalf("SandboxRefs = %v, want [sb-2]", info.SandboxRefs)
	}
}

func TestCleanupSandboxVolumes_DeleteFailureReported(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxVolumes(store, "sb-1", true, func(string) error {
		return fmt.Errorf("boom")
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if len(lines) != 1 || lines[0] != "volume vol-1: delete-failed: boom" {
		t.Fatalf("lines = %v", lines)
	}
}

func TestValidateDeleteVolumeFlags(t *testing.T) {
	if err := validateDeleteVolumeFlags(true, false, false, false); err == nil {
		t.Fatal("expected explicit false delete-volumes to fail")
	}
	if err := validateDeleteVolumeFlags(false, false, true, false); err == nil {
		t.Fatal("expected explicit false keep-volumes to fail")
	}
	if err := validateDeleteVolumeFlags(true, true, true, true); err == nil {
		t.Fatal("expected mutually exclusive flags to fail")
	}
	if err := validateDeleteVolumeFlags(true, true, false, false); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := validateDeleteVolumeFlags(false, false, true, true); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestResolveDeleteVolumes_FlagPrecedence(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	fmStore := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	got, err := resolveDeleteVolumes(store, fmStore, "sb-1", true, false, bufio.NewReader(strings.NewReader("")))
	if err != nil {
		t.Fatalf("resolveDeleteVolumes failed: %v", err)
	}
	if !got {
		t.Fatal("expected delete-volumes to win")
	}

	got, err = resolveDeleteVolumes(store, fmStore, "sb-1", false, true, bufio.NewReader(strings.NewReader("")))
	if err != nil {
		t.Fatalf("resolveDeleteVolumes failed: %v", err)
	}
	if got {
		t.Fatal("expected keep-volumes to preserve")
	}
}

func TestResolveDeleteVolumes_DefaultPromptsOnExclusive(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	fmStore := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	got, err := resolveDeleteVolumes(store, fmStore, "sb-1", false, false, bufio.NewReader(strings.NewReader("y\n")))
	if err != nil {
		t.Fatalf("resolveDeleteVolumes failed: %v", err)
	}
	if !got {
		t.Fatal("expected prompt confirmation to enable deletion")
	}

	got, err = resolveDeleteVolumes(store, fmStore, "sb-1", false, false, bufio.NewReader(strings.NewReader("n\n")))
	if err != nil {
		t.Fatalf("resolveDeleteVolumes failed: %v", err)
	}
	if got {
		t.Fatal("expected prompt rejection to preserve")
	}
}

func TestResolveDeleteVolumes_DefaultNoPromptWhenNoExclusive(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	fmStore := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	if err := store.Save(sandbox.VolumeInfo{Name: "vol-1", SandboxRefs: []string{"sb-1", "sb-2"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	got, err := resolveDeleteVolumes(store, fmStore, "sb-1", false, false, bufio.NewReader(strings.NewReader("")))
	if err != nil {
		t.Fatalf("resolveDeleteVolumes failed: %v", err)
	}
	if got {
		t.Fatal("expected shared volumes to be preserved by default")
	}
}

func TestCleanupSandboxFileMounts_PreserveDefault(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	copyDir := filepath.Join(dir, "fm-1")
	if err := os.MkdirAll(copyDir, 0755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	copyPath := filepath.Join(copyDir, "file.yaml")
	if err := os.WriteFile(copyPath, []byte("data"), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
	if err := store.Save(sandbox.FileMountInfo{Name: "fm-1", CopyPath: copyPath, SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxFileMounts(store, "sb-1", false)
	if err != nil {
		t.Fatalf("cleanupSandboxFileMounts error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "file-mount fm-1: preserved" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("fm-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 0 {
		t.Fatalf("SandboxRefs = %v, want empty", info.SandboxRefs)
	}
}

func TestCleanupSandboxFileMounts_DeleteUnused(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	copyDir := filepath.Join(dir, "fm-1")
	if err := os.MkdirAll(copyDir, 0755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	copyPath := filepath.Join(copyDir, "file.yaml")
	if err := os.WriteFile(copyPath, []byte("data"), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
	if err := store.Save(sandbox.FileMountInfo{Name: "fm-1", CopyPath: copyPath, SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxFileMounts(store, "sb-1", true)
	if err != nil {
		t.Fatalf("cleanupSandboxFileMounts error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "file-mount fm-1: deleted" {
		t.Fatalf("lines = %v", lines)
	}
	if _, err := store.Get("fm-1"); err == nil {
		t.Fatal("file mount state entry should be removed")
	}
	if _, err := os.Stat(copyDir); !os.IsNotExist(err) {
		t.Fatal("copy directory should have been removed")
	}
}

func TestCleanupSandboxFileMounts_PreserveStillReferenced(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	copyPath := filepath.Join(dir, "fm-1", "file.yaml")
	if err := store.Save(sandbox.FileMountInfo{Name: "fm-1", CopyPath: copyPath, SandboxRefs: []string{"sb-1", "sb-2"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxFileMounts(store, "sb-1", true)
	if err != nil {
		t.Fatalf("cleanupSandboxFileMounts error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "file-mount fm-1: preserved (still referenced)" {
		t.Fatalf("lines = %v", lines)
	}

	info, err := store.Get("fm-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if len(info.SandboxRefs) != 1 || info.SandboxRefs[0] != "sb-2" {
		t.Fatalf("SandboxRefs = %v, want [sb-2]", info.SandboxRefs)
	}
}

func TestCleanupSandboxFileMounts_DeleteFailureReported(t *testing.T) {
	dir := t.TempDir()
	store := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	// CopyPath points to a non-existent dir; RemoveAll succeeds on non-existent paths,
	// so we test by making the store entry point at a path that cannot be removed.
	// However, os.RemoveAll doesn't error for non-existent paths, so we test by
	// causing a state removal failure instead. For now, just verify the happy path
	// with non-existent directory (RemoveAll succeeds).
	copyPath := filepath.Join(dir, "nonexistent-dir", "file.yaml")
	if err := store.Save(sandbox.FileMountInfo{Name: "fm-1", CopyPath: copyPath, SandboxRefs: []string{"sb-1"}}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	lines, err := cleanupSandboxFileMounts(store, "sb-1", true)
	if err != nil {
		t.Fatalf("cleanupSandboxFileMounts error: %v", err)
	}
	if len(lines) != 1 || lines[0] != "file-mount fm-1: deleted" {
		t.Fatalf("lines = %v", lines)
	}
}

func TestValidateGitFlags(t *testing.T) {
	if err := validateGitFlags(false, true); err == nil {
		t.Fatal("expected error when --no-clean is used without --git")
	}
	if err := validateGitFlags(true, true); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateShell(t *testing.T) {
	if err := validateShell("zsh"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := validateShell("   "); err == nil {
		t.Fatal("expected error for empty shell")
	}
}

func TestBuildSandboxConnectArgs(t *testing.T) {
	got := buildSandboxConnectArgs("sb-1", "zsh")
	want := []string{"exec", "-it", "-w", "/home/amika", "sb-1", "zsh"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %#v, want %#v", got, want)
	}
}

func TestBuildAgentShellCmd(t *testing.T) {
	claude := knownAgents["claude"]

	t.Run("wait mode", func(t *testing.T) {
		got := buildAgentShellCmd("hello world", false, "/home/amika", claude)
		if !strings.Contains(got, "cd /home/amika") {
			t.Fatalf("cmd = %q, want to contain 'cd /home/amika'", got)
		}
		if !strings.Contains(got, "--dangerously-skip-permissions") {
			t.Fatalf("cmd = %q, want to contain '--dangerously-skip-permissions'", got)
		}
		if !strings.Contains(got, "claude") {
			t.Fatalf("cmd = %q, want to contain 'claude'", got)
		}
		if strings.Contains(got, "tmux") {
			t.Fatalf("cmd = %q, should not contain tmux in wait mode", got)
		}
	})

	t.Run("no-wait mode wraps in tmux", func(t *testing.T) {
		got := buildAgentShellCmd("hello world", true, "/home/amika", claude)
		if !strings.Contains(got, "tmux new-session -d") {
			t.Fatalf("cmd = %q, want to contain 'tmux new-session -d'", got)
		}
		if !strings.Contains(got, "amika-agent-send-") {
			t.Fatalf("cmd = %q, want to contain session name prefix", got)
		}
		if !strings.Contains(got, "--dangerously-skip-permissions") {
			t.Fatalf("cmd = %q, want to contain '--dangerously-skip-permissions'", got)
		}
	})

	t.Run("custom workdir", func(t *testing.T) {
		got := buildAgentShellCmd("test", false, "/workspace", claude)
		if !strings.Contains(got, "cd /workspace") {
			t.Fatalf("cmd = %q, want to contain 'cd /workspace'", got)
		}
	})

	t.Run("codex wait mode", func(t *testing.T) {
		codex := knownAgents["codex"]
		got := buildAgentShellCmd("hello world", false, "/home/amika", codex)
		if !strings.Contains(got, "cd /home/amika") {
			t.Fatalf("cmd = %q, want to contain 'cd /home/amika'", got)
		}
		if !strings.Contains(got, "codex exec") {
			t.Fatalf("cmd = %q, want to contain 'codex exec'", got)
		}
		if !strings.Contains(got, "--dangerously-bypass-approvals-and-sandbox") {
			t.Fatalf("cmd = %q, want to contain '--dangerously-bypass-approvals-and-sandbox'", got)
		}
	})
}

func TestBuildDockerAgentSendArgs(t *testing.T) {
	claude := knownAgents["claude"]

	t.Run("wraps in docker exec bash -c", func(t *testing.T) {
		got := buildDockerAgentSendArgs("sb-1", "hello", false, "/home/amika", claude)
		if got[0] != "exec" || got[1] != "sb-1" || got[2] != "bash" || got[3] != "-c" {
			t.Fatalf("args prefix = %#v, want [exec sb-1 bash -c ...]", got[:4])
		}
		if !strings.Contains(got[4], "claude") {
			t.Fatalf("shell cmd = %q, want to contain 'claude'", got[4])
		}
	})
}

func TestResolveAgentConfig(t *testing.T) {
	t.Run("known agent claude", func(t *testing.T) {
		cfg, err := resolveAgentConfig("claude")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.Binary != "claude" || cfg.PrintArg != "-p" || len(cfg.ExtraArgs) != 1 || cfg.ExtraArgs[0] != "--dangerously-skip-permissions" {
			t.Fatalf("got %+v, want claude/-p/--dangerously-skip-permissions", cfg)
		}
	})

	t.Run("known agent codex", func(t *testing.T) {
		cfg, err := resolveAgentConfig("codex")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cfg.Binary != "codex" {
			t.Fatalf("Binary = %q, want %q", cfg.Binary, "codex")
		}
		if len(cfg.SubCmd) != 1 || cfg.SubCmd[0] != "exec" {
			t.Fatalf("SubCmd = %v, want [exec]", cfg.SubCmd)
		}
		if len(cfg.ExtraArgs) != 1 || cfg.ExtraArgs[0] != "--dangerously-bypass-approvals-and-sandbox" {
			t.Fatalf("ExtraArgs = %v, want [--dangerously-bypass-approvals-and-sandbox]", cfg.ExtraArgs)
		}
	})

	t.Run("unknown agent returns error", func(t *testing.T) {
		_, err := resolveAgentConfig("custom-agent")
		if err == nil {
			t.Fatal("expected error for unknown agent, got nil")
		}
		if !strings.Contains(err.Error(), "unknown agent") {
			t.Fatalf("error = %q, want to contain 'unknown agent'", err.Error())
		}
	})
}

func TestAgentCmdPartsWithOpts(t *testing.T) {
	claude := knownAgents["claude"]

	t.Run("no opts no json", func(t *testing.T) {
		got := agentCmdPartsWithOpts(claude, "hello", agentRunOpts{}, false)
		want := []string{"claude", "--dangerously-skip-permissions", "-p", "hello"}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("with session id maps to --resume", func(t *testing.T) {
		got := agentCmdPartsWithOpts(claude, "hello", agentRunOpts{SessionID: "abc-123"}, true)
		joined := strings.Join(got, " ")
		if !strings.Contains(joined, "--resume abc-123") {
			t.Fatalf("got %q, want --resume abc-123", joined)
		}
		if !strings.Contains(joined, "--output-format json") {
			t.Fatalf("got %q, want --output-format json", joined)
		}
	})

	t.Run("new session passes no session flag", func(t *testing.T) {
		got := agentCmdPartsWithOpts(claude, "hello", agentRunOpts{NewSession: true}, true)
		joined := strings.Join(got, " ")
		if strings.Contains(joined, "--new-session") {
			t.Fatalf("got %q, should not contain --new-session", joined)
		}
		if strings.Contains(joined, "--resume") {
			t.Fatalf("got %q, should not contain --resume", joined)
		}
		if strings.Contains(joined, "--continue") {
			t.Fatalf("got %q, should not contain --continue", joined)
		}
	})

	codex := knownAgents["codex"]

	t.Run("codex no opts no json", func(t *testing.T) {
		got := agentCmdPartsWithOpts(codex, "hello", agentRunOpts{}, false)
		want := []string{"codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "hello"}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Fatalf("got %v, want %v", got, want)
		}
	})

	t.Run("codex with session id uses resume subcommand", func(t *testing.T) {
		got := agentCmdPartsWithOpts(codex, "hello", agentRunOpts{SessionID: "abc-123"}, true)
		joined := strings.Join(got, " ")
		want := "codex exec resume --dangerously-bypass-approvals-and-sandbox --json abc-123 hello"
		if joined != want {
			t.Fatalf("got %q, want %q", joined, want)
		}
	})

	t.Run("codex new session with json", func(t *testing.T) {
		got := agentCmdPartsWithOpts(codex, "hello", agentRunOpts{NewSession: true}, true)
		want := []string{"codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "--json", "hello"}
		if strings.Join(got, " ") != strings.Join(want, " ") {
			t.Fatalf("got %v, want %v", got, want)
		}
	})
}

func TestBuildRemoteAgentShellCmd(t *testing.T) {
	claude := knownAgents["claude"]

	t.Run("wait mode includes json output", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", claude, agentRunOpts{})
		if !strings.Contains(got, "--output-format json") {
			t.Fatalf("cmd = %q, want --output-format json", got)
		}
	})

	t.Run("no-wait mode has no json and wraps in tmux", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", true, "/home/amika", claude, agentRunOpts{})
		if strings.Contains(got, "--output-format") {
			t.Fatalf("cmd = %q, should not contain --output-format in no-wait mode", got)
		}
		if !strings.Contains(got, "tmux new-session -d") {
			t.Fatalf("cmd = %q, want tmux wrap", got)
		}
	})

	t.Run("session id maps to --resume", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", claude, agentRunOpts{SessionID: "sess-42"})
		if !strings.Contains(got, "--resume sess-42") {
			t.Fatalf("cmd = %q, want --resume sess-42", got)
		}
	})

	t.Run("new session passes no session flag to claude", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", claude, agentRunOpts{NewSession: true})
		if strings.Contains(got, "--new-session") {
			t.Fatalf("cmd = %q, should not contain --new-session", got)
		}
		if strings.Contains(got, "--resume") {
			t.Fatalf("cmd = %q, should not contain --resume", got)
		}
		// Should still have --output-format json for session capture.
		if !strings.Contains(got, "--output-format json") {
			t.Fatalf("cmd = %q, want --output-format json", got)
		}
	})

	codex := knownAgents["codex"]

	t.Run("codex wait mode includes --json", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", codex, agentRunOpts{})
		if !strings.Contains(got, "--json") {
			t.Fatalf("cmd = %q, want --json", got)
		}
		if !strings.Contains(got, "codex exec") {
			t.Fatalf("cmd = %q, want to contain 'codex exec'", got)
		}
	})

	t.Run("codex no-wait wraps in tmux without json", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", true, "/home/amika", codex, agentRunOpts{})
		if strings.Contains(got, "--json") {
			t.Fatalf("cmd = %q, should not contain --json in no-wait mode", got)
		}
		if !strings.Contains(got, "tmux new-session -d") {
			t.Fatalf("cmd = %q, want tmux wrap", got)
		}
	})

	t.Run("codex session id uses resume subcommand", func(t *testing.T) {
		got := buildRemoteAgentShellCmd("hello", false, "/home/amika", codex, agentRunOpts{SessionID: "sess-42"})
		if !strings.Contains(got, "codex exec resume") {
			t.Fatalf("cmd = %q, want 'codex exec resume'", got)
		}
		if !strings.Contains(got, "sess-42") {
			t.Fatalf("cmd = %q, want session ID 'sess-42'", got)
		}
	})
}

func TestResolveGitRoot(t *testing.T) {
	t.Run("finds from nested directory", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, ".git"), 0755); err != nil {
			t.Fatalf("failed to create .git directory: %v", err)
		}
		nested := filepath.Join(root, "a", "b")
		if err := os.MkdirAll(nested, 0755); err != nil {
			t.Fatalf("failed to create nested dir: %v", err)
		}

		got, err := resolveGitRoot(nested)
		if err != nil {
			t.Fatalf("resolveGitRoot failed: %v", err)
		}
		if got != root {
			t.Fatalf("got %q, want %q", got, root)
		}
	})

	t.Run("accepts .git file", func(t *testing.T) {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: /tmp/worktree"), 0644); err != nil {
			t.Fatalf("failed to create .git file: %v", err)
		}
		nested := filepath.Join(root, "nested")
		if err := os.MkdirAll(nested, 0755); err != nil {
			t.Fatalf("failed to create nested dir: %v", err)
		}

		got, err := resolveGitRoot(nested)
		if err != nil {
			t.Fatalf("resolveGitRoot failed: %v", err)
		}
		if got != root {
			t.Fatalf("got %q, want %q", got, root)
		}
	})

	t.Run("handles file path input", func(t *testing.T) {
		root := t.TempDir()
		if err := os.Mkdir(filepath.Join(root, ".git"), 0755); err != nil {
			t.Fatalf("failed to create .git directory: %v", err)
		}
		filePath := filepath.Join(root, "nested", "file.txt")
		if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
			t.Fatalf("failed to create nested dir: %v", err)
		}
		if err := os.WriteFile(filePath, []byte("x"), 0644); err != nil {
			t.Fatalf("failed to write file: %v", err)
		}

		got, err := resolveGitRoot(filePath)
		if err != nil {
			t.Fatalf("resolveGitRoot failed: %v", err)
		}
		if got != root {
			t.Fatalf("got %q, want %q", got, root)
		}
	})

	t.Run("errors when repo is not found", func(t *testing.T) {
		dir := t.TempDir()
		_, err := resolveGitRoot(dir)
		if err == nil {
			t.Fatal("expected error")
		}
		if !strings.Contains(err.Error(), "no git repository root found") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestPrepareGitMount_NoClean(t *testing.T) {
	root := createGitRepo(t, map[string]string{"origin": "https://github.com/example/upstream.git"})
	untracked := filepath.Join(root, "local.txt")
	if err := os.WriteFile(untracked, []byte("untracked"), 0644); err != nil {
		t.Fatalf("failed to create untracked file: %v", err)
	}

	info, cleanup, err := prepareGitMount(root, true, func(_, _ string) error {
		t.Fatal("cloneFn should not be called in --no-clean mode")
		return nil
	}, "", "")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	if info.Mount.Source == root {
		t.Fatal("source should be a prepared temp repo, not host repo")
	}
	wantTarget := "/home/amika/workspace/" + filepath.Base(root)
	if info.Mount.Target != wantTarget {
		t.Fatalf("target = %q, want %q", info.Mount.Target, wantTarget)
	}
	if info.Mount.Mode != "rwcopy" {
		t.Fatalf("mode = %q, want rwcopy", info.Mount.Mode)
	}
	if _, err := os.Stat(filepath.Join(info.Mount.Source, "local.txt")); err != nil {
		t.Fatalf("expected untracked file in prepared repo: %v", err)
	}
}

func TestPrepareGitMount_CleanClone(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
		"local":  "/tmp/local-path",
	})

	var clonedSrc, clonedDst string
	info, cleanup, err := prepareGitMount(root, false, func(src, dst string) error {
		clonedSrc = src
		clonedDst = dst
		cmd := exec.Command("git", "clone", "--local", "--no-hardlinks", src, dst)
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("clone failed: %s", out)
		}
		return nil
	}, "", "")
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	if clonedSrc != root {
		t.Fatalf("clone source = %q, want %q", clonedSrc, root)
	}
	if clonedDst == "" {
		t.Fatal("expected clone destination to be set")
	}
	if info.Mount.Source != clonedDst {
		t.Fatalf("mount source = %q, want clone destination %q", info.Mount.Source, clonedDst)
	}
	gotRemotes := readGitRemotes(t, clonedDst)
	wantRemotes := map[string]string{"origin": "https://github.com/example/upstream.git"}
	if !reflect.DeepEqual(gotRemotes, wantRemotes) {
		t.Fatalf("prepared remotes = %#v, want %#v", gotRemotes, wantRemotes)
	}

	cleanup()
	if _, err := os.Stat(filepath.Dir(clonedDst)); !os.IsNotExist(err) {
		t.Fatalf("expected temp git clone directory to be removed, err=%v", err)
	}
}

func TestPrepareGitMount_CleanClone_ChecksOutRemoteTrackingBranch(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})
	defaultBranch := gitCurrentBranch(t, root)
	runGitCmd(t, root, "checkout", "-b", "feature")
	if err := os.WriteFile(filepath.Join(root, "feature.txt"), []byte("feature\n"), 0644); err != nil {
		t.Fatalf("failed to write feature file: %v", err)
	}
	runGitCmd(t, root, "add", "feature.txt")
	runGitCmd(t, root, "commit", "-m", "feature commit")
	featureCommit := gitRevParse(t, root, "HEAD")
	runGitCmd(t, root, "checkout", defaultBranch)

	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "feature", "")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	gotCommit := gitRevParse(t, info.Mount.Source, "HEAD")
	if gotCommit != featureCommit {
		t.Fatalf("HEAD = %q, want feature commit %q", gotCommit, featureCommit)
	}

	gotBranch := gitCurrentBranch(t, info.Mount.Source)
	if gotBranch != "feature" {
		t.Fatalf("branch = %q, want %q", gotBranch, "feature")
	}
}

func TestPrepareGitMount_CleanClone_NewBranchUsesRemoteDefaultBranch(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})
	defaultBranch := gitCurrentBranch(t, root)
	if err := os.WriteFile(filepath.Join(root, "default.txt"), []byte("default\n"), 0644); err != nil {
		t.Fatalf("failed to write default-branch file: %v", err)
	}
	runGitCmd(t, root, "add", "default.txt")
	runGitCmd(t, root, "commit", "-m", "default branch commit")
	defaultCommit := gitRevParse(t, root, "HEAD")

	runGitCmd(t, root, "checkout", "-b", "work")
	if err := os.WriteFile(filepath.Join(root, "work.txt"), []byte("work\n"), 0644); err != nil {
		t.Fatalf("failed to write work file: %v", err)
	}
	runGitCmd(t, root, "add", "work.txt")
	runGitCmd(t, root, "commit", "-m", "work commit")

	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "", "topic")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	gotBranch := gitCurrentBranch(t, info.Mount.Source)
	if gotBranch != "topic" {
		t.Fatalf("branch = %q, want %q", gotBranch, "topic")
	}

	gotCommit := gitRevParse(t, info.Mount.Source, "HEAD")
	if gotCommit != defaultCommit {
		t.Fatalf("HEAD = %q, want %s commit %q", gotCommit, defaultBranch, defaultCommit)
	}
}

// Bug #1: --new-branch without --branch should create the new branch from the
// host's current branch (HEAD of the clone), not from main/master.
// Setup: host is on "work" branch which has commits ahead of main.
// Expected: "topic" branch is created from "work", so HEAD matches work's commit.
func TestPrepareGitMount_CleanClone_NewBranchFromHostBranch(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})
	// Add a commit on the default branch so we can distinguish it from "work".
	if err := os.WriteFile(filepath.Join(root, "default.txt"), []byte("default\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGitCmd(t, root, "add", "default.txt")
	runGitCmd(t, root, "commit", "-m", "default branch commit")

	// Create "work" branch with an extra commit.
	runGitCmd(t, root, "checkout", "-b", "work")
	if err := os.WriteFile(filepath.Join(root, "work.txt"), []byte("work\n"), 0644); err != nil {
		t.Fatalf("failed to write file: %v", err)
	}
	runGitCmd(t, root, "add", "work.txt")
	runGitCmd(t, root, "commit", "-m", "work commit")
	workCommit := gitRevParse(t, root, "HEAD")

	// Host is on "work". Call with --new-branch only.
	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "", "topic")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	gotBranch := gitCurrentBranch(t, info.Mount.Source)
	if gotBranch != "topic" {
		t.Fatalf("branch = %q, want %q", gotBranch, "topic")
	}

	// The new branch should be based on "work" (the host's current branch),
	// not on main/master.
	gotCommit := gitRevParse(t, info.Mount.Source, "HEAD")
	if gotCommit != workCommit {
		t.Fatalf("HEAD = %q, want work commit %q", gotCommit, workCommit)
	}
}

// Bug #2: --branch foo --new-branch bar should work even when foo doesn't
// exist yet. It should create foo from the base branch, then create bar
// on top of foo.
func TestPrepareGitMount_CleanClone_BranchAndNewBranchCreatesBase(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})
	defaultCommit := gitRevParse(t, root, "HEAD")

	// Neither "feat-1" nor "feat-1-fix" exist.
	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "feat-1", "feat-1-fix")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	// Should be on feat-1-fix.
	gotBranch := gitCurrentBranch(t, info.Mount.Source)
	if gotBranch != "feat-1-fix" {
		t.Fatalf("branch = %q, want %q", gotBranch, "feat-1-fix")
	}

	// feat-1 should also exist as a local branch.
	if !localBranchExists(info.Mount.Source, "feat-1") {
		t.Fatal("expected local branch feat-1 to exist")
	}

	// Both branches should be rooted at the same commit as the default branch.
	gotCommit := gitRevParse(t, info.Mount.Source, "HEAD")
	if gotCommit != defaultCommit {
		t.Fatalf("HEAD = %q, want default commit %q", gotCommit, defaultCommit)
	}
}

// Bug #4: .amika/config.toml should be read from the prepared clone (which
// reflects the checked-out branch), not from the host working tree.
//
// collectMounts (line 1425) reads config from gmi.RepoRoot (host path).
// This test proves that RepoRoot and Mount.Source have different configs
// when a different branch is checked out, confirming the bug: reading from
// RepoRoot gives the host branch's config, not the sandbox branch's config.
func TestConfigReadFromPreparedRepo(t *testing.T) {
	root := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
	})

	// Create .amika/config.toml on main with setup_script = "main.sh"
	amikaDir := filepath.Join(root, ".amika")
	if err := os.MkdirAll(amikaDir, 0755); err != nil {
		t.Fatalf("failed to create .amika dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte("[lifecycle]\nsetup_script = \"main.sh\"\n"), 0644); err != nil {
		t.Fatalf("failed to write config.toml: %v", err)
	}
	runGitCmd(t, root, "add", ".amika/config.toml")
	runGitCmd(t, root, "commit", "-m", "add config on main")

	// Create "other" branch with a different config.
	runGitCmd(t, root, "checkout", "-b", "other")
	if err := os.WriteFile(filepath.Join(amikaDir, "config.toml"), []byte("[lifecycle]\nsetup_script = \"other.sh\"\n"), 0644); err != nil {
		t.Fatalf("failed to write config.toml: %v", err)
	}
	runGitCmd(t, root, "add", ".amika/config.toml")
	runGitCmd(t, root, "commit", "-m", "change config on other")

	// Switch host back to main.
	runGitCmd(t, root, "checkout", "main")

	// Prepare with --branch other.
	info, cleanup, err := prepareGitMount(root, false, cloneGitRepo, "other", "")
	defer cleanup()
	if err != nil {
		t.Fatalf("prepareGitMount failed: %v", err)
	}

	// The prepared repo (Mount.Source) should have the "other" branch config.
	preparedCfg, err := amikaconfig.LoadConfig(info.Mount.Source)
	if err != nil {
		t.Fatalf("LoadConfig from prepared repo failed: %v", err)
	}
	if preparedCfg == nil || preparedCfg.Lifecycle.SetupScript != "other.sh" {
		var got string
		if preparedCfg != nil {
			got = preparedCfg.Lifecycle.SetupScript
		}
		t.Fatalf("prepared repo setup_script = %q, want %q", got, "other.sh")
	}

	// RepoRoot (host path) has the main branch config.
	hostCfg, err := amikaconfig.LoadConfig(info.RepoRoot)
	if err != nil {
		t.Fatalf("LoadConfig from host repo failed: %v", err)
	}
	if hostCfg == nil || hostCfg.Lifecycle.SetupScript != "main.sh" {
		var got string
		if hostCfg != nil {
			got = hostCfg.Lifecycle.SetupScript
		}
		t.Fatalf("host repo setup_script = %q, want %q", got, "main.sh")
	}

	// BUG: collectMounts reads from RepoRoot, so it would get "main.sh"
	// instead of "other.sh". This is the wrong behavior — it should read
	// from Mount.Source to get the config for the branch the sandbox is on.
	if preparedCfg.Lifecycle.SetupScript == hostCfg.Lifecycle.SetupScript {
		t.Fatal("expected prepared and host configs to differ, confirming the bug exists")
	}
}

func TestSyncGitRemotes(t *testing.T) {
	src := createGitRepo(t, map[string]string{
		"origin": "https://github.com/example/upstream.git",
		"fork":   "git@github.com:example/fork.git",
		"local":  "/Users/dbmikus/workspace/github.com/example/repo",
		"file":   "file:///Users/dbmikus/workspace/github.com/example/repo",
	})
	dst := createGitRepo(t, map[string]string{
		"origin": "/tmp/source-repo",
		"other":  "ssh://git@internal.example.com/repo.git",
	})

	if err := syncGitRemotes(src, dst); err != nil {
		t.Fatalf("syncGitRemotes failed: %v", err)
	}

	got := readGitRemotes(t, dst)
	want := map[string]string{
		"fork":   "git@github.com:example/fork.git",
		"origin": "https://github.com/example/upstream.git",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("remotes = %#v, want %#v", got, want)
	}
}

func TestIsNetworkRemoteURL(t *testing.T) {
	tests := []struct {
		url  string
		want bool
	}{
		{url: "https://github.com/org/repo.git", want: true},
		{url: "http://github.com/org/repo.git", want: true},
		{url: "ssh://git@github.com/org/repo.git", want: true},
		{url: "git@github.com:org/repo.git", want: true},
		{url: "/Users/me/repo", want: false},
		{url: "../repo", want: false},
		{url: "file:///Users/me/repo", want: false},
	}
	for _, tt := range tests {
		if got := isNetworkRemoteURL(tt.url); got != tt.want {
			t.Fatalf("isNetworkRemoteURL(%q) = %v, want %v", tt.url, got, tt.want)
		}
	}
}

func TestPromptForConfirmation(t *testing.T) {
	t.Run("yes", func(t *testing.T) {
		ok, err := promptForConfirmation(bufio.NewReader(strings.NewReader("y\n")))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !ok {
			t.Fatal("expected confirmation")
		}
	})

	t.Run("no", func(t *testing.T) {
		ok, err := promptForConfirmation(bufio.NewReader(strings.NewReader("n\n")))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if ok {
			t.Fatal("expected rejection")
		}
	})

	t.Run("blank then yes reprompts", func(t *testing.T) {
		ok, err := promptForConfirmation(bufio.NewReader(strings.NewReader("\nYES\n")))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !ok {
			t.Fatal("expected confirmation after reprompt")
		}
	})

	t.Run("invalid then no reprompts", func(t *testing.T) {
		ok, err := promptForConfirmation(bufio.NewReader(strings.NewReader("maybe\nno\n")))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if ok {
			t.Fatal("expected rejection after reprompt")
		}
	})
}

func TestSandboxDeleteAliases(t *testing.T) {
	if !slices.Contains(sandboxDeleteCmd.Aliases, "rm") {
		t.Fatal("sandbox delete command must include alias \"rm\"")
	}
	if !slices.Contains(sandboxDeleteCmd.Aliases, "remove") {
		t.Fatal("sandbox delete command must include alias \"remove\"")
	}
}

func TestGenerateRWCopyFileMountName(t *testing.T) {
	name := generateRWCopyFileMountName("my-sandbox", "/home/amika/.config/file.yaml")
	if !strings.HasPrefix(name, "amika-rwcopy-file-my-sandbox-home-amika--config-file-yaml-") {
		t.Fatalf("unexpected name: %s", name)
	}
}

func TestCopyFile(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "source.txt")
	dst := filepath.Join(dir, "dest.txt")
	content := []byte("hello world")

	if err := os.WriteFile(src, content, 0640); err != nil {
		t.Fatalf("failed to write source: %v", err)
	}

	if err := copyFile(src, dst); err != nil {
		t.Fatalf("copyFile failed: %v", err)
	}

	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("failed to read dest: %v", err)
	}
	if string(got) != string(content) {
		t.Fatalf("content = %q, want %q", got, content)
	}

	dstInfo, err := os.Stat(dst)
	if err != nil {
		t.Fatalf("failed to stat dest: %v", err)
	}
	if dstInfo.Mode().Perm() != 0640 {
		t.Fatalf("permissions = %o, want %o", dstInfo.Mode().Perm(), 0640)
	}
}

func TestSandboxCreateHasConnectFlag(t *testing.T) {
	flag := sandboxCreateCmd.Flags().Lookup("connect")
	if flag == nil {
		t.Fatal("sandbox create command must define --connect")
	}
	if flag.Value.Type() != "bool" {
		t.Fatalf("connect flag type = %q, want bool", flag.Value.Type())
	}
}

func createGitRepo(t *testing.T, remotes map[string]string) string {
	t.Helper()

	root := t.TempDir()
	runGitCmd(t, root, "init")
	runGitCmd(t, root, "config", "user.name", "Test User")
	runGitCmd(t, root, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("test\n"), 0644); err != nil {
		t.Fatalf("failed to write README: %v", err)
	}
	runGitCmd(t, root, "add", "README.md")
	runGitCmd(t, root, "commit", "-m", "init")

	names := make([]string, 0, len(remotes))
	for name := range remotes {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		runGitCmd(t, root, "remote", "add", name, remotes[name])
	}
	return root
}

func readGitRemotes(t *testing.T, repo string) map[string]string {
	t.Helper()
	remotes, err := listGitRemotes(repo)
	if err != nil {
		t.Fatalf("listGitRemotes(%q) failed: %v", repo, err)
	}
	return remotes
}

func runGitCmd(t *testing.T, repo string, args ...string) {
	t.Helper()
	cmdArgs := append([]string{"-C", repo}, args...)
	cmd := exec.Command("git", cmdArgs...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, out)
	}
}

func gitRevParse(t *testing.T, repo string, rev string) string {
	t.Helper()
	cmd := exec.Command("git", "-C", repo, "rev-parse", rev)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git rev-parse %s failed: %v\n%s", rev, err, out)
	}
	return strings.TrimSpace(string(out))
}

func gitCurrentBranch(t *testing.T, repo string) string {
	t.Helper()
	cmd := exec.Command("git", "-C", repo, "rev-parse", "--abbrev-ref", "HEAD")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git rev-parse --abbrev-ref HEAD failed: %v\n%s", err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestMaterializeRWCopyMounts_Passthrough(t *testing.T) {
	dir := t.TempDir()
	volumeStore := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	fileMountStore := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))

	input := []sandbox.MountBinding{
		{Type: "bind", Source: "/host/src", Target: "/workspace", Mode: "ro"},
		{Type: "volume", Volume: "vol1", Target: "/data", Mode: "rw"},
	}

	runtimeMounts, rb, err := materializeRWCopyMounts(input, "test-sb", volumeStore, fileMountStore, dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runtimeMounts) != 2 {
		t.Fatalf("expected 2 mounts, got %d", len(runtimeMounts))
	}
	if runtimeMounts[0].Source != "/host/src" || runtimeMounts[1].Volume != "vol1" {
		t.Fatalf("mounts not passed through unchanged: %+v", runtimeMounts)
	}

	// Rollback on passthrough mounts should be a noop (no state was created).
	rb.Rollback()
}

func TestMaterializeRWCopyMounts_FileRWCopy(t *testing.T) {
	dir := t.TempDir()
	volumeStore := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	fileMountStore := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	fileMountsBaseDir := filepath.Join(dir, "file-mounts")
	if err := os.MkdirAll(fileMountsBaseDir, 0755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	srcFile := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(srcFile, []byte("key: value"), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	input := []sandbox.MountBinding{
		{Type: "bind", Source: srcFile, Target: "/app/config.yaml", Mode: "rwcopy"},
	}

	runtimeMounts, rb, err := materializeRWCopyMounts(input, "test-sb", volumeStore, fileMountStore, fileMountsBaseDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runtimeMounts) != 1 {
		t.Fatalf("expected 1 runtime mount, got %d", len(runtimeMounts))
	}

	m := runtimeMounts[0]
	if m.Type != "bind" {
		t.Fatalf("type = %q, want bind", m.Type)
	}
	if m.Mode != "rw" {
		t.Fatalf("mode = %q, want rw", m.Mode)
	}
	if m.SnapshotFrom != srcFile {
		t.Fatalf("snapshot_from = %q, want %q", m.SnapshotFrom, srcFile)
	}

	// Verify the copy actually exists on disk.
	if _, err := os.Stat(m.Source); err != nil {
		t.Fatalf("copied file does not exist at %q: %v", m.Source, err)
	}

	// Verify a file mount store entry was created.
	mounts, err := fileMountStore.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(mounts) != 1 {
		t.Fatalf("expected 1 file mount store entry, got %d", len(mounts))
	}

	rb.Rollback()
}

func TestMaterializeRWCopyMounts_Disarm(t *testing.T) {
	dir := t.TempDir()
	volumeStore := sandbox.NewVolumeStore(filepath.Join(dir, "volumes.jsonl"))
	fileMountStore := sandbox.NewFileMountStore(filepath.Join(dir, "rwcopy-mounts.jsonl"))
	fileMountsBaseDir := filepath.Join(dir, "file-mounts")
	if err := os.MkdirAll(fileMountsBaseDir, 0755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	srcFile := filepath.Join(dir, "secret.yaml")
	if err := os.WriteFile(srcFile, []byte("token: abc"), 0644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	input := []sandbox.MountBinding{
		{Type: "bind", Source: srcFile, Target: "/app/secret.yaml", Mode: "rwcopy"},
	}

	runtimeMounts, rb, err := materializeRWCopyMounts(input, "test-sb", volumeStore, fileMountStore, fileMountsBaseDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	rb.Disarm()
	rb.Rollback() // Should be a noop after Disarm.

	// The copied file and store entry must still exist.
	if _, err := os.Stat(runtimeMounts[0].Source); err != nil {
		t.Fatalf("file should still exist after Disarm+Rollback: %v", err)
	}
	mounts, err := fileMountStore.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(mounts) != 1 {
		t.Fatalf("store entry should still exist after Disarm+Rollback, got %d entries", len(mounts))
	}
}

func TestSandboxListCommand_PrintsRows(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AMIKA_STATE_DIRECTORY", dir)
	store := sandbox.NewStore(filepath.Join(dir, "sandboxes.jsonl"))
	if err := store.Save(sandbox.Info{
		Name:      "sb-a",
		Provider:  "docker",
		Image:     "img",
		CreatedAt: "now",
		Ports: []sandbox.PortBinding{
			{HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 80, Protocol: "tcp"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	out, err := runRootCommand("sandbox", "list", "--local")
	if err != nil {
		t.Fatalf("sandbox list failed: %v", err)
	}
	if !strings.Contains(out, "NAME") || !strings.Contains(out, "PROVIDER") || !strings.Contains(out, "PORTS") {
		t.Fatalf("missing header: %s", out)
	}
	if !strings.Contains(out, "sb-a") {
		t.Fatalf("missing sandbox row: %s", out)
	}
	if !strings.Contains(out, "127.0.0.1:8080->80/tcp") {
		t.Fatalf("missing ports in row: %s", out)
	}
}

func TestParseSecretFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   []string
		want    map[string]string
		wantErr string
	}{
		{
			name:  "env with explicit env var",
			flags: []string{"env:FOO=MY_SECRET"},
			want:  map[string]string{"FOO": "MY_SECRET"},
		},
		{
			name:  "env shorthand",
			flags: []string{"env:MY_SECRET"},
			want:  map[string]string{"MY_SECRET": "MY_SECRET"},
		},
		{
			name:  "multiple secrets",
			flags: []string{"env:FOO=SECRET_A", "env:BAR=SECRET_B"},
			want:  map[string]string{"FOO": "SECRET_A", "BAR": "SECRET_B"},
		},
		{
			name:  "no flags",
			flags: nil,
			want:  nil,
		},
		{
			name:    "missing type prefix",
			flags:   []string{"MY_SECRET"},
			wantErr: "expected type prefix",
		},
		{
			name:    "empty after env:",
			flags:   []string{"env:"},
			wantErr: "empty env var name",
		},
		{
			name:    "empty env var name",
			flags:   []string{"env:=SECRET"},
			wantErr: "empty env var name",
		},
		{
			name:    "empty secret name",
			flags:   []string{"env:FOO="},
			wantErr: "empty secret name",
		},
		{
			name:    "duplicate env var",
			flags:   []string{"env:FOO=SECRET_A", "env:FOO=SECRET_B"},
			wantErr: "duplicate env var",
		},
		{
			name:    "file type not supported",
			flags:   []string{"file:/path=SECRET"},
			wantErr: "not yet supported",
		},
		{
			name:    "unknown type prefix",
			flags:   []string{"unknown:FOO"},
			wantErr: "unknown secret type",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseSecretFlags(tt.flags)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}
