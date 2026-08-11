package cliargs

import (
	"reflect"
	"testing"
)

// amikaValueFlags mirrors the flags sshv2 passes to Split.
var amikaValueFlags = map[string]bool{"--output": true, "-o": true, "--remote-target": true}

func TestSplit(t *testing.T) {
	tests := []struct {
		name        string
		procArgs    []string
		leafArgs    []string
		wantOwn     []string
		wantForward []string
	}{
		{
			name:        "no flags",
			procArgs:    []string{"amika", "sandbox", "sshv2", "my-box"},
			leafArgs:    []string{"my-box"},
			wantForward: []string{"my-box"},
		},
		{
			// The pair of cases the split exists for: identical leafArgs,
			// opposite meanings, told apart only by the process argv.
			name:        "amika flag before the subcommand is not forwarded",
			procArgs:    []string{"amika", "--output", "json", "sandbox", "sshv2", "my-box"},
			leafArgs:    []string{"--output", "json", "my-box"},
			wantOwn:     []string{"--output", "json"},
			wantForward: []string{"my-box"},
		},
		{
			name:        "same flag after the subcommand is forwarded",
			procArgs:    []string{"amika", "sandbox", "sshv2", "--output", "json", "my-box"},
			leafArgs:    []string{"--output", "json", "my-box"},
			wantForward: []string{"--output", "json", "my-box"},
		},
		{
			name:        "sandbox flag before the subcommand",
			procArgs:    []string{"amika", "sandbox", "--remote", "sshv2", "-L", "6789:localhost:3010", "my-box"},
			leafArgs:    []string{"--remote", "-L", "6789:localhost:3010", "my-box"},
			wantOwn:     []string{"--remote"},
			wantForward: []string{"-L", "6789:localhost:3010", "my-box"},
		},
		{
			name:        "value-taking amika flag before the subcommand",
			procArgs:    []string{"amika", "sandbox", "--remote-target", "prod", "sshv2", "-N", "my-box"},
			leafArgs:    []string{"--remote-target", "prod", "-N", "my-box"},
			wantOwn:     []string{"--remote-target", "prod"},
			wantForward: []string{"-N", "my-box"},
		},
		{
			// A flag value equal to the subcommand name must not be mistaken
			// for the subcommand and shift the boundary.
			name:        "flag value equal to the subcommand name",
			procArgs:    []string{"amika", "sandbox", "--remote-target", "sshv2", "sshv2", "my-box"},
			leafArgs:    []string{"--remote-target", "sshv2", "my-box"},
			wantOwn:     []string{"--remote-target", "sshv2"},
			wantForward: []string{"my-box"},
		},
		{
			name:        "remote command after the name is forwarded",
			procArgs:    []string{"amika", "sandbox", "sshv2", "my-box", "uptime"},
			leafArgs:    []string{"my-box", "uptime"},
			wantForward: []string{"my-box", "uptime"},
		},
		{
			// Without the subcommand in the argv nothing can be placed, so
			// everything stays with amika rather than leaking to the utility.
			name:     "subcommand absent from the process argv",
			procArgs: []string{"amika", "sandbox"},
			leafArgs: []string{"my-box"},
			wantOwn:  []string{"my-box"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			own, forward := Split(tt.procArgs, tt.leafArgs, "sshv2", amikaValueFlags)
			if len(own) != len(tt.wantOwn) || (len(own) > 0 && !reflect.DeepEqual(own, tt.wantOwn)) {
				t.Errorf("own = %#v, want %#v", own, tt.wantOwn)
			}
			if len(forward) != len(tt.wantForward) || (len(forward) > 0 && !reflect.DeepEqual(forward, tt.wantForward)) {
				t.Errorf("forward = %#v, want %#v", forward, tt.wantForward)
			}
		})
	}
}

func TestFirstOperand(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want int
	}{
		{name: "bare name", args: []string{"my-box"}, want: 0},
		{name: "boolean option first", args: []string{"-N", "my-box"}, want: 1},
		{
			// The forwarding spec is -L's value, not the destination.
			name: "option with a separate value",
			args: []string{"-L", "6789:localhost:3010", "my-box"},
			want: 2,
		},
		{name: "option with an attached value", args: []string{"-L6789:localhost:3010", "my-box"}, want: 1},
		{name: "bundled booleans", args: []string{"-tv", "my-box"}, want: 1},
		{
			// Only the first argument-taking letter in a cluster takes the
			// following token, and only when nothing is attached after it.
			name: "bundled boolean then value-taking letter",
			args: []string{"-Nl", "root", "my-box"},
			want: 2,
		},
		{name: "ssh config option", args: []string{"-o", "BatchMode=yes", "my-box"}, want: 2},
		{name: "end of options marker", args: []string{"--", "-weird-name"}, want: 1},
		{name: "options only", args: []string{"-N", "-L", "6789:localhost:3010"}, want: -1},
		{name: "empty", args: nil, want: -1},
		{name: "trailing marker", args: []string{"--"}, want: -1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FirstOperand(tt.args, SSHArgLetters); got != tt.want {
				t.Errorf("FirstOperand(%#v) = %d, want %d", tt.args, got, tt.want)
			}
		})
	}
}

func TestHasHelpFlag(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{name: "long form", args: []string{"--help"}, want: true},
		{name: "short form", args: []string{"-h"}, want: true},
		{name: "after another option", args: []string{"-N", "--help"}, want: true},
		{
			// Past the sandbox name the tokens are ssh's remote command, so
			// --help is meant for the far side.
			name: "after the operand",
			args: []string{"my-box", "--help"},
			want: false,
		},
		{name: "after end of options", args: []string{"--", "--help"}, want: false},
		{name: "absent", args: []string{"-N", "my-box"}, want: false},
		{name: "empty", args: nil, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := HasHelpFlag(tt.args); got != tt.want {
				t.Errorf("HasHelpFlag(%#v) = %v, want %v", tt.args, got, tt.want)
			}
		})
	}
}
