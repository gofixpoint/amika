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
	result := Result{
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

	if !reflect.DeepEqual(env, want) {
		t.Fatalf("BuildEnvMap() = %#v, want %#v", env, want)
	}
}

func TestRenderEnvLines_SortedAndEscaped(t *testing.T) {
	env := map[string]string{
		"B_API_KEY": "x'y",
		"A_API_KEY": "abc",
	}
	got := RenderEnvLines(env, false)
	want := []string{
		"A_API_KEY='abc'",
		"B_API_KEY='x'\\''y'",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RenderEnvLines() = %#v, want %#v", got, want)
	}
}

func TestRenderEnvLines_WithExport(t *testing.T) {
	env := map[string]string{"A_API_KEY": "abc"}
	got := RenderEnvLines(env, true)
	want := []string{"export A_API_KEY='abc'"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RenderEnvLines(export) = %#v, want %#v", got, want)
	}
}
