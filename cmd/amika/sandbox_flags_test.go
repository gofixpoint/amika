package main

import (
	"bufio"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/sandbox"
)

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
