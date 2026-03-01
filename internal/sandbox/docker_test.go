package sandbox

import (
	"reflect"
	"testing"
)

func TestBuildDockerRunArgs_MixedMounts(t *testing.T) {
	mounts := []MountBinding{
		{Type: "bind", Source: "/host/src", Target: "/workspace/src", Mode: "ro"},
		{Type: "volume", Volume: "amika-vol-1", Target: "/workspace/cache", Mode: "rw"},
	}
	env := []string{"A=1", "B=2"}

	got := buildDockerRunArgs("sb1", "ubuntu:latest", mounts, env)
	want := []string{
		"run", "-d", "--name", "sb1",
		"-v", "/host/src:/workspace/src:ro",
		"-v", "amika-vol-1:/workspace/cache",
		"-e", "A=1",
		"-e", "B=2",
		"ubuntu:latest", "tail", "-f", "/dev/null",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %#v, want %#v", got, want)
	}
}

func TestMountVolumeSpec_EmptyIgnored(t *testing.T) {
	tests := []MountBinding{
		{Type: "bind", Target: "/x"},
		{Type: "volume", Volume: "vol", Target: ""},
	}
	for _, tt := range tests {
		if got := mountVolumeSpec(tt); got != "" {
			t.Fatalf("mountVolumeSpec(%+v) = %q, want empty", tt, got)
		}
	}
}
