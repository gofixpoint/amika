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
