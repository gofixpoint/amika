package sandboxcmd

import "testing"

func TestParseGitHubBranchBinding(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		wantOwner  string
		wantRepo   string
		wantBranch string
		wantError  bool
	}{
		{name: "simple branch", raw: "gh-branch:gofixpoint/amika/main", wantOwner: "gofixpoint", wantRepo: "amika", wantBranch: "main"},
		{name: "branch with slashes", raw: "gh-branch:gofixpoint/amika/dylan/some-branch", wantOwner: "gofixpoint", wantRepo: "amika", wantBranch: "dylan/some-branch"},
		{name: "unsupported kind", raw: "github-branch:gofixpoint/amika/main", wantError: true},
		{name: "missing owner", raw: "gh-branch:/amika/main", wantError: true},
		{name: "missing repo", raw: "gh-branch:gofixpoint//main", wantError: true},
		{name: "missing branch", raw: "gh-branch:gofixpoint/amika/", wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			owner, repo, branch, err := parseGitHubBranchBinding(tt.raw)
			if tt.wantError {
				if err == nil {
					t.Fatalf("expected an error, got %s/%s/%s", owner, repo, branch)
				}
				return
			}
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if owner != tt.wantOwner || repo != tt.wantRepo || branch != tt.wantBranch {
				t.Errorf("got %s/%s/%s, want %s/%s/%s", owner, repo, branch, tt.wantOwner, tt.wantRepo, tt.wantBranch)
			}
		})
	}
}
