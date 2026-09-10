package sandboxcmd

import "testing"

func TestParseGitHubRepositoryURL(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		wantOwner string
		wantRepo  string
		wantError bool
	}{
		{name: "https", raw: "https://github.com/gofixpoint/amika.git", wantOwner: "gofixpoint", wantRepo: "amika"},
		{name: "ssh URL", raw: "ssh://git@github.com/gofixpoint/amika.git", wantOwner: "gofixpoint", wantRepo: "amika"},
		{name: "scp syntax", raw: "git@github.com:gofixpoint/amika.git", wantOwner: "gofixpoint", wantRepo: "amika"},
		{name: "other host", raw: "https://example.com/gofixpoint/amika.git", wantError: true},
		{name: "extra path", raw: "https://github.com/gofixpoint/amika/tree/main", wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			owner, repo, err := parseGitHubRepositoryURL(tt.raw)
			if tt.wantError {
				if err == nil {
					t.Fatalf("expected an error, got %s/%s", owner, repo)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if owner != tt.wantOwner || repo != tt.wantRepo {
				t.Errorf("got %s/%s, want %s/%s", owner, repo, tt.wantOwner, tt.wantRepo)
			}
		})
	}
}
