package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// -----------------------------------------------------------------------
// matcher.go
// -----------------------------------------------------------------------

func TestMatchScalars(t *testing.T) {
	cases := []struct {
		name     string
		expected any
		actual   any
		wantErr  bool
	}{
		{"equal strings", "hello", "hello", false},
		{"different strings", "hello", "goodbye", true},
		{"equal numbers", float64(42), float64(42), false},
		{"yaml int vs json float64", int(42), float64(42), false},
		{"different numbers", float64(1), float64(2), true},
		{"equal bools", true, true, false},
		{"different bools", true, false, true},
		{"both nil", nil, nil, false},
		{"nil vs value", nil, "x", true},
		{"value vs nil", "x", nil, true},
		{"type mismatch string vs number", "5", float64(5), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := Match(c.expected, c.actual)
			if c.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !c.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}

func TestMatchTypePlaceholders(t *testing.T) {
	cases := []struct {
		name     string
		expected any
		actual   any
		wantErr  bool
	}{
		{"@string ok", "@string", "hi", false},
		{"@string wrong type", "@string", float64(1), true},
		{"@number ok", "@number", float64(1), false},
		{"@number wrong type", "@number", "1", true},
		{"@bool ok", "@bool", true, false},
		{"@bool wrong type", "@bool", "true", true},
		{"@array ok", "@array", []any{}, false},
		{"@array wrong type", "@array", map[string]any{}, true},
		{"@object ok", "@object", map[string]any{}, false},
		{"@object wrong type", "@object", []any{}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := Match(c.expected, c.actual)
			if c.wantErr && err == nil {
				t.Fatalf("expected error, got nil")
			}
			if !c.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}

func TestMatchOptionalPlaceholder(t *testing.T) {
	// "@string?" inside an object: absent key, explicit null, and a
	// present string all pass; a present non-string fails.
	expected := map[string]any{"name": "@string?"}

	if err := Match(expected, map[string]any{}); err != nil {
		t.Fatalf("absent key should pass: %v", err)
	}
	if err := Match(expected, map[string]any{"name": nil}); err != nil {
		t.Fatalf("explicit null should pass: %v", err)
	}
	if err := Match(expected, map[string]any{"name": "bob"}); err != nil {
		t.Fatalf("present string should pass: %v", err)
	}
	if err := Match(expected, map[string]any{"name": float64(1)}); err == nil {
		t.Fatalf("present non-string should fail")
	}
}

func TestMatchOneOf(t *testing.T) {
	expected := "@oneof: active, running, started"

	if err := Match(expected, "running"); err != nil {
		t.Fatalf("expected match, got %v", err)
	}
	if err := Match(expected, "stopped"); err == nil {
		t.Fatalf("expected mismatch error")
	}
	// Numbers stringify for comparison too.
	if err := Match("@oneof: 1, 2, 3", float64(2)); err != nil {
		t.Fatalf("expected numeric oneof match, got %v", err)
	}
}

func TestMatchTimestamp(t *testing.T) {
	if err := Match("@timestamp", "2024-01-02T15:04:05Z"); err != nil {
		t.Fatalf("expected RFC3339 to pass: %v", err)
	}
	if err := Match("@timestamp", "2024-01-02T15:04:05.123456789Z"); err != nil {
		t.Fatalf("expected RFC3339Nano to pass: %v", err)
	}
	if err := Match("@timestamp", "not-a-timestamp"); err == nil {
		t.Fatalf("expected non-timestamp to fail")
	}
	if err := Match("@timestamp", float64(1)); err == nil {
		t.Fatalf("expected non-string to fail")
	}
}

func TestMatchRegex(t *testing.T) {
	if err := Match("@regex: ^sb-[a-z0-9]+$", "sb-abc123"); err != nil {
		t.Fatalf("expected regex match, got %v", err)
	}
	if err := Match("@regex: ^sb-[a-z0-9]+$", "nope"); err == nil {
		t.Fatalf("expected regex mismatch")
	}
	// Colons inside the pattern itself must survive splitting on the
	// first ":".
	if err := Match(`@regex: ^\d{2}:\d{2}$`, "12:30"); err != nil {
		t.Fatalf("expected colon-containing regex to match, got %v", err)
	}
}

func TestMatchObjectSubset(t *testing.T) {
	actual := map[string]any{
		"name":  "sb-1",
		"state": "running",
		"extra": "ignored",
		"nested": map[string]any{
			"port":       float64(8080),
			"irrelevant": true,
		},
	}
	expected := map[string]any{
		"name": "@string",
		"nested": map[string]any{
			"port": "@number",
		},
	}
	if err := Match(expected, actual); err != nil {
		t.Fatalf("subset match should ignore extra keys: %v", err)
	}
}

func TestMatchObjectMissingKey(t *testing.T) {
	err := Match(map[string]any{"name": "@string"}, map[string]any{})
	if err == nil {
		t.Fatalf("expected missing-key error")
	}
	if !strings.Contains(err.Error(), `missing key "name"`) {
		t.Fatalf("expected missing key message, got: %v", err)
	}
}

func TestMatchArrayPositionalWithExtras(t *testing.T) {
	expected := []any{
		map[string]any{"name": "first"},
	}
	actual := []any{
		map[string]any{"name": "first", "extra": true},
		map[string]any{"name": "second"},
	}
	if err := Match(expected, actual); err != nil {
		t.Fatalf("expected positional match ignoring extra trailing items: %v", err)
	}
}

func TestMatchArrayTooShort(t *testing.T) {
	expected := []any{"a", "b"}
	actual := []any{"a"}
	if err := Match(expected, actual); err == nil {
		t.Fatalf("expected error when actual has fewer items than expected")
	}
}

func TestMatchErrorIncludesJSONPath(t *testing.T) {
	expected := map[string]any{
		"ports": []any{
			map[string]any{"host_port": "@number"},
		},
	}
	actual := map[string]any{
		"ports": []any{
			map[string]any{"host_port": "not-a-number"},
		},
	}
	err := Match(expected, actual)
	if err == nil {
		t.Fatalf("expected mismatch error")
	}
	const wantPath = "$.ports[0].host_port"
	if !strings.Contains(err.Error(), wantPath) {
		t.Fatalf("expected error to include path %q, got: %v", wantPath, err)
	}
}

func TestMatchUnknownMatcherIsAnError(t *testing.T) {
	if err := Match("@bogus", "x"); err == nil {
		t.Fatalf("expected unknown matcher to error")
	}
}

// -----------------------------------------------------------------------
// jsonpath.go
// -----------------------------------------------------------------------

func TestExtractJSONPath(t *testing.T) {
	doc := map[string]any{
		"name": "sb-1",
		"a":    map[string]any{"b": "deep"},
		"items": []any{
			map[string]any{"name": "first"},
			map[string]any{"name": "second"},
		},
	}

	cases := []struct {
		path string
		want any
	}{
		{"$.name", "sb-1"},
		{"$.a.b", "deep"},
		{"$.items[0].name", "first"},
		{"$.items[1].name", "second"},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			got, err := ExtractJSONPath(c.path, doc)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != c.want {
				t.Fatalf("path %s: expected %v, got %v", c.path, c.want, got)
			}
		})
	}
}

func TestExtractJSONPathArrayRoot(t *testing.T) {
	doc := []any{
		map[string]any{"name": "first"},
		map[string]any{"name": "second"},
	}
	got, err := ExtractJSONPath("$[0].name", doc)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "first" {
		t.Fatalf("expected \"first\", got %v", got)
	}
}

func TestExtractJSONPathErrors(t *testing.T) {
	doc := map[string]any{
		"name":  "sb-1",
		"items": []any{"x"},
	}
	cases := []struct {
		name string
		path string
	}{
		{"missing field", "$.nope"},
		{"index out of range", "$.items[5]"},
		{"index into non-array", "$.name[0]"},
		{"field into non-object", "$.name.nested"},
		{"missing dollar", "name"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := ExtractJSONPath(c.path, doc); err == nil {
				t.Fatalf("expected error for path %q", c.path)
			}
		})
	}
}

// -----------------------------------------------------------------------
// runner.go: case loading, discovery, templating
// -----------------------------------------------------------------------

func TestLoadCase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "case.yaml")
	writeFile(t, path, `
name: a sample case
steps:
  - name: step one
    cmd: [--help]
    expect:
      exit: 0
`)
	c, err := LoadCase(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Name != "a sample case" {
		t.Fatalf("unexpected name: %q", c.Name)
	}
	if len(c.Steps) != 1 || c.Steps[0].Name != "step one" {
		t.Fatalf("unexpected steps: %+v", c.Steps)
	}
	if c.SourcePath != path {
		t.Fatalf("expected SourcePath %q, got %q", path, c.SourcePath)
	}
}

