package output

import (
	"testing"

	"github.com/spf13/cobra"
)

func newCmdWithFlag(value string, set bool) *cobra.Command {
	cmd := &cobra.Command{Use: "test"}
	AddFlag(cmd)
	if set {
		_ = cmd.Flags().Set(FlagName, value)
	}
	return cmd
}

func TestResolve(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		set     bool
		want    Format
		wantErr bool
	}{
		{name: "default is text", set: false, want: Text},
		{name: "explicit text", value: "text", set: true, want: Text},
		{name: "json", value: "json", set: true, want: JSON},
		{name: "invalid value errors", value: "yaml", set: true, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Resolve(newCmdWithFlag(tc.value, tc.set))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for value %q, got nil", tc.value)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("Resolve() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestAddFlag(t *testing.T) {
	cmd := &cobra.Command{Use: "test"}
	AddFlag(cmd)
	f := cmd.Flags().Lookup(FlagName)
	if f == nil {
		t.Fatal("expected --output flag to be registered")
	}
	if f.Shorthand != "o" {
		t.Fatalf("shorthand = %q, want %q", f.Shorthand, "o")
	}
	if f.DefValue != "text" {
		t.Fatalf("default = %q, want %q", f.DefValue, "text")
	}
}
