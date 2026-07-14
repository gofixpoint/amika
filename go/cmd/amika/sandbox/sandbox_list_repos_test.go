package sandboxcmd

import (
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/pkg/amika"
)

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

func TestFormatCreatedBy(t *testing.T) {
	cases := []struct {
		name string
		in   *amika.SandboxCreator
		want string
	}{
		{"nil", nil, "-"},
		{"empty struct", &amika.SandboxCreator{}, "-"},
		{"name only", &amika.SandboxCreator{Name: "Ada Lovelace"}, "Ada Lovelace"},
		{"email only", &amika.SandboxCreator{Email: "ada@example.com"}, "ada@example.com"},
		{"name preferred over email", &amika.SandboxCreator{Name: "Ada", Email: "ada@example.com"}, "Ada"},
	}
	for _, tc := range cases {
		if got := formatCreatedBy(tc.in); got != tc.want {
			t.Fatalf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestPortBindingsFromRemoteServices(t *testing.T) {
	if got := portBindingsFromRemoteServices(nil); got != nil {
		t.Fatalf("nil services: got %v, want nil", got)
	}

	got := portBindingsFromRemoteServices([]apiclient.RemoteSandboxService{
		{Name: "Coding Agent", URL: "https://a.example.com", HostPort: 4096, ContainerPort: 4096, Protocol: "tcp"},
		{Name: "frontend", URL: "https://b.example.com", HostPort: 3000, ContainerPort: 3000, Protocol: "tcp"},
	})
	if len(got) != 2 {
		t.Fatalf("got %d bindings, want 2", len(got))
	}
	if got[0].HostIP != "" {
		t.Fatalf("remote binding must not carry a host IP, got %q", got[0].HostIP)
	}
	if got[1].ContainerPort != 3000 || got[1].Protocol != "tcp" {
		t.Fatalf("unexpected second binding: %+v", got[1])
	}
}

func TestFormatPortBindings_Remote(t *testing.T) {
	// Remote services carry no host IP; the "host:" prefix must be omitted
	// rather than defaulting to a misleading localhost.
	remote := portBindingsFromRemoteServices([]apiclient.RemoteSandboxService{
		{Name: "frontend", HostPort: 3000, ContainerPort: 3000, Protocol: "tcp"},
	})
	if got := formatPortBindings(remote); got != "3000->3000/tcp" {
		t.Fatalf("remote: got %q, want 3000->3000/tcp", got)
	}

	// Local sandboxes always set an explicit host IP, which is preserved.
	local := []amika.PortBinding{{HostIP: "127.0.0.1", HostPort: 8080, ContainerPort: 80, Protocol: "tcp"}}
	if got := formatPortBindings(local); got != "127.0.0.1:8080->80/tcp" {
		t.Fatalf("local: got %q, want 127.0.0.1:8080->80/tcp", got)
	}

	if got := formatPortBindings(nil); got != "-" {
		t.Fatalf("empty: got %q, want -", got)
	}
}

func TestCreatorFromRemote(t *testing.T) {
	if got := creatorFromRemote(nil); got != nil {
		t.Fatalf("nil remote: got %+v, want nil", got)
	}

	got := creatorFromRemote(&apiclient.RemoteSandboxCreator{})
	if got == nil {
		t.Fatalf("empty remote: got nil, want non-nil")
	}
	if got.Name != "" || got.Email != "" {
		t.Fatalf("empty remote: got %+v, want zero", got)
	}

	name := "Ada"
	email := "ada@example.com"
	got = creatorFromRemote(&apiclient.RemoteSandboxCreator{Name: &name, Email: &email})
	if got == nil || got.Name != "Ada" || got.Email != "ada@example.com" {
		t.Fatalf("populated remote: got %+v, want Ada/ada@example.com", got)
	}

	// Null name with present email — server returned the email but couldn't
	// produce a display name. The struct should pass the email through.
	got = creatorFromRemote(&apiclient.RemoteSandboxCreator{Name: nil, Email: &email})
	if got == nil || got.Name != "" || got.Email != "ada@example.com" {
		t.Fatalf("null name: got %+v, want empty name / email passthrough", got)
	}
}