func TestLoadCaseValidationErrors(t *testing.T) {
	dir := t.TempDir()

	cases := map[string]string{
		"missing name":  "steps:\n  - name: x\n    cmd: [y]\n",
		"missing steps": "name: x\n",
		"step no name":  "name: x\nsteps:\n  - cmd: [y]\n",
		"step no cmd":   "name: x\nsteps:\n  - name: y\n",
	}
	for label, content := range cases {
		t.Run(label, func(t *testing.T) {
			path := filepath.Join(dir, label+".yaml")
			writeFile(t, path, content)
			if _, err := LoadCase(path); err == nil {
				t.Fatalf("expected validation error for %s", label)
			}
		})
	}
}

func TestDiscoverCases(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "b.yaml"), "name: b\nsteps: [{name: s, cmd: [x]}]\n")
	writeFile(t, filepath.Join(dir, "a.yaml"), "name: a\nsteps: [{name: s, cmd: [x]}]\n")
	writeFile(t, filepath.Join(dir, "readme.txt"), "not a case")

	files, err := DiscoverCases(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("expected 2 case files, got %v", files)
	}
	if filepath.Base(files[0]) != "a.yaml" || filepath.Base(files[1]) != "b.yaml" {
		t.Fatalf("expected sorted order, got %v", files)
	}
}

