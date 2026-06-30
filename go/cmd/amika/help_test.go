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
			name: "sandbox delete shows rm and remove aliases",
			args: []string{"sandbox", "--help"},
			wantLines: [][]string{
				{"delete", "(aliases: rm, remove)"},
				{"list", "(aliases: ls)"},
			},
		},
		{
			name: "volume delete shows rm and remove aliases",
			args: []string{"volume", "--help"},
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

func TestHelpNoAliasesForCommandsWithoutAliases(t *testing.T) {
	out, _ := runRootCommand("sandbox", "--help")
	// "create" has no aliases — its line should not contain "(aliases:"
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "create") && strings.Contains(line, "(aliases:") {
			t.Errorf("create command should not show aliases, but got line: %q", line)
		}
	}
}
