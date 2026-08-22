package amikalyze

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEvaluate_HierarchicalConfigAndOverrides(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, configName), `
[[freezes]]
label = "database/schema"
paths = ["schema/**/*.sql"]
`)
	writeTestFile(t, filepath.Join(root, "schema", configName), `
[[freezes]]
label = "migration"
paths = ["migrations/*.sql"]
`)
	target := filepath.Join(root, "schema", "migrations", "001.sql")

	decision, err := Evaluate(root, target, Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if len(decision.Matches) != 2 {
		t.Fatalf("matches = %+v, want database/schema and migration", decision.Matches)
	}

	decision, err = Evaluate(root, target, Overrides{RepoRoot: root, Labels: []string{"database/schema"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(decision.Matches) != 1 || decision.Matches[0].Label != "migration" {
		t.Fatalf("matches after label override = %+v, want migration", decision.Matches)
	}

	decision, err = Evaluate(root, target, Overrides{RepoRoot: root, Paths: []string{"schema/migrations/001.sql"}})
	if err != nil {
		t.Fatal(err)
	}
	if decision.Frozen() {
		t.Fatalf("exact path override left matches: %+v", decision.Matches)
	}
}

func TestEvaluate_ConfigAppliesOnlyBelowItsDirectory(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "one", configName), `
[[freezes]]
label = "one"
paths = ["**/*.go"]
`)
	decision, err := Evaluate(root, filepath.Join(root, "two", "file.go"), Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if decision.Frozen() {
		t.Fatalf("sibling config unexpectedly matched: %+v", decision.Matches)
	}
}

func TestEvaluate_DuplicateApplicableLabelFails(t *testing.T) {
	root := t.TempDir()
	for _, directory := range []string{root, filepath.Join(root, "nested")} {
		writeTestFile(t, filepath.Join(directory, configName), `
[[freezes]]
label = "same"
paths = ["**"]
`)
	}
	_, err := Evaluate(root, filepath.Join(root, "nested", "file.txt"), Overrides{})
	if err == nil || !strings.Contains(err.Error(), "defined in both") {
		t.Fatalf("Evaluate() error = %v, want duplicate label error", err)
	}
}

func TestEvaluate_ConfigFileIsImplicitlyFrozen(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, configName)
	writeTestFile(t, configPath, `
[[freezes]]
label = "source"
paths = ["src/**"]
`)
	decision, err := Evaluate(root, configPath, Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Frozen() || decision.Matches[0].Label != "amikalyze-policy" {
		t.Fatalf("config decision = %+v, want implicit policy freeze", decision)
	}
	decision, err = Evaluate(root, configPath, Overrides{RepoRoot: root, Paths: []string{configName}})
	if err != nil {
		t.Fatal(err)
	}
	if decision.Frozen() {
		t.Fatalf("path override did not unfreeze config: %+v", decision.Matches)
	}
}

func TestEvaluate_MalformedConfigFailsClosed(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, configName), "not valid [[[")
	_, err := Evaluate(root, filepath.Join(root, "file.txt"), Overrides{})
	if err == nil || !strings.Contains(err.Error(), "parsing") {
		t.Fatalf("Evaluate() error = %v, want parse error", err)
	}
}

func writeTestFile(t *testing.T, filename, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
