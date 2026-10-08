package sandboxcmd

import (
	"bytes"
	"errors"
	"testing"

	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/rigself"
	"github.com/spf13/cobra"
)

// isolateOutsideRigUnauthenticated leaves the process with no credential
// source and no rig name, so a command that checks auth before resolving
// "_self" would report a login prompt instead of ErrNotInRig.
func isolateOutsideRigUnauthenticated(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	for key, value := range map[string]string{
		"AMIKA_API_KEY":         "",
		"HOME":                  dir,
		"XDG_CONFIG_HOME":       dir,
		"XDG_STATE_HOME":        dir,
		"XDG_DATA_HOME":         dir,
		"AMIKA_STATE_DIRECTORY": dir,
		rigself.RigNameEnv:      "",
		rigself.SandboxNameEnv:  "",
	} {
		t.Setenv(key, value)
	}
}

func TestSelfResolvesBeforeAuth(t *testing.T) {
	newRoot := func(cmd *cobra.Command) *cobra.Command {
		root := &cobra.Command{Use: "amika", SilenceUsage: true, SilenceErrors: true}
		output.AddFlag(root)
		rig := &cobra.Command{Use: "rig"}
		rig.PersistentFlags().String("remote-target", "", "")
		rig.AddCommand(cmd)
		root.AddCommand(rig)
		return root
	}
	code := &cobra.Command{Use: "code", Args: cobra.ExactArgs(1), RunE: sandboxCodeV2Cmd.RunE}
	code.Flags().String("editor", "cursor", "")
	bindingsDelete := &cobra.Command{Use: "bindings-delete", Args: cobra.RangeArgs(1, 2), RunE: runSandboxBindingsDelete}
	bindingsDelete.Flags().String("rig-by", "ref", "")
	bindingsDelete.Flags().Bool("force", false, "")

	cases := []struct {
		name string
		root *cobra.Command
		args []string
	}{
		{"get", newSandboxGetTestRoot(), []string{"rig", "get", rigself.Ref}},
		{"code", newRoot(code), []string{"rig", "code", rigself.Ref}},
		{"bindings delete", newRoot(bindingsDelete), []string{"rig", "bindings-delete", rigself.Ref, "gh-branch:o/r/b", "--force"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			isolateOutsideRigUnauthenticated(t)
			tc.root.SetOut(&bytes.Buffer{})
			tc.root.SetErr(&bytes.Buffer{})
			tc.root.SetArgs(tc.args)
			if err := tc.root.Execute(); !errors.Is(err, rigself.ErrNotInRig) {
				t.Fatalf("error = %v, want ErrNotInRig", err)
			}
		})
	}

	t.Run("ssh", func(t *testing.T) {
		root, h, _ := newSSHV2Harness(t, []string{"amika", "sandbox", "ssh", rigself.Ref})
		isolateOutsideRigUnauthenticated(t)
		if err := root.Execute(); !errors.Is(err, rigself.ErrNotInRig) {
			t.Fatalf("error = %v, want ErrNotInRig", err)
		}
		if h.ran {
			t.Fatal("ssh ran for an unresolvable _self")
		}
	})
}
