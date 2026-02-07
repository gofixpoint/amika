package main

import (
	"testing"
)

func TestValidateScriptCmdFlags(t *testing.T) {
	tests := []struct {
		name         string
		script       string
		cmd          string
		trailingArgs []string
		wantErr      string
	}{
		{
			name:   "script only",
			script: "./foo.sh",
		},
		{
			name: "cmd only",
			cmd:  "echo hi",
		},
		{
			name:    "neither script nor cmd",
			wantErr: "exactly one of --script or --cmd must be specified",
		},
		{
			name:    "both script and cmd",
			script:  "./foo.sh",
			cmd:     "echo hi",
			wantErr: "--script and --cmd are mutually exclusive",
		},
		{
			name:         "cmd with trailing args",
			cmd:          "echo hi",
			trailingArgs: []string{"arg1"},
			wantErr:      "trailing arguments are not allowed with --cmd",
		},
		{
			name:         "script with trailing args",
			script:       "./foo.sh",
			trailingArgs: []string{"arg1", "arg2"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateScriptCmdFlags(tt.script, tt.cmd, tt.trailingArgs)
			if tt.wantErr == "" {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
			} else {
				if err == nil {
					t.Errorf("expected error %q, got nil", tt.wantErr)
				} else if err.Error() != tt.wantErr {
					t.Errorf("expected error %q, got %q", tt.wantErr, err.Error())
				}
			}
		})
	}
}
