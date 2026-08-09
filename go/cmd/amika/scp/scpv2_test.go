package scpcmd

import (
	"errors"
	"strings"
	"testing"
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