func TestSubstituteString(t *testing.T) {
	vars := map[string]string{"sandbox_name": "sb-1"}

	got, err := substituteString("sandbox {{sandbox_name}} ready", vars)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "sandbox sb-1 ready" {
		t.Fatalf("unexpected result: %q", got)
	}

	if _, err := substituteString("{{undefined_var}}", vars); err == nil {
		t.Fatalf("expected error for undefined var")
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"create remote sandbox": "create-remote-sandbox",
		"  leading/trailing  ":  "leading-trailing",
		"UPPER_CASE!!":          "upper-case",
	}
	for in, want := range cases {
		if got := slugify(in); got != want {
			t.Fatalf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

// -----------------------------------------------------------------------
// ledger.go
// -----------------------------------------------------------------------

func TestLedgerAppendPersistsToDisk(t *testing.T) {
	dir := t.TempDir()
	ledgerPath := filepath.Join(dir, "ledger.json")

	l, err := NewLedger(ledgerPath)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}

	e1 := Entry{Type: "sandbox", Name: "sb-1", CreatedByStep: "create", CleanupArgv: []string{"sandbox", "delete", "sb-1"}}
	e2 := Entry{Type: "volume", Name: "vol-1", CreatedByStep: "mount", CleanupArgv: []string{"volume", "delete", "vol-1"}}

	if err := l.Append(e1); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := l.Append(e2); err != nil {
		t.Fatalf("Append: %v", err)
	}

	if got := l.Entries(); len(got) != 2 || got[0].Name != "sb-1" || got[1].Name != "vol-1" {
		t.Fatalf("unexpected in-memory entries: %+v", got)
	}

	onDisk, err := LoadLedgerEntries(ledgerPath)
	if err != nil {
		t.Fatalf("LoadLedgerEntries: %v", err)
	}
	if len(onDisk) != 2 || onDisk[1].Type != "volume" {
		t.Fatalf("unexpected on-disk entries: %+v", onDisk)
	}
}

func TestNewLedgerTruncatesExisting(t *testing.T) {
	dir := t.TempDir()
	ledgerPath := filepath.Join(dir, "ledger.json")

	l1, err := NewLedger(ledgerPath)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	if err := l1.Append(Entry{Type: "sandbox", Name: "stale"}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	l2, err := NewLedger(ledgerPath)
	if err != nil {
		t.Fatalf("NewLedger (second): %v", err)
	}
	if entries := l2.Entries(); len(entries) != 0 {
		t.Fatalf("expected fresh ledger to start empty, got %+v", entries)
	}
	onDisk, err := LoadLedgerEntries(ledgerPath)
	if err != nil {
		t.Fatalf("LoadLedgerEntries: %v", err)
	}
	if len(onDisk) != 0 {
		t.Fatalf("expected on-disk ledger truncated, got %+v", onDisk)
	}
}

// stubScript writes a tiny shell script standing in for a binary under
// test, so ledger and runner tests never need to build or invoke the real
// amika CLI. Invoked as:
//
//	stub <exit_code> <stdout_text> <stderr_text> [echo-stdin]
//
// It writes stdout_text to stdout (or stdin's contents, if the fourth arg
// is "echo-stdin"), stderr_text to stderr, and exits with exit_code.
func stubScript(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("stub script requires a POSIX shell")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "stub.sh")
	content := "#!/bin/sh\n" +
		"if [ \"$4\" = \"echo-stdin\" ]; then\n" +
		"  cat\n" +
		"else\n" +
		"  printf '%s' \"$2\"\n" +
		"fi\n" +
		"printf '%s' \"$3\" 1>&2\n" +
		"exit \"$1\"\n"
	writeFile(t, path, content)
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatalf("chmod stub: %v", err)
	}
	return path
}

func TestCleanupRunsInReverseOrderAndContinuesOnFailure(t *testing.T) {
	bin := stubScript(t)

	entries := []Entry{
		{Type: "sandbox", Name: "first", CleanupArgv: []string{"0", "", ""}},
		{Type: "sandbox", Name: "second", CleanupArgv: []string{"1", "", "boom"}},
		{Type: "sandbox", Name: "third", CleanupArgv: []string{"0", "", ""}},
	}

	results := Cleanup(bin, entries)
	if len(results) != 3 {
		t.Fatalf("expected 3 results, got %d", len(results))
	}

	// Reverse order: "third" first, then "second", then "first".
	if results[0].Entry.Name != "third" || results[1].Entry.Name != "second" || results[2].Entry.Name != "first" {
		t.Fatalf("expected reverse order, got %v, %v, %v", results[0].Entry.Name, results[1].Entry.Name, results[2].Entry.Name)
	}

	if results[0].Err != nil {
		t.Fatalf("expected 'third' cleanup to succeed, got %v", results[0].Err)
	}
	if results[1].Err == nil {
		t.Fatalf("expected 'second' cleanup to fail")
	}
	if !strings.Contains(results[1].Stderr, "boom") {
		t.Fatalf("expected stderr to be captured, got %q", results[1].Stderr)
	}
	if results[2].Err != nil {
		t.Fatalf("expected 'first' cleanup to still run and succeed despite 'second' failing, got %v", results[2].Err)
	}
}

func TestCleanupFromLedgerFile(t *testing.T) {
	bin := stubScript(t)
	dir := t.TempDir()
	ledgerPath := filepath.Join(dir, "ledger.json")

	l, err := NewLedger(ledgerPath)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	if err := l.Append(Entry{Type: "sandbox", Name: "crashed-run-resource", CleanupArgv: []string{"0", "", ""}}); err != nil {
		t.Fatalf("Append: %v", err)
	}

	results, err := CleanupFromLedgerFile(bin, ledgerPath)
	if err != nil {
		t.Fatalf("CleanupFromLedgerFile: %v", err)
	}
	if len(results) != 1 || results[0].Entry.Name != "crashed-run-resource" {
		t.Fatalf("unexpected results: %+v", results)
	}
	if results[0].Err != nil {
		t.Fatalf("expected cleanup to succeed: %v", results[0].Err)
	}
}

func TestWriteCleanupResults(t *testing.T) {
	dir := t.TempDir()
	results := []CleanupResult{
		{Entry: Entry{Type: "sandbox", Name: "x"}, Stdout: "ok"},
	}
	if err := WriteCleanupResults(dir, results); err != nil {
		t.Fatalf("WriteCleanupResults: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "cleanup-results.json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var got []CleanupResult
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if len(got) != 1 || got[0].Entry.Name != "x" {
		t.Fatalf("unexpected persisted results: %+v", got)
	}
}

// -----------------------------------------------------------------------
// runner.go: full Runner.RunCase against the stub binary
// -----------------------------------------------------------------------

func intPtr(i int) *int { return &i }

func TestRunnerRunCaseCapturesTemplatesAndRegistersResource(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "capture and template",
		Steps: []Step{
			{
				Name: "create",
				Cmd:  []string{"0", `{"name":"widget-1","port":8080}`, ""},
				Expect: Expectation{
					Exit: intPtr(0),
					StdoutJSON: map[string]any{
						"name": "@string",
						"port": "@number",
					},
				},
				Capture: map[string]string{"widget_name": "$.name"},
			},
			{
				Name:   "use captured var",
				Cmd:    []string{"0", `{"used":"{{widget_name}}"}`, ""},
				Expect: Expectation{StdoutContains: "widget-1"},
				Resource: &Resource{
					Type:    "widget",
					Name:    "{{widget_name}}",
					Cleanup: []string{"0", "", ""},
				},
			},
		},
	}

	if err := r.RunCase(c); err != nil {
		t.Fatalf("RunCase: %v", err)
	}

	if got := r.Vars()["widget_name"]; got != "widget-1" {
		t.Fatalf("expected captured var widget_name=widget-1, got %q", got)
	}

	entries := r.Ledger().Entries()
	if len(entries) != 1 || entries[0].Name != "widget-1" {
		t.Fatalf("expected one registered resource named widget-1, got %+v", entries)
	}

	// Transcripts were written for both steps.
	if _, err := os.Stat(filepath.Join(runDir, "steps", "01-create.stdout")); err != nil {
		t.Fatalf("expected step 1 transcript: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runDir, "steps", "02-use-captured-var.stdout")); err != nil {
		t.Fatalf("expected step 2 transcript: %v", err)
	}
}

// TestRunnerRegistersResourceFromSameStepCapture covers the common real-world
// shape: a single step creates a resource, captures its id/name from that same
// command's own output, and registers cleanup referencing that capture. The
// resource block must be templated AFTER the step's capture runs.
func TestRunnerRegistersResourceFromSameStepCapture(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "same-step capture into resource",
		Steps: []Step{
			{
				Name:    "create and register in one step",
				Cmd:     []string{"0", `{"name":"sb-xyz"}`, ""},
				Expect:  Expectation{Exit: intPtr(0)},
				Capture: map[string]string{"sandbox_name": "$.name"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "{{sandbox_name}}",
					Cleanup: []string{"0", "deleted {{sandbox_name}}", ""},
				},
			},
		},
	}

	if err := r.RunCase(c); err != nil {
		t.Fatalf("RunCase: %v", err)
	}

	entries := r.Ledger().Entries()
	if len(entries) != 1 {
		t.Fatalf("expected one registered resource, got %+v", entries)
	}
	if entries[0].Name != "sb-xyz" {
		t.Fatalf("expected resource name templated to sb-xyz, got %q", entries[0].Name)
	}
	if len(entries[0].CleanupArgv) != 3 || entries[0].CleanupArgv[1] != "deleted sb-xyz" {
		t.Fatalf("expected cleanup argv templated with the same-step capture, got %#v", entries[0].CleanupArgv)
	}
}

func TestRunnerRunCaseStopsAtFirstFailure(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "stops early",
		Steps: []Step{
			{Name: "ok step", Cmd: []string{"0", "", ""}},
			{Name: "failing step", Cmd: []string{"1", "", "explode"}},
			{Name: "never runs", Cmd: []string{"0", "", ""}},
		},
	}

	err = r.RunCase(c)
	if err == nil {
		t.Fatalf("expected RunCase to fail")
	}
	if !strings.Contains(err.Error(), "failing step") {
		t.Fatalf("expected error to name the failing step, got: %v", err)
	}

	if _, statErr := os.Stat(filepath.Join(runDir, "steps", "03-never-runs.stdout")); statErr == nil {
		t.Fatalf("expected step 3 to never run, but its transcript exists")
	}
}

func TestRunnerStdinIsPassedToStep(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "stdin",
		Steps: []Step{
			{
				Name:   "echo stdin",
				Cmd:    []string{"0", "", "", "echo-stdin"},
				Stdin:  "hello from stdin",
				Expect: Expectation{StdoutContains: "hello from stdin"},
			},
		},
	}
	if err := r.RunCase(c); err != nil {
		t.Fatalf("RunCase: %v", err)
	}
}

