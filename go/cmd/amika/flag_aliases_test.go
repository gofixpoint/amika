package main

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// legacyRigFlagAliases pairs each sandbox-era flag spelling with the rig-era
// flag it must resolve to. It restates the mapping in internal/cliflags, which
// catches an entry retargeted or dropped there but not one added — the two maps
// are never compared, so a new alias lands with this file untouched.
var legacyRigFlagAliases = map[string]string{
	"sandbox":      "rig",
	"sandbox-name": "rig-name",
	"sandbox-by":   "rig-by",
}

// Every flag that names a rig answers to its retired sandbox spelling, so
// scripts written before the rename keep running.
func TestRigFlagsAcceptTheLegacySandboxSpelling(t *testing.T) {
	cases := []struct {
		path   []string
		legacy string
	}{
		{[]string{"send"}, "sandbox"},
		{[]string{"service", "create"}, "sandbox"},
		{[]string{"service", "delete"}, "sandbox"},
		{[]string{"service", "list"}, "sandbox-name"},
		{[]string{"snapshot", "create"}, "sandbox"},
		{[]string{"snapshot", "list"}, "sandbox"},
		{[]string{"rig", "bind"}, "sandbox-by"},
		{[]string{"rig", "bindings", "list"}, "sandbox"},
		{[]string{"rig", "bindings", "list"}, "sandbox-by"},
		{[]string{"rig", "bindings", "delete"}, "sandbox-by"},
	}
	for _, tc := range cases {
		t.Run(strings.Join(tc.path, " ")+" --"+tc.legacy, func(t *testing.T) {
			cmd := resolveCommandPath(t, tc.path)
			flag := cmd.Flags().Lookup(tc.legacy)
			if flag == nil {
				t.Fatalf("--%s does not resolve on %q", tc.legacy, cmd.CommandPath())
			}
			if want := legacyRigFlagAliases[tc.legacy]; flag.Name != want {
				t.Fatalf("--%s resolved to --%s, want --%s", tc.legacy, flag.Name, want)
			}
			// Reintroducing a legacy name on a command whose flags are
			// registered before the normalizer reaches it does not panic: the
			// rename silently keeps one flag under the rig name carrying the
			// legacy registration's usage text. Every rig flag's usage names a
			// rig, so reading it is what tells the two apart — the flag's own
			// Name cannot, since the survivor is rig-named either way.
			if !strings.Contains(strings.ToLower(flag.Usage), "rig") {
				t.Fatalf("--%s resolved to a flag whose usage never says rig (%q); a legacy registration has displaced it",
					tc.legacy, flag.Usage)
			}
		})
	}
}

// Resolving is not enough: a value passed under the legacy spelling has to land
// on the rig flag the command actually reads.
func TestLegacySandboxFlagCarriesItsValueToTheRigFlag(t *testing.T) {
	cmd := resolveCommandPath(t, []string{"service", "create"})
	// The service commands are package-level objects shared across tests, and
	// this parse writes to one. Hand them back through the same reset the rest
	// of the package uses rather than leaving the value for whatever runs next.
	t.Cleanup(func() { resetServiceFlags(t) })

	if err := cmd.ParseFlags([]string{"--sandbox", "box"}); err != nil {
		t.Fatalf("parsing --sandbox: %v", err)
	}
	got, err := cmd.Flags().GetString("rig")
	if err != nil {
		t.Fatal(err)
	}
	if got != "box" {
		t.Fatalf("--rig = %q after --sandbox box, want %q", got, "box")
	}
}

// Help output advertises the rig spelling, not the alias it replaced.
func TestRigFlagHelpShowsTheRigSpelling(t *testing.T) {
	out, err := runRootCommand("service", "create", "--help")
	if err != nil {
		t.Fatalf("service create --help: %v", err)
	}
	if !strings.Contains(out, "--rig ") {
		t.Fatalf("help must advertise --rig; got:\n%s", out)
	}
	if strings.Contains(out, "--sandbox ") {
		t.Fatalf("help must not advertise the retired --sandbox; got:\n%s", out)
	}
}

func resolveCommandPath(t *testing.T, path []string) *cobra.Command {
	t.Helper()
	cmd := rootCmd
	for _, name := range path {
		cmd = findSubcommand(t, cmd, name)
	}
	return cmd
}
