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

// TestParse checks each reference's parsed kind and value, the selector it
// carries to the API, and how output labels it. The selector is the kind the
// user spelled out, and a plain ref otherwise, bare "_self" included, since it
// stands in for the rig's name typed bare. The label is the reference as the
// user wrote it, except that "_self" shows the rig name it stands for.
func TestParse(t *testing.T) {
	inRig := map[string]string{RigNameEnv: "here"}
	sandboxOnly := map[string]string{RigNameEnv: "", SandboxNameEnv: "legacy"}
	cases := []struct {
		name    string
		env     map[string]string
		raw     string
		want    Ref
		by      string // the selector's kind
		label   string
		wantErr string
	}{
		{name: "bare value matches by id or name", raw: "my-rig", want: Ref{Kind: KindRef, Value: "my-rig"}, by: "ref", label: "my-rig"},
		{name: "ref= is the explicit spelling", raw: "ref=my-rig", want: Ref{Kind: KindRef, Value: "my-rig"}, by: "ref", label: "ref=my-rig"},
		{name: "name= matches by name only", raw: "name=my-rig", want: Ref{Kind: KindName, Value: "my-rig"}, by: "name", label: "name=my-rig"},
		{name: "id= matches by id only", raw: "id=abc", want: Ref{Kind: KindID, Value: "abc"}, by: "id", label: "id=abc"},
		// Only the first '=' separates the kind, so a legacy name that itself
		// starts with a kind word stays reachable.
		{name: "splits on the first equals only", raw: "name=id=legacy", want: Ref{Kind: KindName, Value: "id=legacy"}, by: "name", label: "name=id=legacy"},
		{name: "unknown prefix is part of the value", raw: "nmae=my-rig", want: Ref{Kind: KindRef, Value: "nmae=my-rig"}, by: "ref", label: "nmae=my-rig"},
		{name: "prefix match is case sensitive", raw: "NAME=my-rig", want: Ref{Kind: KindRef, Value: "NAME=my-rig"}, by: "ref", label: "NAME=my-rig"},
		{name: "_self resolves to a name match sent as a ref", env: inRig, raw: "_self", want: Ref{Kind: KindName, Value: "here"}, by: "ref", label: "here"},
		{name: "name=_self resolves too", env: inRig, raw: "name=_self", want: Ref{Kind: KindName, Value: "here"}, by: "name", label: "here"},
		{name: "ref=_self resolves too", env: inRig, raw: "ref=_self", want: Ref{Kind: KindName, Value: "here"}, by: "ref", label: "here"},
		{name: "_self falls back to the legacy variable", env: sandboxOnly, raw: "_self", want: Ref{Kind: KindName, Value: "legacy"}, by: "ref", label: "legacy"},
		{name: "only the exact literal is _self", env: inRig, raw: "_self-x", want: Ref{Kind: KindRef, Value: "_self-x"}, by: "ref", label: "_self-x"},
		{name: "id=_self is refused", env: inRig, raw: "id=_self", wantErr: "not its id"},
		{name: "_self outside a rig names the env vars", raw: "_self", wantErr: RigNameEnv},
		// An empty reference must not pass: an empty rig on `send` routes
		// nowhere and makes the server create a new rig.
		{name: "empty", raw: "", wantErr: "must not be empty"},
		{name: "blank", raw: "  ", wantErr: "must not be empty"},
		{name: "empty value after name=", raw: "name=", wantErr: "no value"},
		{name: "empty value after id=", raw: "id=", wantErr: "no value"},
		{name: "empty value after ref=", raw: "ref=", wantErr: "no value"},
		{name: "blank value after ref=", raw: "ref=  ", wantErr: "no value"},
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
			if sel, want := got.Selector(), (apiclient.SandboxSelector{Value: tc.want.Value, By: tc.by}); sel != want {
				t.Errorf("Selector() = %#v, want %#v", sel, want)
			}
			if label := Label(tc.raw, got); label != tc.label {
				t.Errorf("Label() = %q, want %q", label, tc.label)
			}
		})
	}
}

// TestExplain checks that the API's 409 resource_ref_ambiguous becomes
// ErrAmbiguous with the id=/name= spellings, and that other errors pass
// through untouched. A pinned reference that draws a 409 already names its
// kind, so the hint to add one would loop; only a plain ref is rewritten.
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
	if got := Explain(Ref{Kind: KindID, Value: "b-id"}, conflict); got != conflict {
		t.Fatalf("Explain(id=, 409) = %v, want the server's error unchanged", got)
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
