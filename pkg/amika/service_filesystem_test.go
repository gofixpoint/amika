package amika

import "testing"

func TestParseStatOutput(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantLen int
		check   func([]SandboxFileInfo) string // returns "" on success, error message on failure
	}{
		{
			name:    "empty input",
			input:   "",
			wantLen: 0,
		},
		{
			name:    "single file",
			input:   "/tmp/test.txt|1024|644|1700000000|regular file\n",
			wantLen: 1,
			check: func(entries []SandboxFileInfo) string {
				e := entries[0]
				if e.Name != "/tmp/test.txt" {
					return "Name = " + e.Name
				}
				if e.Size != 1024 {
					return "Size mismatch"
				}
				if e.Mode != "644" {
					return "Mode = " + e.Mode
				}
				if e.IsDir {
					return "IsDir should be false"
				}
				return ""
			},
		},
		{
			name:    "directory entry",
			input:   "/tmp/dir|4096|755|1700000000|directory\n",
			wantLen: 1,
			check: func(entries []SandboxFileInfo) string {
				if !entries[0].IsDir {
					return "IsDir should be true"
				}
				return ""
			},
		},
		{
			name:    "multiple entries",
			input:   "/tmp/a|100|644|1700000000|regular file\n/tmp/b|200|755|1700000000|directory\n",
			wantLen: 2,
		},
		{
			name:    "skips malformed lines",
			input:   "bad line\n/tmp/ok|100|644|1700000000|regular file\n",
			wantLen: 1,
		},
		{
			name:    "trims whitespace",
			input:   "  /tmp/test|100|644|1700000000|regular file  \n",
			wantLen: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entries := ParseStatOutput(tc.input)
			if len(entries) != tc.wantLen {
				t.Fatalf("len(entries) = %d, want %d", len(entries), tc.wantLen)
			}
			if tc.check != nil {
				if msg := tc.check(entries); msg != "" {
					t.Fatalf("check failed: %s", msg)
				}
			}
		})
	}
}