func TestRunnerStateDirInjectedIntoEnv(t *testing.T) {
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")
	scriptPath := filepath.Join(dir, "print-env.sh")
	writeFile(t, scriptPath, "#!/bin/sh\nprintf '%s' \"$AMIKA_STATE_DIRECTORY\"\n")
	if err := os.Chmod(scriptPath, 0o755); err != nil {
		t.Fatalf("chmod: %v", err)
	}

	r, err := New(Options{BinPath: scriptPath, RunDir: filepath.Join(dir, "run"), StateDir: stateDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "state dir",
		Steps: []Step{
			{Name: "print", Cmd: []string{}, Expect: Expectation{StdoutContains: stateDir}},
		},
	}
	if err := r.RunCase(c); err != nil {
		t.Fatalf("RunCase: %v", err)
	}
}

// -----------------------------------------------------------------------
// schema.go
// -----------------------------------------------------------------------

const tinyOpenAPIDoc = `{
  "openapi": "3.1.0",
  "info": {"title": "tiny", "version": "0"},
  "paths": {},
  "components": {
    "schemas": {
      "Thing": {
        "type": "object",
        "required": ["ok"],
        "properties": {
          "ok": {"type": "boolean"},
          "name": {"type": "string"}
        }
      }
    }
  }
}`

func TestSchemaValidatorInlineSchema(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "openapi.json")
	writeFile(t, path, tinyOpenAPIDoc)

	v := LoadOpenAPISchema(path)

	if err := v.Validate("Thing", map[string]any{"ok": true, "name": "widget"}); err != nil {
		t.Fatalf("expected valid instance to pass: %v", err)
	}
	if err := v.Validate("Thing", map[string]any{"ok": "not-a-bool"}); err == nil {
		t.Fatalf("expected invalid instance to fail")
	}
	if err := v.Validate("Thing", map[string]any{"name": "missing-required-ok"}); err == nil {
		t.Fatalf("expected missing required field to fail")
	}
	if err := v.Validate("Nope", map[string]any{}); err == nil {
		t.Fatalf("expected unknown schema name to error")
	}
}

