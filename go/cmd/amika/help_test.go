package main

import (
	"strings"
	"testing"
)

// helpLineContains returns true if any line in output contains all of needles.
func helpLineContains(output string, needles ...string) bool {
	for _, line := range strings.Split(output, "\n") {
		match := true
		for _, needle := range needles {
			if !strings.Contains(line, needle) {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func TestHelpShowsAliasesForSubcommands(t *testing.T) {
	tests := []struct {
		name      string
		args      []string
		wantLines [][]string // each inner slice is a set of strings that must appear together on one line
	}{
		{
			name: "rig delete shows rm and remove aliases",
			args: []string{"rig", "--help"},
			wantLines: [][]string{
				{"delete", "(aliases: rm, remove)"},
				{"list", "(aliases: ls)"},
			},
		},
		{
			name: "service list shows ls alias",
			args: []string{"service", "--help"},
			wantLines: [][]string{
				{"list", "(aliases: ls)"},
			},
		},
		{
			name: "secret claude subcommands show aliases",
			args: []string{"secret", "claude", "--help"},
			wantLines: [][]string{
				{"delete", "(aliases: rm)"},
				{"list", "(aliases: ls)"},
			},
		},
		{
			name: "secret ssh-key subcommands show aliases",
			args: []string{"secret", "ssh-key", "--help"},
			wantLines: [][]string{
				{"delete", "(aliases: rm)"},
				{"list", "(aliases: ls)"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, _ := runRootCommand(tt.args...)
			for _, lineNeedles := range tt.wantLines {
				if !helpLineContains(out, lineNeedles...) {
					t.Errorf("no line in help output contains %v\ngot:\n%s", lineNeedles, out)
				}
			}
		})
	}
}

func TestRigHelpShowsSandboxAlias(t *testing.T) {
	out, _ := runRootCommand("rig", "--help")
	if !strings.Contains(out, "Aliases:") || !strings.Contains(out, "sandbox") {
		t.Fatalf("rig help must show the sandbox alias; got:\n%s", out)
	}
}

func TestHelpNoAliasesForCommandsWithoutAliases(t *testing.T) {
	out, _ := runRootCommand("rig", "--help")
	// "create" has no aliases — its line should not contain "(aliases:"
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "create") && strings.Contains(line, "(aliases:") {
			t.Errorf("create command should not show aliases, but got line: %q", line)
		}
	}
}

func TestHelpAllRevealsGCOnlyForThatInvocation(t *testing.T) {
	for _, tt := range []struct {
		args []string
		want bool
	}{
		{[]string{"help"}, false},
		{[]string{"--help"}, false},
		{[]string{"help", "-a"}, true},
		{[]string{"help"}, false},
		{[]string{"help", "--all"}, true},
	} {
		out, err := runRootCommandOutput(t, tt.args...)
		if err != nil {
			t.Fatalf("%v: %v", tt.args, err)
		}
		if got := helpLineContains(out, "gc", "Remove deleted sandboxes"); got != tt.want {
			t.Fatalf("%v: gc visible = %v, want %v\n%s", tt.args, got, tt.want, out)
		}
		if !gcCmd.Hidden {
			t.Fatal("help changed command visibility permanently")
		}
	}
	out, err := runRootCommandOutput(t, "help", "gc")
	if err != nil || !strings.Contains(out, "amika gc") {
		t.Fatalf("direct gc help: %v\n%s", err, out)
	}
	out, err = runRootCommandOutput(t, "help", "rig", "-a")
	if err != nil || !helpLineContains(out, "codev1", "provider-native") {
		t.Fatalf("nested hidden commands: %v\n%s", err, out)
	}
	if _, err := runRootCommandOutput(t, "help", "does-not-exist"); err == nil {
		t.Fatal("unknown topic accepted")
	}
}
