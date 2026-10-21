package rigref

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
)

func envResolver(env map[string]string) Resolver {
	return Resolver{LookupEnv: func(key string) (string, bool) {
		value, ok := env[key]
		return value, ok
	}}
}

func TestParse(t *testing.T) {
	inRig := map[string]string{RigNameEnv: "here"}
	sandboxOnly := map[string]string{RigNameEnv: "", SandboxNameEnv: "legacy"}
	cases := []struct {
		name    string
		env     map[string]string
		raw     string
		want    Ref
		wantErr string
	}{
		{name: "bare value matches by id or name", raw: "my-rig", want: Ref{Kind: KindRef, Value: "my-rig"}},
		{name: "ref= is the explicit spelling", raw: "ref=my-rig", want: Ref{Kind: KindRef, Value: "my-rig"}},
		{name: "name= matches by name only", raw: "name=my-rig", want: Ref{Kind: KindName, Value: "my-rig"}},
		{name: "id= matches by id only", raw: "id=9f3c8b21-0000-4000-8000-000000000000", want: Ref{Kind: KindID, Value: "9f3c8b21-0000-4000-8000-000000000000"}},
		// Only the first '=' separates the kind, so a legacy name that itself
		// starts with a kind word stays reachable.
		{name: "splits on the first equals only", raw: "name=id=legacy", want: Ref{Kind: KindName, Value: "id=legacy"}},
		{name: "unknown prefix is part of the value", raw: "nmae=my-rig", want: Ref{Kind: KindRef, Value: "nmae=my-rig"}},
		{name: "prefix match is case sensitive", raw: "NAME=my-rig", want: Ref{Kind: KindRef, Value: "NAME=my-rig"}},
		{name: "empty value after a prefix is refused", raw: "name=", wantErr: "no value"},
		{name: "_self resolves to a name match", env: inRig, raw: "_self", want: Ref{Kind: KindName, Value: "here"}},
		{name: "name=_self resolves too", env: inRig, raw: "name=_self", want: Ref{Kind: KindName, Value: "here"}},
		{name: "ref=_self resolves too", env: inRig, raw: "ref=_self", want: Ref{Kind: KindName, Value: "here"}},
		{name: "id=_self is refused", env: inRig, raw: "id=_self", wantErr: "not its id"},
		{name: "_self outside a rig names the env vars", raw: "_self", wantErr: RigNameEnv},
		{name: "_self falls back to the legacy variable", env: sandboxOnly, raw: "_self", want: Ref{Kind: KindName, Value: "legacy"}},
		{name: "only the exact literal is _self", env: inRig, raw: "_self-x", want: Ref{Kind: KindRef, Value: "_self-x"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseWith(envResolver(tc.env), tc.raw)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("parseWith(%q) = %v, %v; want error containing %q", tc.raw, got, err, tc.wantErr)
				}
				return
			}
			if err != nil || got.Kind != tc.want.Kind || got.Value != tc.want.Value {
				t.Fatalf("parseWith(%q) = %v, %v; want %v", tc.raw, got, err, tc.want)
			}
		})
	}
}

// TestSelector checks the selector each reference carries to the API: its own
// kind when the user spelled one out, and a plain ref otherwise, bare "_self"
// included, since it stands in for the rig's name typed bare.
func TestSelector(t *testing.T) {
	inRig := envResolver(map[string]string{RigNameEnv: "here"})
	for _, tc := range []struct {
		raw  string
		want apiclient.SandboxSelector
	}{
		{raw: "my-rig", want: apiclient.SandboxSelector{Value: "my-rig", By: "ref"}},
		{raw: "ref=my-rig", want: apiclient.SandboxSelector{Value: "my-rig", By: "ref"}},
		{raw: "name=my-rig", want: apiclient.SandboxSelector{Value: "my-rig", By: "name"}},
		{raw: "id=abc", want: apiclient.SandboxSelector{Value: "abc", By: "id"}},
		{raw: "_self", want: apiclient.SandboxSelector{Value: "here", By: "ref"}},
		{raw: "ref=_self", want: apiclient.SandboxSelector{Value: "here", By: "ref"}},
		{raw: "name=_self", want: apiclient.SandboxSelector{Value: "here", By: "name"}},
	} {
		ref, err := parseWith(inRig, tc.raw)
		if err != nil {
			t.Fatalf("parseWith(%q): %v", tc.raw, err)
		}
		if got := ref.Selector(); got != tc.want {
			t.Errorf("parseWith(%q).Selector() = %#v, want %#v", tc.raw, got, tc.want)
		}
	}
}

