package main

import "testing"

func TestParseSandboxPath(t *testing.T) {
	cases := []struct {
		input       string
		wantName    string
		wantPath    string
		wantErr     bool
		errContains string
	}{
		{
			input:    "mysandbox:/tmp/file.txt",
			wantName: "mysandbox",
			wantPath: "/tmp/file.txt",
		},
		{
			input:    "sb:/home/amika/workspace/repo",
			wantName: "sb",
			wantPath: "/home/amika/workspace/repo",
		},
		{
			input:    "sb:/path/with:colon",
			wantName: "sb",
			wantPath: "/path/with:colon",
		},
		{
			input:       "no-colon",
			wantErr:     true,
			errContains: "expected <sandbox>:<path>",
		},
		{
			input:       ":/tmp/file",
			wantErr:     true,
			errContains: "sandbox name is required",
		},
		{
			input:       "sb:",
			wantErr:     true,
			errContains: "path is required",
		},
		{
			input:       "sb:relative/path",
			wantErr:     true,
			errContains: "must be absolute",
		},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			name, path, err := parseSandboxPath(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tc.errContains)
				}
				if tc.errContains != "" && !contains(err.Error(), tc.errContains) {
					t.Fatalf("error %q does not contain %q", err.Error(), tc.errContains)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if name != tc.wantName {
				t.Errorf("name = %q, want %q", name, tc.wantName)
			}
			if path != tc.wantPath {
				t.Errorf("path = %q, want %q", path, tc.wantPath)
			}
		})
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && searchSubstring(s, substr)
}

func searchSubstring(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}