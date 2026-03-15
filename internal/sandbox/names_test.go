package sandbox

import (
	"strings"
	"testing"
)

func TestGenerateName_Format(t *testing.T) {
	for range 100 {
		name := GenerateName()
		parts := strings.SplitN(name, "-", 2)
		if len(parts) != 2 {
			t.Fatalf("expected format color-city, got %q", name)
		}
		if parts[0] == "" || parts[1] == "" {
			t.Fatalf("empty component in %q", name)
		}
		if name != strings.ToLower(name) {
			t.Fatalf("expected all lowercase, got %q", name)
		}
	}
}

func TestGenerateUniqueName_NoCollision(t *testing.T) {
	name, err := GenerateUniqueName(func(string) bool { return false })
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if name == "" {
		t.Fatal("expected non-empty name")
	}
}

func TestGenerateUniqueName_FallsBackToSuffix(t *testing.T) {
	// Reject all plain color-city names (2 parts), accept suffixed ones (3 parts).
	name, err := GenerateUniqueName(func(n string) bool {
		return len(strings.Split(n, "-")) == 2
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	parts := strings.Split(name, "-")
	if len(parts) != 3 {
		t.Fatalf("expected suffixed name with 3 parts, got %q", name)
	}
}

func TestGenerateUniqueName_ErrorOnExhaustion(t *testing.T) {
	_, err := GenerateUniqueName(func(string) bool { return true })
	if err == nil {
		t.Fatal("expected error when all names are taken")
	}
}

func TestAllNamesLowercase(t *testing.T) {
	for i, c := range colors {
		if c != strings.ToLower(c) {
			t.Errorf("colors[%d] = %q is not lowercase", i, c)
		}
	}
	for i, c := range cities {
		if c != strings.ToLower(c) {
			t.Errorf("cities[%d] = %q is not lowercase", i, c)
		}
	}
}
