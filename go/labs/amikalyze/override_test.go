package amikalyze

import (
	"reflect"
	"strings"
	"testing"
)

func TestNewOverrides(t *testing.T) {
	root := t.TempDir()
	overrides, err := NewOverrides(root,
		[]string{"database/schema", "database/schema", "protocol"},
		[]string{"schema/./one.sql", "proto/one.proto"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"database/schema", "protocol"}; !reflect.DeepEqual(overrides.Labels, want) {
		t.Errorf("labels = %v, want %v", overrides.Labels, want)
	}
	if want := []string{"proto/one.proto", "schema/one.sql"}; !reflect.DeepEqual(overrides.Paths, want) {
		t.Errorf("paths = %v, want %v", overrides.Paths, want)
	}
}

func TestNewOverrides_RejectsInvalidPath(t *testing.T) {
	for _, value := range []string{"", "/absolute", "../parent", "schema/*.sql", "directory/"} {
		if _, err := NewOverrides(t.TempDir(), nil, []string{value}); err == nil {
			t.Errorf("NewOverrides(%q) succeeded, want error", value)
		}
	}
}

func TestOverridesEnvironmentRoundTrip(t *testing.T) {
	overrides, err := NewOverrides(t.TempDir(), []string{"schema"}, []string{"schema/one.sql"})
	if err != nil {
		t.Fatal(err)
	}
	assignment, err := OverridesEnvironment(overrides)
	if err != nil {
		t.Fatal(err)
	}
	name, value, ok := strings.Cut(assignment, "=")
	if !ok {
		t.Fatal("environment assignment has no equals sign")
	}
	t.Setenv(name, value)
	got, err := OverridesFromEnvironment()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, overrides) {
		t.Fatalf("round trip = %+v, want %+v", got, overrides)
	}
}

func TestReplaceOverridesEnvironment(t *testing.T) {
	environ := []string{"PATH=/bin", overridesEnv + "=old", "OTHER=value"}
	got := ReplaceOverridesEnvironment(environ, overridesEnv+"=new")
	if strings.Join(got, "\n") != "PATH=/bin\nOTHER=value\n"+overridesEnv+"=new" {
		t.Fatalf("environment = %v", got)
	}
}
