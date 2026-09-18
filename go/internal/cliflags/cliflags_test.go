package cliflags

import (
	"testing"

	"github.com/spf13/pflag"
)

func TestNormalizeFlagName(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"sandbox", "rig"},
		{"sandbox-name", "rig-name"},
		{"sandbox-by", "rig-by"},
		{"rig", "rig"},
		{"rig-name", "rig-name"},
		{"rig-by", "rig-by"},
		{"output", "output"},
		{"sandbox-class", "sandbox-class"},
	}
	for _, tc := range cases {
		if got := string(NormalizeFlagName(nil, tc.in)); got != tc.want {
			t.Errorf("NormalizeFlagName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// A flag registered under its rig name must be settable by either spelling
// once the normalization func is installed on the flag set.
func TestNormalizeFlagName_ResolvesBothSpellings(t *testing.T) {
	for _, arg := range []string{"--rig=box", "--sandbox=box"} {
		fs := pflag.NewFlagSet("test", pflag.ContinueOnError)
		fs.SetNormalizeFunc(NormalizeFlagName)
		fs.String("rig", "", "")
		if err := fs.Parse([]string{arg}); err != nil {
			t.Fatalf("parsing %q: %v", arg, err)
		}
		got, err := fs.GetString("rig")
		if err != nil {
			t.Fatal(err)
		}
		if got != "box" {
			t.Errorf("after parsing %q, --rig = %q, want %q", arg, got, "box")
		}
		if !fs.Changed("rig") {
			t.Errorf("after parsing %q, Changed(\"rig\") = false, want true", arg)
		}
	}
}

// Installing the func after the flag is registered must rename the existing
// flag rather than leave a stale sandbox-named entry behind, so the order
// registration and installation happen in does not matter.
func TestNormalizeFlagName_RenamesAlreadyRegisteredFlags(t *testing.T) {
	fs := pflag.NewFlagSet("test", pflag.ContinueOnError)
	fs.String("sandbox", "", "")
	fs.SetNormalizeFunc(NormalizeFlagName)

	if fs.Lookup("rig") == nil {
		t.Fatal("flag registered as --sandbox did not become --rig")
	}
	if err := fs.Parse([]string{"--rig", "box"}); err != nil {
		t.Fatal(err)
	}
	got, err := fs.GetString("rig")
	if err != nil {
		t.Fatal(err)
	}
	if got != "box" {
		t.Errorf("--rig = %q, want %q", got, "box")
	}
}
