package main

import (
	"strings"
	"testing"
)

// TestRigOpenAcceptsAppFlag runs `rig open`, the alias of `rig code`, through
// the real command tree: --app reaches the editor validation that --editor
// does, and the two must agree when both are passed. Validation runs before
// authentication, so no API is needed.
func TestRigOpenAcceptsAppFlag(t *testing.T) {
	for _, tt := range []struct {
		args    []string
		wantErr string
	}{
		{args: []string{"rig", "open", "box", "--app=nope"}, wantErr: `unsupported editor "nope"`},
		{args: []string{"rig", "open", "box", "--app="}, wantErr: `unsupported editor ""`},
		{args: []string{"rig", "code", "box", "--editor=nope"}, wantErr: `unsupported editor "nope"`},
		{args: []string{"rig", "open", "box", "--editor=cursor", "--app=herdr"}, wantErr: `--editor "cursor" and --app "herdr" disagree`},
	} {
		t.Run(strings.Join(tt.args, " "), func(t *testing.T) {
			_, err := runRootCommandOutput(t, tt.args...)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.wantErr)
			}
		})
	}
}
