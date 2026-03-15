package sandbox

import (
	"strings"
	"testing"
)

func TestValidateName(t *testing.T) {
	valid := []string{
		"foo",
		"a",
		"red-tokyo",
		"my-sandbox-1",
		"abc123",
		"a-b-c",
	}
	for _, name := range valid {
		if err := ValidateName(name); err != nil {
			t.Errorf("ValidateName(%q) = %v; want nil", name, err)
		}
	}

	invalid := []struct {
		name string
		desc string
	}{
		{"", "empty"},
		{"My-Sandbox", "uppercase"},
		{"foo_bar", "underscore"},
		{"-foo", "leading hyphen"},
		{"foo-", "trailing hyphen"},
		{"foo--bar", "consecutive hyphens"},
		{"foo.bar", "dot"},
		{"hello world", "space"},
		{strings.Repeat("a", 64), "too long"},
	}
	for _, tc := range invalid {
		if err := ValidateName(tc.name); err == nil {
			t.Errorf("ValidateName(%q) [%s] = nil; want error", tc.name, tc.desc)
		}
	}
}

func TestGenerateNameIsValid(t *testing.T) {
	for i := 0; i < 100; i++ {
		name := GenerateName()
		if err := ValidateName(name); err != nil {
			t.Fatalf("GenerateName() = %q; ValidateName returned %v", name, err)
		}
	}
}
