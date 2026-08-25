package runner

import (
	"path/filepath"
	"strings"
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

func TestNewExposesSandboxProviderAsTemplateVar(t *testing.T) {
	r, err := New(Options{
		BinPath:         "/bin/true",
		RunDir:          t.TempDir(),
		SandboxProvider: "e2b",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	got, err := substituteString("--provider={{sandbox_provider}}", r.vars)
	if err != nil {
		t.Fatalf("substituteString: %v", err)
	}
	if got != "--provider=e2b" {
		t.Fatalf("got %q, want %q", got, "--provider=e2b")
	}
}

// A case-level var resolves per provider so a case can assert a value exactly
// even when the API legitimately reports a different one on each provider
// (e.g. Daytona's generation-prefixed sandbox sizes).
func TestCaseVarsResolvePerProvider(t *testing.T) {
	spec := VarSpec{
		Default:    "m",
		DefaultSet: true,
		ByProvider: map[string]string{"daytona": "a0.m"},
	}
	c := &Case{Name: "c", Vars: map[string]VarSpec{"expected_size": spec}}

	for _, tc := range []struct{ provider, want string }{
		{"daytona", "a0.m"}, // provider entry wins
		{"e2b", "m"},        // falls back to the default
		{"", "m"},           // no provider selected (runner unit tests)
	} {
		t.Run(tc.provider, func(t *testing.T) {
			r, err := New(Options{
				BinPath:         "/bin/true",
				RunDir:          t.TempDir(),
				SandboxProvider: tc.provider,
			})
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if err := r.applyCaseVars(c); err != nil {
				t.Fatalf("applyCaseVars: %v", err)
			}
			got, err := substituteString("{{expected_size}}", r.vars)
			if err != nil {
				t.Fatalf("substituteString: %v", err)
			}
			if got != tc.want {
				t.Fatalf("provider %q: got %q, want %q", tc.provider, got, tc.want)
			}
		})
	}
}

// A scalar var is a constant for every provider, so the common
// non-conditional case stays a one-liner in the case file.
func TestCaseVarScalarAppliesToEveryProvider(t *testing.T) {
	c := &Case{
		Name: "c",
		Vars: map[string]VarSpec{"fixed": {Value: "always", scalar: true}},
	}
	r, err := New(Options{BinPath: "/bin/true", RunDir: t.TempDir(), SandboxProvider: "vercel"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := r.applyCaseVars(c); err != nil {
		t.Fatalf("applyCaseVars: %v", err)
	}
	if got := r.vars["fixed"]; got != "always" {
		t.Fatalf("got %q, want %q", got, "always")
	}
}

// A mapping with no default that does not cover the selected provider is
// rejected at load time, but guard the runtime path too: resolution must fail
// loudly rather than leave the var undefined and surface as a confusing
// "undefined template var" mid-case.
func TestCaseVarsUnresolvableProviderIsAnError(t *testing.T) {
	c := &Case{
		Name: "c",
		Vars: map[string]VarSpec{
			"expected_size": {ByProvider: map[string]string{"daytona": "a0.m"}},
		},
	}
	r, err := New(Options{BinPath: "/bin/true", RunDir: t.TempDir(), SandboxProvider: "e2b"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	err = r.applyCaseVars(c)
	if err == nil {
		t.Fatal("expected an error for a provider the var does not cover")
	}
	if !strings.Contains(err.Error(), "expected_size") || !strings.Contains(err.Error(), "e2b") {
		t.Fatalf("error should name the var and the provider, got: %v", err)
	}
}

func TestLoadCaseVarsValidation(t *testing.T) {
	valid := map[string]string{
		"scalar":             "name: c\nvars:\n  v: fixed\nsteps: [{name: s, cmd: [x]}]\n",
		"default only":       "name: c\nvars:\n  v:\n    default: m\nsteps: [{name: s, cmd: [x]}]\n",
		"default plus one":   "name: c\nvars:\n  v:\n    default: m\n    daytona: a0.m\nsteps: [{name: s, cmd: [x]}]\n",
		"all providers":      "name: c\nvars:\n  v:\n    daytona: a\n    e2b: b\n    freestyle: c\n    vercel: d\nsteps: [{name: s, cmd: [x]}]\n",
		"empty string value": "name: c\nvars:\n  v:\n    default: \"\"\nsteps: [{name: s, cmd: [x]}]\n",
	}
	for label, content := range valid {
		t.Run("valid/"+label, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "case.yaml")
			writeFile(t, path, content)
			if _, err := LoadCase(path); err != nil {
				t.Fatalf("expected %s to load, got: %v", label, err)
			}
		})
	}

	invalid := map[string]string{
		// A typo'd provider key would otherwise fall through to the default on
		// every provider, so the case asserts nothing provider-specific.
		"unknown provider key": "name: c\nvars:\n  v:\n    default: m\n    daytonaa: a0.m\nsteps: [{name: s, cmd: [x]}]\n",
		// No default and an unlisted provider would fail mid-case instead.
		"partial without default": "name: c\nvars:\n  v:\n    daytona: a0.m\nsteps: [{name: s, cmd: [x]}]\n",
		"empty mapping":           "name: c\nvars:\n  v: {}\nsteps: [{name: s, cmd: [x]}]\n",
		"reserved run_id":         "name: c\nvars:\n  run_id: x\nsteps: [{name: s, cmd: [x]}]\n",
		"reserved provider":       "name: c\nvars:\n  sandbox_provider: x\nsteps: [{name: s, cmd: [x]}]\n",
		"unreferenceable name":    "name: c\nvars:\n  \"a/b\": x\nsteps: [{name: s, cmd: [x]}]\n",
		"not scalar or mapping":   "name: c\nvars:\n  v: [a, b]\nsteps: [{name: s, cmd: [x]}]\n",
		// A capture reusing the name would change what {{v}} means partway
		// through the case.
		"capture shadows var": "name: c\nvars:\n  v: x\nsteps: [{name: s, cmd: [x], capture: {v: $.name}}]\n",
	}
	for label, content := range invalid {
		t.Run("invalid/"+label, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "case.yaml")
			writeFile(t, path, content)
			if _, err := LoadCase(path); err == nil {
				t.Fatalf("expected %s to be rejected", label)
			}
		})
	}
}
