package rigself

import (
	"errors"
	"reflect"
	"testing"

	"github.com/spf13/cobra"
)

func envResolver(env map[string]string) Resolver {
	return Resolver{LookupEnv: func(key string) (string, bool) {
		value, ok := env[key]
		return value, ok
	}}
}

func TestResolve(t *testing.T) {
	cases := []struct {
		name    string
		env     map[string]string
		ref     string
		want    string
		wantErr bool
	}{
		{"plain ref passes through", nil, "my-rig", "my-rig", false},
		{"empty ref passes through", nil, "", "", false},
		{"prefers rig name", map[string]string{RigNameEnv: "rig", SandboxNameEnv: "sandbox"}, Ref, "rig", false},
		{"falls back to sandbox name", map[string]string{SandboxNameEnv: "sandbox"}, Ref, "sandbox", false},
		{"empty rig name counts as unset", map[string]string{RigNameEnv: "", SandboxNameEnv: "sandbox"}, Ref, "sandbox", false},
		{"neither set", nil, Ref, "", true},
		{"both empty", map[string]string{RigNameEnv: "", SandboxNameEnv: ""}, Ref, "", true},
		{"only exact match is self", map[string]string{RigNameEnv: "rig"}, "_self-x", "_self-x", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := envResolver(tc.env).Resolve(tc.ref)
			if tc.wantErr {
				if !errors.Is(err, ErrNotInRig) {
					t.Fatalf("Resolve(%q) error = %v, want ErrNotInRig", tc.ref, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve(%q) error = %v", tc.ref, err)
			}
			if got != tc.want {
				t.Fatalf("Resolve(%q) = %q, want %q", tc.ref, got, tc.want)
			}
		})
	}
}

func TestResolveAll(t *testing.T) {
	r := envResolver(map[string]string{RigNameEnv: "here"})
	got, err := r.ResolveAll([]string{"a", Ref, "b"})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a", "here", "b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ResolveAll = %v, want %v", got, want)
	}

	if _, err := envResolver(nil).ResolveAll([]string{"a", Ref}); !errors.Is(err, ErrNotInRig) {
		t.Fatalf("ResolveAll outside a rig error = %v, want ErrNotInRig", err)
	}
}

func TestFlag(t *testing.T) {
	cmd := &cobra.Command{Use: "x"}
	cmd.Flags().String("rig", "", "")
	if err := cmd.Flags().Set("rig", Ref); err != nil {
		t.Fatal(err)
	}
	got, err := envResolver(map[string]string{RigNameEnv: "here"}).Flag(cmd, "rig")
	if err != nil {
		t.Fatal(err)
	}
	if got != "here" {
		t.Fatalf("Flag = %q, want %q", got, "here")
	}
	if _, err := envResolver(nil).Flag(cmd, "missing"); err == nil {
		t.Fatal("Flag on an unregistered flag returned no error")
	}
}