// TestLabel checks that output names a rig the way the user wrote it, except
// that "_self" shows the rig name it stands for.
func TestLabel(t *testing.T) {
	inRig := envResolver(map[string]string{RigNameEnv: "here"})
	for _, tc := range []struct{ raw, want string }{
		{raw: "my-rig", want: "my-rig"},
		{raw: "name=my-rig", want: "name=my-rig"},
		{raw: "id=abc", want: "id=abc"},
		{raw: "_self", want: "here"},
		{raw: "name=_self", want: "here"},
	} {
		ref, err := parseWith(inRig, tc.raw)
		if err != nil {
			t.Fatalf("parseWith(%q): %v", tc.raw, err)
		}
		if got := Label(tc.raw, ref); got != tc.want {
			t.Errorf("Label(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

// TestExplain checks that the API's 409 resource_ref_ambiguous becomes
// ErrAmbiguous with the id=/name= spellings, and that other errors pass
// through untouched.
func TestExplain(t *testing.T) {
	ref := Ref{Kind: KindRef, Value: "b-id"}
	conflict := fmt.Errorf("remote get sandbox: %w", &apiclient.HTTPError{
		StatusCode: 409,
		Body:       `{"code":"resource_ref_ambiguous","message":"matches more than one sandbox"}`,
	})
	err := Explain(ref, conflict)
	if !errors.Is(err, ErrAmbiguous) || !strings.Contains(err.Error(), `"id=b-id"`) || !strings.Contains(err.Error(), `"name=b-id"`) {
		t.Fatalf("Explain(409) = %v, want ErrAmbiguous naming id=b-id and name=b-id", err)
	}

	other := &apiclient.HTTPError{StatusCode: 404, Body: `{"code":"not_found","message":"no such sandbox"}`}
	if got := Explain(ref, other); got != error(other) {
		t.Fatalf("Explain(404) = %v, want the error unchanged", got)
	}
	if got := Explain(ref, nil); got != nil {
		t.Fatalf("Explain(nil) = %v, want nil", got)
	}
}

type rig struct{ id, name string }

func find(r Ref, rigs []rig) (int, error) {
	return Find(r, rigs, func(x rig) string { return x.id }, func(x rig) string { return x.name })
}

func TestFind(t *testing.T) {
	// "b-id" is rig 1's id and also rig 2's name, the collision the ref kind
	// exists to refuse.
	rigs := []rig{{"a-id", "alpha"}, {"b-id", "beta"}, {"c-id", "b-id"}}
	cases := []struct {
		name    string
		ref     Ref
		want    int
		wantErr error
	}{
		{name: "ref matches a name", ref: Ref{Kind: KindRef, Value: "alpha"}, want: 0},
		{name: "ref matches an id", ref: Ref{Kind: KindRef, Value: "a-id"}, want: 0},
		{name: "ref matching nothing", ref: Ref{Kind: KindRef, Value: "nope"}, want: -1},
		{name: "ref matching two rigs is ambiguous", ref: Ref{Kind: KindRef, Value: "b-id"}, want: -1, wantErr: ErrAmbiguous},
		{name: "id= picks the id match", ref: Ref{Kind: KindID, Value: "b-id"}, want: 1},
		{name: "name= picks the name match", ref: Ref{Kind: KindName, Value: "b-id"}, want: 2},
		{name: "name= ignores ids", ref: Ref{Kind: KindName, Value: "a-id"}, want: -1},
		{name: "id= ignores names", ref: Ref{Kind: KindID, Value: "alpha"}, want: -1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := find(tc.ref, rigs)
			if !errors.Is(err, tc.wantErr) || got != tc.want {
				t.Fatalf("Find(%v) = %d, %v; want %d, %v", tc.ref, got, err, tc.want, tc.wantErr)
			}
		})
	}

	// A rig whose name equals its own id is one rig, not two.
	if got, err := find(Ref{Kind: KindRef, Value: "same"}, []rig{{"same", "same"}}); err != nil || got != 0 {
		t.Fatalf("Find on a rig named after its own id = %d, %v; want 0, nil", got, err)
	}
}

// ref= with nothing after it must not pass as an empty reference: an empty
// rig on `send` routes nowhere and makes the server create a new rig.
func TestParseRejectsEmptyValues(t *testing.T) {
	for _, raw := range []string{"", "  ", "ref=", "name=", "id=", "ref=  "} {
		if got, err := parseWith(envResolver(nil), raw); err == nil {
			t.Errorf("parseWith(%q) = %v, want an error", raw, got)
		}
	}
}

// A pinned reference that draws a 409 already names its kind, so the hint
// to add one would loop; only a plain ref is rewritten.
func TestExplainOnlyRewritesPlainRefs(t *testing.T) {
	conflict := &apiclient.HTTPError{StatusCode: 409, Body: `{"error_code":"resource_ref_ambiguous"}`}
	if err := Explain(Ref{Kind: KindRef, Value: "dup"}, conflict); !errors.Is(err, ErrAmbiguous) {
		t.Errorf("plain ref: %v, want ErrAmbiguous", err)
	}
	if err := Explain(Ref{Kind: KindID, Value: "dup"}, conflict); errors.Is(err, ErrAmbiguous) {
		t.Errorf("id= ref: %v, want the server's error unchanged", err)
	}
}

// TestResolverName checks which environment variable names the current rig:
// RigNameEnv wins over the legacy SandboxNameEnv, and an empty variable counts
// as unset.
func TestResolverName(t *testing.T) {
	cases := []struct {
		name    string
		env     map[string]string
		want    string
		wantErr bool
	}{
		{"prefers rig name", map[string]string{RigNameEnv: "rig", SandboxNameEnv: "sandbox"}, "rig", false},
		{"falls back to sandbox name", map[string]string{SandboxNameEnv: "sandbox"}, "sandbox", false},
		{"empty rig name counts as unset", map[string]string{RigNameEnv: "", SandboxNameEnv: "sandbox"}, "sandbox", false},
		{"neither set", nil, "", true},
		{"both empty", map[string]string{RigNameEnv: "", SandboxNameEnv: ""}, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := envResolver(tc.env).Name()
			if tc.wantErr {
				if !errors.Is(err, ErrNotInRig) || !strings.Contains(err.Error(), SandboxNameEnv) {
					t.Fatalf("Name() error = %v, want ErrNotInRig naming both variables", err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("Name() = %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}
