package rigref

import (
	"errors"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/rigself"
)

func envResolver(env map[string]string) rigself.Resolver {
	return rigself.Resolver{LookupEnv: func(key string) (string, bool) {
		value, ok := env[key]
		return value, ok
	}}
}

func TestParse(t *testing.T) {
	inRig := map[string]string{rigself.RigNameEnv: "here"}
	cases := []struct {
		name    string
		env     map[string]string
		raw     string
		want    Ref
		wantErr string
	}{
		{name: "bare value matches by id or name", raw: "my-rig", want: Ref{KindRef, "my-rig"}},
		{name: "ref= is the explicit spelling", raw: "ref=my-rig", want: Ref{KindRef, "my-rig"}},
		{name: "name= matches by name only", raw: "name=my-rig", want: Ref{KindName, "my-rig"}},
		{name: "id= matches by id only", raw: "id=9f3c8b21-0000-4000-8000-000000000000", want: Ref{KindID, "9f3c8b21-0000-4000-8000-000000000000"}},
		// Only the first '=' separates the kind, so a legacy name that itself
		// starts with a kind word stays reachable.
		{name: "splits on the first equals only", raw: "name=id=legacy", want: Ref{KindName, "id=legacy"}},
		{name: "unknown prefix is part of the value", raw: "nmae=my-rig", want: Ref{KindRef, "nmae=my-rig"}},
		{name: "prefix match is case sensitive", raw: "NAME=my-rig", want: Ref{KindRef, "NAME=my-rig"}},
		{name: "empty value after a prefix is refused", raw: "name=", wantErr: "no value"},
		{name: "_self resolves to a name match", env: inRig, raw: "_self", want: Ref{KindName, "here"}},
		{name: "name=_self resolves too", env: inRig, raw: "name=_self", want: Ref{KindName, "here"}},
		{name: "ref=_self resolves too", env: inRig, raw: "ref=_self", want: Ref{KindName, "here"}},
		{name: "id=_self is refused", env: inRig, raw: "id=_self", wantErr: "not its id"},
		{name: "_self outside a rig names the env vars", raw: "_self", wantErr: rigself.RigNameEnv},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseWith(envResolver(tc.env), tc.raw)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("ParseWith(%q) = %v, %v; want error containing %q", tc.raw, got, err, tc.wantErr)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("ParseWith(%q) = %v, %v; want %v", tc.raw, got, err, tc.want)
			}
		})
	}
}

func TestRefString(t *testing.T) {
	for _, tc := range []struct {
		ref  Ref
		want string
	}{
		{Ref{KindRef, "a"}, "a"},
		{Ref{KindName, "a"}, "name=a"},
		{Ref{KindID, "a"}, "id=a"},
	} {
		if got := tc.ref.String(); got != tc.want {
			t.Errorf("%#v.String() = %q, want %q", tc.ref, got, tc.want)
		}
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
		{name: "ref matches a name", ref: Ref{KindRef, "alpha"}, want: 0},
		{name: "ref matches an id", ref: Ref{KindRef, "a-id"}, want: 0},
		{name: "ref matching nothing", ref: Ref{KindRef, "nope"}, want: -1},
		{name: "ref matching two rigs is ambiguous", ref: Ref{KindRef, "b-id"}, want: -1, wantErr: ErrAmbiguous},
		{name: "id= picks the id match", ref: Ref{KindID, "b-id"}, want: 1},
		{name: "name= picks the name match", ref: Ref{KindName, "b-id"}, want: 2},
		{name: "name= ignores ids", ref: Ref{KindName, "a-id"}, want: -1},
		{name: "id= ignores names", ref: Ref{KindID, "alpha"}, want: -1},
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
	if got, err := find(Ref{KindRef, "same"}, []rig{{"same", "same"}}); err != nil || got != 0 {
		t.Fatalf("Find on a rig named after its own id = %d, %v; want 0, nil", got, err)
	}
}