func TestSchemaValidatorHonorsNullable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "openapi.json")
	// A 3.1 document that expresses nullability the OpenAPI-3.0 way, as the
	// real Amika spec does: `{type: string, nullable: true}`.
	writeFile(t, path, `{
	  "openapi": "3.1.0",
	  "info": {"title": "nullable", "version": "0"},
	  "paths": {},
	  "components": {
	    "schemas": {
	      "Thing": {
	        "type": "object",
	        "required": ["id", "branch"],
	        "properties": {
	          "id": {"type": "string"},
	          "branch": {"type": "string", "nullable": true}
	        }
	      }
	    }
	  }
	}`)

	v := LoadOpenAPISchema(path)

	// A required-but-nullable field present as null must validate.
	if err := v.Validate("Thing", map[string]any{"id": "x", "branch": nil}); err != nil {
		t.Fatalf("expected null branch to validate under nullable: %v", err)
	}
	// A concrete string still validates.
	if err := v.Validate("Thing", map[string]any{"id": "x", "branch": "main"}); err != nil {
		t.Fatalf("expected string branch to validate: %v", err)
	}
	// The wrong type is still rejected — nullable widens to null, not to anything.
	if err := v.Validate("Thing", map[string]any{"id": "x", "branch": 7}); err == nil {
		t.Fatalf("expected a number branch to fail validation")
	}
}

func TestSchemaValidatorMissingDocument(t *testing.T) {
	v := LoadOpenAPISchema(filepath.Join(t.TempDir(), "does-not-exist.json"))
	err := v.Validate("Thing", map[string]any{})
	if err == nil {
		t.Fatalf("expected error for missing document")
	}
	if !strings.Contains(err.Error(), "openapi document unavailable") {
		t.Fatalf("expected clear unavailable-document error, got: %v", err)
	}
}

func TestSchemaValidatorRealOpenAPIDocument(t *testing.T) {
	path := filepath.Join("..", "testdata", "openapi.json")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("testdata openapi.json not present: %v", err)
	}
	v := LoadOpenAPISchema(path)
	if err := v.Validate("OkStatus", map[string]any{"ok": true}); err != nil {
		t.Fatalf("expected OkStatus to validate against the real doc: %v", err)
	}
}

// -----------------------------------------------------------------------
// test helpers
// -----------------------------------------------------------------------

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
