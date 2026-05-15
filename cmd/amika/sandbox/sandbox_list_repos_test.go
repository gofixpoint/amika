package sandboxcmd

import "testing"

func TestRepoBasenameFromURL(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", ""},
		{"https://github.com/gofixpoint/amika.git", "amika"},
		{"https://github.com/gofixpoint/amika", "amika"},
		{"git@github.com:gofixpoint/amika.git", "amika"},
		{"ssh://git@github.com/gofixpoint/amika.git", "amika"},
		{"file:///srv/repos/amika.git", "amika"},
		{"https://github.com/gofixpoint/amika.git/", "amika"},
		{"https://github.com/gofixpoint/amika/", "amika"},
		{"https://github.com/gofixpoint/amika.git///", "amika"},
	}
	for _, tc := range cases {
		got := repoBasenameFromURL(tc.in)
		if got != tc.want {
			t.Fatalf("repoBasenameFromURL(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestRepoNamesFromURL(t *testing.T) {
	if got := repoNamesFromURL(""); got != nil {
		t.Fatalf("empty URL: got %v, want nil", got)
	}
	if got := repoNamesFromURL("   "); got != nil {
		t.Fatalf("whitespace URL: got %v, want nil", got)
	}
	got := repoNamesFromURL("https://github.com/gofixpoint/amika.git")
	if len(got) != 1 || got[0] != "amika" {
		t.Fatalf("got %v, want [amika]", got)
	}
}

func TestFormatRepos(t *testing.T) {
	if got := formatRepos(nil); got != "" {
		t.Fatalf("nil: got %q, want empty", got)
	}
	if got := formatRepos([]string{}); got != "" {
		t.Fatalf("empty: got %q, want empty", got)
	}
	if got := formatRepos([]string{"amika"}); got != "amika" {
		t.Fatalf("single: got %q, want amika", got)
	}
	if got := formatRepos([]string{"alpha", "beta"}); got != "alpha,beta" {
		t.Fatalf("multi: got %q, want alpha,beta", got)
	}
}
