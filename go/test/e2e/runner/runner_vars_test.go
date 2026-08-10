package runner

import (
	"path/filepath"
	"testing"
)

// The run id is exposed to cases as {{run_id}} so a case can give a named
// remote resource a name unique to the run. Without it a fixed name would let
// a case adopt and then delete a same-named resource it did not create.
func TestNewExposesRunIDAsTemplateVar(t *testing.T) {
	r, err := New(Options{
		BinPath: "/bin/true",
		RunDir:  filepath.Join(t.TempDir(), "run"),
		RunID:   "20260810T031122.123456789Z",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	got, err := substituteString("name-{{run_id}}", r.vars)
	if err != nil {
		t.Fatalf("substituteVars: %v", err)
	}
	if want := "name-20260810T031122.123456789Z"; got != want {
		t.Errorf("substituted = %q, want %q", got, want)
	}
}

func TestNewWithoutRunIDLeavesTheVarUndefined(t *testing.T) {
	r, err := New(Options{
		BinPath: "/bin/true",
		RunDir:  filepath.Join(t.TempDir(), "run"),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Referencing an undefined variable must fail loudly rather than send a
	// literal "{{run_id}}" to the CLI.
	if _, err := substituteString("name-{{run_id}}", r.vars); err == nil {
		t.Error("expected an error for an undefined run_id")
	}
}
