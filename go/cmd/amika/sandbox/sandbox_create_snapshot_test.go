package sandboxcmd

import (
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/gitrepo"
)

func TestValidateCreateSnapshotFlags(t *testing.T) {
	tests := []struct {
		name    string
		flags   map[string]string
		wantErr string
	}{
		{name: "no flags"},
		{name: "--snapshot alone", flags: map[string]string{"snapshot": "base"}},
		{name: "--preset alone", flags: map[string]string{"preset": "coder"}},
		{name: "--no-snapshot alone", flags: map[string]string{"no-snapshot": "true"}},
		{name: "--preset with --no-snapshot", flags: map[string]string{"preset": "coder", "no-snapshot": "true"}},
		{
			name:    "--snapshot with --no-snapshot",
			flags:   map[string]string{"snapshot": "base", "no-snapshot": "true"},
			wantErr: "--snapshot and --no-snapshot are mutually exclusive",
		},
		{
			name:    "--snapshot with --preset",
			flags:   map[string]string{"snapshot": "base", "preset": "coder"},
			wantErr: "a captured snapshot carries its own preset",
		},
		// An empty value is dropped from the body, so it conflicts with nothing.
		{name: "empty --snapshot with --no-snapshot", flags: map[string]string{"snapshot": "", "no-snapshot": "true"}},
		{name: "--snapshot with empty --preset", flags: map[string]string{"snapshot": "base", "preset": ""}},
		// The server accepts null alongside host_id, so --host does not
		// make --no-snapshot a conflict.
		{name: "--host with --no-snapshot", flags: map[string]string{"host": "alpha.lan", "no-snapshot": "true"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, _ := newCreateCmd(t)
			for flag, value := range tt.flags {
				if err := c.Flags().Set(flag, value); err != nil {
					t.Fatalf("setting --%s: %v", flag, err)
				}
			}
			err := validateCreateSnapshotFlags(c)
			if tt.wantErr == "" {
				if err != nil {
					t.Errorf("err = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("err = %v, want %q in it", err, tt.wantErr)
			}
		})
	}
}

func TestCreateSnapshotSelection(t *testing.T) {
	tests := []struct {
		name  string
		flags map[string]string
		want  apiclient.SnapshotSelection
	}{
		{name: "no flags keep the default chain", want: apiclient.SnapshotSelection{}},
		{name: "--preset skips the default snapshots", flags: map[string]string{"preset": "coder"}, want: apiclient.NoSnapshot()},
		{name: "--no-snapshot", flags: map[string]string{"no-snapshot": "true"}, want: apiclient.NoSnapshot()},
		{name: "--snapshot", flags: map[string]string{"snapshot": "base"}, want: apiclient.SnapshotSlug("base")},
		{name: "--preset with --no-snapshot", flags: map[string]string{"preset": "coder", "no-snapshot": "true"}, want: apiclient.NoSnapshot()},
		{name: "empty --snapshot keeps the default chain", flags: map[string]string{"snapshot": ""}, want: apiclient.SnapshotSelection{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, _ := newCreateCmd(t)
			for flag, value := range tt.flags {
				if err := c.Flags().Set(flag, value); err != nil {
					t.Fatalf("setting --%s: %v", flag, err)
				}
			}
			if got := createSnapshotSelection(c); got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

// The null has to reach the wire: a server that predates treating a bare
// preset as null would otherwise fork the repository's default snapshot.
func TestCreateRemoteSandboxSendsNullSnapshotForPreset(t *testing.T) {
	body := stubCreateAPI(t, true)
	c, _ := newCreateCmd(t)
	c.Flags().Set("name", "dev")
	c.Flags().Set("preset", "coder-plus-docker")

	if err := createRemoteSandbox(c, "", gitrepo.Identity{Source: gitrepo.SourceNone}); err != nil {
		t.Fatalf("createRemoteSandbox: %v", err)
	}
	snapshot, present := (*body)["snapshot"]
	if !present || snapshot != nil {
		t.Errorf("snapshot = %v (present %v), want null (body: %v)", snapshot, present, *body)
	}
	if got := (*body)["preset"]; got != "coder-plus-docker" {
		t.Errorf("preset = %v, want coder-plus-docker (body: %v)", got, *body)
	}
}
