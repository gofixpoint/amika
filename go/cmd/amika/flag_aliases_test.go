package main

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// legacyRigFlagAliases pairs each sandbox-era flag spelling with the rig-era
// flag it must resolve to. It restates the mapping in internal/cliflags so a
// change there has to be made deliberately in both places.
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
		})
	}
}

// Resolving is not enough: a value passed under the legacy spelling has to land
// on the rig flag the command actually reads.
func TestLegacySandboxFlagCarriesItsValueToTheRigFlag(t *testing.T) {
	cmd := resolveCommandPath(t, []string{"service", "create"})
	// The command objects are package-level and shared across tests, so undo
	// the parse rather than leaking a value into whatever runs next.
	t.Cleanup(func() { _ = cmd.Flags().Set("rig", "") })

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
