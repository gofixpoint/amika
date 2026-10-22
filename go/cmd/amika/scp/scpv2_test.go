package scpcmd

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/ssh"
)

// stubResolver resolves any sandbox name to a deterministic v2 alias and
// records the names it was asked for. The fixture alias below is a stand-in
// for exercising buildSCPV2Invocation's operand rewriting in isolation, not a
// copy of the real format: production aliases are
// "<name>.<id>.<environment>.amika" (ssh.BuildSessionAlias), where
// <environment> is the AMIKA_API_URL host reformatted to [a-z0-9-]
// (config.EnvironmentSlug). That third segment landed after this test was
// written; it doesn't need to be reflected here since nothing in this file
// depends on the resolver's output shape, only on where it gets substituted.
func stubResolver(seen *[]string) aliasResolver {
	return func(name string) (string, error) {
		if name == "missing" {
			return "", errors.New("sandbox not found")
		}
		*seen = append(*seen, name)
		return name + ".sbx-1234.amika", nil
	}
}

func TestBuildSCPV2InvocationRewritesSandboxOperands(t *testing.T) {
	for _, tc := range []struct {
		name string
		argv []string
		want []string
	}{
		{
			name: "relative sandbox path resolves under the sandbox home",
			argv: []string{"./local.txt", "box:notes/a.txt"},
			want: []string{"./local.txt", "box.sbx-1234.amika:/home/amika/notes/a.txt"},
		},
		{
			name: "absolute sandbox path is used verbatim",
			argv: []string{"-r", "box:/srv/out", "./out"},
			want: []string{"-r", "box.sbx-1234.amika:/srv/out", "./out"},
		},
		{
			name: "bare sandbox reference means the home directory",
			argv: []string{"box:", "./out"},
			want: []string{"box.sbx-1234.amika:/home/amika", "./out"},
		},
		{
			name: "rig URI form resolves the same way",
			argv: []string{"rig://box/~/a.txt", "./a.txt"},
			want: []string{"box.sbx-1234.amika:/home/amika/a.txt", "./a.txt"},
		},
		{
			name: "sbox URI form resolves the same way",
			argv: []string{"sbox://box/~/a.txt", "./a.txt"},
			want: []string{"box.sbx-1234.amika:/home/amika/a.txt", "./a.txt"},
		},
		{
			name: "sandbox to sandbox rewrites both operands",
			argv: []string{"one:/a", "two:/b"},
			want: []string{"one.sbx-1234.amika:/a", "two.sbx-1234.amika:/b"},
		},
		{
			name: "local paths pass through untouched",
			argv: []string{"./a.txt", "/tmp/b.txt"},
			want: []string{"./a.txt", "/tmp/b.txt"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var seen []string
			got, err := buildSCPV2Invocation(scpPlan{scpArgv: tc.argv}, stubResolver(&seen))
			if err != nil {
				t.Fatalf("buildSCPV2Invocation: %v", err)
			}
			if strings.Join(got, " ") != strings.Join(tc.want, " ") {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBuildSCPV2InvocationDoesNotTreatOptionValuesAsOperands(t *testing.T) {
	// "-o" takes a separate value; reading "ConnectTimeout=5" as an operand
	// would try to resolve a sandbox named "ConnectTimeout=5".
	var seen []string
	got, err := buildSCPV2Invocation(
		scpPlan{scpArgv: []string{"-o", "ConnectTimeout=5", "box:/a", "./a"}},
		stubResolver(&seen),
	)
	if err != nil {
		t.Fatalf("buildSCPV2Invocation: %v", err)
	}
	want := "-o ConnectTimeout=5 box.sbx-1234.amika:/a ./a"
	if strings.Join(got, " ") != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if len(seen) != 1 || seen[0] != "box" {
		t.Fatalf("resolved names = %v, want [box]", seen)
	}
}

func TestBuildSCPV2InvocationResolvesEachSandboxOnce(t *testing.T) {
	// The cache lives in runSCPV2's closure, so exercise it the way the command
	// does: one resolver shared across every operand.
	var seen []string
	inner := stubResolver(&seen)
	cache := map[string]string{}
	cached := func(name string) (string, error) {
		if alias, ok := cache[name]; ok {
			return alias, nil
		}
		alias, err := inner(name)
		if err != nil {
			return "", err
		}
		cache[name] = alias
		return alias, nil
	}

	if _, err := buildSCPV2Invocation(
		scpPlan{scpArgv: []string{"box:/a", "box:/b", "./out"}},
		cached,
	); err != nil {
		t.Fatalf("buildSCPV2Invocation: %v", err)
	}
	if len(seen) != 1 {
		t.Fatalf("resolved %d times, want 1 (%v)", len(seen), seen)
	}
}

func TestBuildSCPV2InvocationPropagatesResolveFailure(t *testing.T) {
	var seen []string
	if _, err := buildSCPV2Invocation(
		scpPlan{scpArgv: []string{"missing:/a", "./out"}},
		stubResolver(&seen),
	); err == nil {
		t.Fatal("expected an error for an unresolvable sandbox")
	}
}

func TestBuildSCPV2InvocationLeavesSCPURIsAlone(t *testing.T) {
	// An scp:// URI names an arbitrary SSH host, not a sandbox, so it must not
	// be resolved or rewritten into an alias.
	var seen []string
	got, err := buildSCPV2Invocation(
		scpPlan{scpArgv: []string{"scp://user@host:22/tmp/a.csv", "./a.csv"}},
		stubResolver(&seen),
	)
	if err != nil {
		t.Fatalf("buildSCPV2Invocation: %v", err)
	}
	if !strings.HasPrefix(got[0], "scp://") || len(seen) != 0 {
		t.Fatalf("got %q with resolved names %v", got, seen)
	}
}

func TestBuildSCPV2InvocationPassesPrefixedReferences(t *testing.T) {
	// The kind prefix is part of the rig operand: scp's first colon still
	// separates the rig from the path, and '=' never does.
	var seen []string
	got, err := buildSCPV2Invocation(
		scpPlan{scpArgv: []string{"name=box:/a", "sbox://id=sb_1/b", "./out"}},
		stubResolver(&seen),
	)
	if err != nil {
		t.Fatalf("buildSCPV2Invocation: %v", err)
	}
	if want := []string{"name=box", "id=sb_1"}; !reflect.DeepEqual(seen, want) {
		t.Fatalf("resolved names = %q, want %q", seen, want)
	}
	if want := []string{"name=box.sbx-1234.amika:/a", "id=sb_1.sbx-1234.amika:/b", "./out"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// scpTestServer fakes the sandbox API, answering every lookup with rig "box"
// (id "sb_1") and recording each request URI.
func scpTestServer(t *testing.T) *[]string {
	t.Helper()
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.RequestURI)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"sb_1","name":"box","state":"active"}`))
	}))
	t.Cleanup(server.Close)
	t.Setenv("AMIKA_API_URL", server.URL)
	return &requests
}

// TestRunSCPV2ResolvesReferenceKinds checks that each rig operand is looked
// up by its reference kind and replaced by the alias built from the rig's
// canonical name and id, so no "id=" or "name=" reaches scp.
func TestRunSCPV2ResolvesReferenceKinds(t *testing.T) {
	for _, tc := range []struct {
		operand     string
		wantRequest string
	}{
		{"box:b.txt", "/api/v0beta1/sandboxes/box"},
		{"name=box:b.txt", "/api/v0beta1/sandboxes/box?by=name"},
		{"id=sb_1:b.txt", "/api/v0beta1/sandboxes/sb_1?by=id"},
		{"sbox://id=sb_1/home/amika/b.txt", "/api/v0beta1/sandboxes/sb_1?by=id"},
	} {
		t.Run(tc.operand, func(t *testing.T) {
			requests := scpTestServer(t)
			t.Setenv("AMIKA_API_KEY", "test-key")
			prev := prepareSessionTarget
			t.Cleanup(func() { prepareSessionTarget = prev })
			prepareSessionTarget = func(_ basedir.Paths, _ ssh.SessionCreator, name, id string) (string, error) {
				return name + "." + id + ".test.amika", nil
			}

			cmd := NewV2()
			var out bytes.Buffer
			cmd.SetOut(&out)
			if err := runSCPV2(cmd, []string{"--print", "./a.txt", tc.operand}); err != nil {
				t.Fatal(err)
			}
			if want := []string{tc.wantRequest}; !reflect.DeepEqual(*requests, want) {
				t.Fatalf("requests = %q, want %q", *requests, want)
			}
			if want := "scp ./a.txt box.sb_1.test.amika:/home/amika/b.txt\n"; out.String() != want {
				t.Fatalf("printed %q, want %q", out.String(), want)
			}
		})
	}
}

// TestRunSCPV2ParsesEveryReferenceBeforeAuth checks that a malformed rig
// reference in any operand, not just the first, is reported before the login
// check and before any rig is fetched.
func TestRunSCPV2ParsesEveryReferenceBeforeAuth(t *testing.T) {
	requests := scpTestServer(t)
	dir := t.TempDir()
	for key, value := range map[string]string{
		"AMIKA_API_KEY": "", "HOME": dir, "XDG_CONFIG_HOME": dir,
		"XDG_STATE_HOME": dir, "XDG_DATA_HOME": dir, "AMIKA_STATE_DIRECTORY": dir,
	} {
		t.Setenv(key, value)
	}
	err := runSCPV2(NewV2(), []string{"box:a.txt", "id=:b.txt"})
	if err == nil || !strings.Contains(err.Error(), "no value") {
		t.Fatalf("error = %v, want a missing-value error", err)
	}
	if len(*requests) != 0 {
		t.Fatalf("requests = %q, want none", *requests)
	}
}
