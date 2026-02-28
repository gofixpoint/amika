package auth

import (
	"reflect"
	"testing"
)

func TestNormalizeProviderName(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{in: "foo-bar", want: "FOO_BAR"},
		{in: " openai ", want: "OPENAI"},
		{in: "anthropic", want: "ANTHROPIC"},
	}

	for _, tt := range tests {
		if got := NormalizeProviderName(tt.in); got != tt.want {
			t.Fatalf("NormalizeProviderName(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestBuildEnvMap(t *testing.T) {
	result := CredentialSet{
		Anthropic: "anth-key",
		OpenAI:    "open-key",
		Other: map[string]string{
			"foo-bar": "foo-key",
		},
	}

	env := BuildEnvMap(result)
	want := map[string]string{
		"ANTHROPIC_API_KEY": "anth-key",
		"CLAUDE_API_KEY":    "anth-key",
		"OPENAI_API_KEY":    "open-key",
		"CODEX_API_KEY":     "open-key",
		"FOO_BAR_API_KEY":   "foo-key",
	}

	if env.Len() != len(want) {
		t.Fatalf("BuildEnvMap().Len() = %d, want %d", env.Len(), len(want))
	}
	for key, wantValue := range want {
		gotValue, ok := env.Get(key)
		if !ok {
			t.Fatalf("BuildEnvMap() missing key %q", key)
		}
		if gotValue != wantValue {
			t.Fatalf("BuildEnvMap()[%q] = %q, want %q", key, gotValue, wantValue)
		}
	}
}

func TestEnvVarsLines_SortedAndEscaped(t *testing.T) {
	env := NewEnvVars()
	env.Set("B_API_KEY", "x'y")
	env.Set("A_API_KEY", "abc")
	got := env.Lines(false)
	want := []string{
		"A_API_KEY='abc'",
		"B_API_KEY='x'\\''y'",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("EnvVars.Lines() = %#v, want %#v", got, want)
	}
}

func TestEnvVarsLines_WithExport(t *testing.T) {
	env := NewEnvVars()
	env.Set("A_API_KEY", "abc")
	got := env.Lines(true)
	want := []string{"export A_API_KEY='abc'"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("EnvVars.Lines(export) = %#v, want %#v", got, want)
	}
}

func TestEnvVarsSortedKeys(t *testing.T) {
	env := NewEnvVars()
	env.Set("C_API_KEY", "c")
	env.Set("A_API_KEY", "a")
	env.Set("B_API_KEY", "b")
	got := env.SortedKeys()
	want := []string{"A_API_KEY", "B_API_KEY", "C_API_KEY"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("EnvVars.SortedKeys() = %#v, want %#v", got, want)
	}
}
