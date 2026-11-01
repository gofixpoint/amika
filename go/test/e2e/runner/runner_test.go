package runner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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

func TestMatchOptionalUnknownMatcherFails(t *testing.T) {
	// "@strng?" is a typo, not a real optional matcher: it must fail whether
	// the key is absent or present, never silently pass by treating the key
	// as optional.
	expected := map[string]any{"name": "@strng?"}
	if err := Match(expected, map[string]any{}); err == nil {
		t.Fatal("expected an unknown optional matcher to fail on an absent key")
	}
	if err := Match(expected, map[string]any{"name": "x"}); err == nil {
		t.Fatal("expected an unknown optional matcher to fail on a present key")
	}
	// A present null value must not slip past via the optional/nil path.
	if err := Match(expected, map[string]any{"name": nil}); err == nil {
		t.Fatal("expected an unknown optional matcher to fail on a present null value")
	}
	// A real optional matcher still permits the key to be absent.
	if err := Match(map[string]any{"name": "@string?"}, map[string]any{}); err != nil {
		t.Fatalf("expected a known optional matcher to allow absence: %v", err)
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

func TestMatchArrayExactLength(t *testing.T) {
	// Array matching requires an exact element count by default.
	if err := Match([]any{"a", "b"}, []any{"a", "b"}); err != nil {
		t.Fatalf("exact-length array should match: %v", err)
	}
	if err := Match([]any{"a"}, []any{"a", "b"}); err == nil {
		t.Fatalf("expected exact-length mismatch on an extra trailing element")
	}
}

func TestMatchArrayPrefixWithRest(t *testing.T) {
	// A trailing "@..." matches the leading elements positionally and ignores
	// any further items (checking the first m of n).
	expected := []any{
		map[string]any{"name": "first"},
		"@...",
	}
	actual := []any{
		map[string]any{"name": "first", "extra": true},
		map[string]any{"name": "second"},
	}
	if err := Match(expected, actual); err != nil {
		t.Fatalf("expected prefix match with @... to ignore trailing items: %v", err)
	}
	// "@..." also permits exactly the prefix and nothing more.
	if err := Match([]any{"a", "@..."}, []any{"a"}); err != nil {
		t.Fatalf("expected prefix match to allow no trailing items: %v", err)
	}
	// But the prefix itself must still be present.
	if err := Match([]any{"a", "b", "@..."}, []any{"a"}); err == nil {
		t.Fatalf("expected error when the matched prefix is longer than actual")
	}
	// "@..." anywhere but the last position is a clear error.
	err := Match([]any{"@...", "a"}, []any{"x", "a"})
	if err == nil {
		t.Fatal("expected a non-final @... to be rejected")
	}
	if !strings.Contains(err.Error(), "only valid as the last array element") {
		t.Fatalf("expected a clear non-final @... message, got: %v", err)
	}
}

func TestMatchArrayAnyPlaceholder(t *testing.T) {
	// "@any" asserts a position is present without checking its value.
	expected := []any{"2", "3", "@any", "5"}
	if err := Match(expected, []any{"2", "3", "anything", "5"}); err != nil {
		t.Fatalf("@any placeholder should match any element value: %v", err)
	}
	// A null in the placeholder position is still accepted.
	if err := Match(expected, []any{"2", "3", nil, "5"}); err != nil {
		t.Fatalf("@any should accept a null element: %v", err)
	}
	// Positions around the placeholder are still checked.
	if err := Match(expected, []any{"2", "3", "x", "9"}); err == nil {
		t.Fatalf("expected mismatch when a non-placeholder element differs")
	}
	// @any still requires the element to be present (exact length).
	if err := Match(expected, []any{"2", "3", "x"}); err == nil {
		t.Fatalf("expected length mismatch when the placeholder element is absent")
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

func TestMatchLiteralAtEscape(t *testing.T) {
	// "@@foo" asserts the literal string "@foo", the escape for a value that
	// really starts with "@".
	if err := Match("@@foo", "@foo"); err != nil {
		t.Fatalf("expected @@foo to match literal @foo: %v", err)
	}
	if err := Match("@@foo", "foo"); err == nil {
		t.Fatal("expected @@foo not to match foo")
	}
	// Works nested in object values and array elements.
	if err := Match(map[string]any{"k": "@@everyone"}, map[string]any{"k": "@everyone"}); err != nil {
		t.Fatalf("expected escaped literal object value to match: %v", err)
	}
	if err := Match([]any{"@@x"}, []any{"@x"}); err != nil {
		t.Fatalf("expected escaped literal array element to match: %v", err)
	}
}

func TestMatchRegexInvalidPattern(t *testing.T) {
	// A malformed @regex pattern is a clear error, not a silent pass.
	if err := Match("@regex: (", "anything"); err == nil {
		t.Fatal("expected an invalid @regex pattern to error")
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

// TestSubstituteStepResolvesNestedStdoutJSONVar covers substituteAny recursing
// into a nested stdout_json map/list to resolve a "{{var}}" template, so a
// case can template values inside a structural JSON assertion.
func TestSubstituteStepResolvesNestedStdoutJSONVar(t *testing.T) {
	r, err := New(Options{BinPath: "unused", RunDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	r.vars["name"] = "sb-1"

	step := Step{
		Name: "nested template",
		Cmd:  []string{"version"},
		Expect: Expectation{
			StdoutJSON: map[string]any{
				"outer": map[string]any{"inner": "{{name}}"},
				"list":  []any{"{{name}}", "literal"},
			},
		},
	}
	out, err := r.substituteStep(step)
	if err != nil {
		t.Fatalf("substituteStep: %v", err)
	}
	got, ok := out.Expect.StdoutJSON.(map[string]any)
	if !ok {
		t.Fatalf("expected StdoutJSON to remain a map, got %T", out.Expect.StdoutJSON)
	}
	if inner := got["outer"].(map[string]any)["inner"]; inner != "sb-1" {
		t.Fatalf("expected nested map var resolved to sb-1, got %v", inner)
	}
	if first := got["list"].([]any)[0]; first != "sb-1" {
		t.Fatalf("expected nested list var resolved to sb-1, got %v", first)
	}
}

func TestSubstituteStepResolvesNegativeContentVars(t *testing.T) {
	r, err := New(Options{BinPath: "unused", RunDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	r.vars["name"] = "sb-1"

	step := Step{
		Name: "negative templates",
		Cmd:  []string{"version"},
		Expect: Expectation{
			StdoutNotContains: "{{name}}",
			StderrNotContains: "error for {{name}}",
		},
	}
	out, err := r.substituteStep(step)
	if err != nil {
		t.Fatalf("substituteStep: %v", err)
	}
	if out.Expect.StdoutNotContains != "sb-1" {
		t.Fatalf("stdout_not_contains = %q, want sb-1", out.Expect.StdoutNotContains)
	}
	if out.Expect.StderrNotContains != "error for sb-1" {
		t.Fatalf("stderr_not_contains = %q, want error for sb-1", out.Expect.StderrNotContains)
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

	e1 := Entry{Type: "sandbox", Name: "sb-1", CreatedByStep: "create", CleanupArgv: []string{"rig", "delete", "sb-1"}}
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

func TestLedgerReleaseKeepsHistoryOnDisk(t *testing.T) {
	dir := t.TempDir()
	ledgerPath := filepath.Join(dir, "ledger.json")
	l, err := NewLedger(ledgerPath)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	for _, entry := range []Entry{
		{Type: "sandbox", Name: "sb-1"},
		{Type: "snapshot", Name: "snap-1"},
	} {
		if err := l.Append(entry); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	released, err := l.Release("sandbox", "sb-1", Release{ByStep: "consume", Verified: VerifiedGone})
	if err != nil || !released {
		t.Fatalf("Release = %v, %v; want true, nil", released, err)
	}
	if released, err := l.Release("sandbox", "sb-1", Release{}); err != nil || released {
		t.Fatalf("releasing an already released entry = %v, %v; want false, nil", released, err)
	}
	if released, err := l.Release("sandbox", "missing", Release{}); err != nil || released {
		t.Fatalf("release missing resource = %v, %v; want false, nil", released, err)
	}

	if pending := l.Entries(); len(pending) != 1 || pending[0].Name != "snap-1" {
		t.Fatalf("expected only snap-1 pending, got %+v", pending)
	}
	if rel := l.Released(); len(rel) != 1 || rel[0].Name != "sb-1" || rel[0].Released.ByStep != "consume" {
		t.Fatalf("expected sb-1 released by consume, got %+v", rel)
	}
	onDisk, err := LoadLedgerEntries(ledgerPath)
	if err != nil {
		t.Fatalf("LoadLedgerEntries: %v", err)
	}
	if len(onDisk) != 2 || onDisk[0].Released == nil || onDisk[1].Released != nil {
		t.Fatalf("expected both entries on disk, sb-1 marked released: %+v", onDisk)
	}
	if pending := PendingEntries(onDisk); len(pending) != 1 || pending[0].Name != "snap-1" {
		t.Fatalf("expected the sweep to see only snap-1, got %+v", pending)
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

	results := Cleanup(bin, entries, nil)
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

// TestCleanupVerifiesDeletion covers both check forms and every outcome. A
// resource is "gone" only on a positive answer: a lookup that fails with the
// not-found text, or a listing whose values do not include the name. Any
// other failure is "unchecked", never "gone".
func TestCleanupVerifiesDeletion(t *testing.T) {
	bin := stubScript(t)
	fast := VerifyPolicy{Timeout: 10 * time.Millisecond, Interval: time.Millisecond}
	deleteOK := []string{"0", "", ""}

	lookup := func(exit, stderr string) *VerifyGone {
		return &VerifyGone{Cmd: []string{exit, "", stderr}, NotFound: "HTTP 404"}
	}
	listing := func(exit, stdout, stderr string) *VerifyGone {
		return &VerifyGone{Cmd: []string{exit, stdout, stderr}, AbsentFrom: "$.items[*].name"}
	}

	entries := []Entry{
		{Type: "sandbox", Name: "looked-up-gone", CleanupArgv: deleteOK, VerifyGone: lookup("1", "remote get sandbox: HTTP 404: not found")},
		{Type: "sandbox", Name: "looked-up-present", CleanupArgv: deleteOK, VerifyGone: lookup("0", "")},
		{Type: "sandbox", Name: "looked-up-outage", CleanupArgv: deleteOK, VerifyGone: lookup("1", "HTTP 401: bad key")},
		{Type: "snapshot", Name: "listed-gone", CleanupArgv: deleteOK, VerifyGone: listing("0", `{"items":[{"name":"other"},{"name":"listed-gone-2"}]}`, "")},
		{Type: "snapshot", Name: "listed-present", CleanupArgv: deleteOK, VerifyGone: listing("0", `{"items":[{"name":"listed-present"}]}`, "")},
		{Type: "snapshot", Name: "listing-broke", CleanupArgv: deleteOK, VerifyGone: listing("1", "", "list broke")},
		{Type: "snapshot", Name: "listing-not-json", CleanupArgv: deleteOK, VerifyGone: listing("0", "No snapshots found.", "")},
		{Type: "sandbox", Name: "blind", CleanupArgv: deleteOK},
		{Type: "sandbox", Name: "undeletable", CleanupArgv: []string{"1", "", "boom"}, VerifyGone: lookup("0", "")},
	}
	byName := map[string]CleanupResult{}
	for _, res := range CleanupVerified(bin, entries, nil, fast) {
		byName[res.Entry.Name] = res
	}

	want := map[string]struct {
		verified string
		failed   bool
	}{
		"looked-up-gone":    {VerifiedGone, false},
		"looked-up-present": {VerifiedStillPresent, true},
		"looked-up-outage":  {VerifiedUnchecked, true},
		"listed-gone":       {VerifiedGone, false},
		"listed-present":    {VerifiedStillPresent, true},
		"listing-broke":     {VerifiedUnchecked, true},
		"listing-not-json":  {VerifiedUnchecked, true},
		"blind":             {VerifiedUnsupported, false},
		"undeletable":       {VerifiedUnchecked, true},
	}
	for name, w := range want {
		res := byName[name]
		if res.Verified != w.verified || (res.Err != nil) != w.failed {
			t.Errorf("%s: verified=%q err=%v, want verified=%q failed=%v", name, res.Verified, res.Err, w.verified, w.failed)
		}
	}
	if err := byName["looked-up-outage"].Err; err == nil || !strings.Contains(err.Error(), "HTTP 401") {
		t.Errorf("an outage must be reported with the lookup's stderr, got %v", err)
	}
}

// TestCleanupAcceptsAFailedDeleteOfAnAlreadyGoneResource covers a case that
// deletes a resource itself and leaves it registered: cleanup's second delete
// gets a 404, and that must count as deleted when the resource is verified
// gone, but not when it is still there or the check cannot answer.
func TestCleanupAcceptsAFailedDeleteOfAnAlreadyGoneResource(t *testing.T) {
	bin := stubScript(t)
	fast := VerifyPolicy{Timeout: 10 * time.Millisecond, Interval: time.Millisecond}
	deleteFails := []string{"1", "", "remote delete sandbox: HTTP 404: not found"}
	lookup := func(exit, stderr string) *VerifyGone {
		return &VerifyGone{Cmd: []string{exit, "", stderr}, NotFound: "HTTP 404"}
	}
	entries := []Entry{
		{Type: "sandbox", Name: "already-gone", CleanupArgv: deleteFails, VerifyGone: lookup("1", "HTTP 404")},
		{Type: "sandbox", Name: "still-there", CleanupArgv: deleteFails, VerifyGone: lookup("0", "")},
		{Type: "sandbox", Name: "unknown", CleanupArgv: deleteFails, VerifyGone: lookup("1", "HTTP 502")},
		{Type: "sandbox", Name: "no-check", CleanupArgv: deleteFails},
	}
	byName := map[string]CleanupResult{}
	for _, res := range CleanupVerified(bin, entries, nil, fast) {
		byName[res.Entry.Name] = res
	}

	if res := byName["already-gone"]; res.Err != nil || res.Verified != VerifiedGone || !strings.Contains(res.DeleteError, "HTTP 404") {
		t.Errorf("already-gone: want verified gone with the delete error kept, got %+v", res)
	}
	for _, name := range []string{"still-there", "unknown", "no-check"} {
		if res := byName[name]; res.Err == nil || res.Verified != VerifiedUnchecked {
			t.Errorf("%s: want the failed delete kept as unchecked, got verified=%q err=%v", name, res.Verified, res.Err)
		}
	}

	rows := AuditRows("api-x", CleanupVerified(bin, entries[:1], nil, fast), nil)
	if rows[0].Outcome != OutcomeDeleted || !strings.Contains(rows[0].Detail, "already gone") {
		t.Errorf("audit row: want deleted with an already-gone note, got %+v", rows[0])
	}
}

func TestCollectJSONPath(t *testing.T) {
	var doc any
	if err := json.Unmarshal([]byte(`{"items":[{"name":"a"},{"name":"b"}]}`), &doc); err != nil {
		t.Fatal(err)
	}
	got, err := CollectJSONPath("$.items[*].name", doc)
	if err != nil {
		t.Fatalf("CollectJSONPath: %v", err)
	}
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("expected [a b], got %v", got)
	}

	var arr any
	if err := json.Unmarshal([]byte(`[{"id":"k1"},{"id":"k2"}]`), &arr); err != nil {
		t.Fatal(err)
	}
	got, err = CollectJSONPath("$[*].id", arr)
	if err != nil || len(got) != 2 || got[1] != "k2" {
		t.Fatalf("expected [k1 k2] from a root array, got %v, %v", got, err)
	}

	var empty any
	if err := json.Unmarshal([]byte(`{"items":[]}`), &empty); err != nil {
		t.Fatal(err)
	}
	if got, err := CollectJSONPath("$.items[*].name", empty); err != nil || len(got) != 0 {
		t.Fatalf("an empty listing is an empty collection, got %v, %v", got, err)
	}

	if _, err := CollectJSONPath("$.items.name", doc); err == nil {
		t.Fatal("expected an error for a path without a wildcard")
	}
	if _, err := CollectJSONPath("$.items[*].name[*]", doc); err == nil {
		t.Fatal("expected an error for two wildcards")
	}
	if _, err := CollectJSONPath("$.missing[*].name", doc); err == nil {
		t.Fatal("expected an error when the container is missing")
	}
}

// TestCollectJSONPathRejectsElementWithoutField covers the false "gone": a
// misspelled field, or a listing whose shape changed, must not collect to an
// empty set that reads as "the resource is absent".
func TestCollectJSONPathRejectsElementWithoutField(t *testing.T) {
	var doc any
	if err := json.Unmarshal([]byte(`[{"name":"still-live"}]`), &doc); err != nil {
		t.Fatal(err)
	}
	if got, err := CollectJSONPath("$[*].id", doc); err == nil {
		t.Fatalf("expected an error for an element with no id, got %v", got)
	}

	bin := stubScript(t)
	fast := VerifyPolicy{Timeout: 10 * time.Millisecond, Interval: time.Millisecond}
	entry := Entry{
		Type:        "ssh-key",
		Name:        "still-live",
		CleanupArgv: []string{"0", "", ""},
		VerifyGone:  &VerifyGone{Cmd: []string{"0", `[{"name":"still-live"}]`, ""}, AbsentFrom: "$[*].id"},
	}
	res := CleanupVerified(bin, []Entry{entry}, nil, fast)[0]
	if res.Verified != VerifiedUnchecked || res.Err == nil {
		t.Fatalf("expected unchecked with an error, got verified=%q err=%v", res.Verified, res.Err)
	}
}

// TestLoadCaseChecksResourceTemplateNames catches a typo in a resource block
// before anything runs, while allowing every name a block can really see.
func TestLoadCaseChecksResourceTemplateNames(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.yaml")
	writeFile(t, good, `name: good
vars:
  size: m
steps:
  - name: make a key
    cmd: [x]
    capture:
      key_id: $.id
  - name: make a rig
    cmd: [x]
    capture:
      sandbox_name: $.name
    resource:
      type: sandbox
      name: "{{sandbox_name}}"
      cleanup: [rig, delete, "{{sandbox_name}}", "{{key_id}}", "{{size}}", "{{run_id}}", "{{sandbox_provider}}"]
      verify_gone:
        cmd: [rig, get, "{{sandbox_name}}"]
        not_found: "HTTP 404"
`)
	if _, err := LoadCase(good); err != nil {
		t.Fatalf("expected the case to load, got %v", err)
	}

	for field, block := range map[string]string{
		"verify":  "      cleanup: [rig, delete, sb-1]\n      verify_gone:\n        cmd: [rig, get, \"{{missing}}\"]\n        not_found: \"HTTP 404\"\n",
		"cleanup": "      cleanup: [rig, delete, \"{{missing}}\"]\n",
		"later":   "      cleanup: [rig, delete, \"{{later_capture}}\"]\n",
	} {
		path := filepath.Join(dir, field+".yaml")
		writeFile(t, path, `name: `+field+`
steps:
  - name: create
    cmd: [x]
    resource:
      type: sandbox
      name: sb-1
`+block+`  - name: afterwards
    cmd: [x]
    capture:
      later_capture: $.id
`)
		_, err := LoadCase(path)
		if err == nil || !strings.Contains(err.Error(), "which no earlier capture") {
			t.Errorf("%s: expected an undefined-template error, got %v", field, err)
		}
	}
}

// TestRegisterKeepsResourceWhenVerifyTemplateFails covers a verify_gone that
// cannot be templated at run time: the resource must still be registered, so
// it is deleted, and its cleanup must count as unverified-and-failed.
func TestRegisterKeepsResourceWhenVerifyTemplateFails(t *testing.T) {
	bin := stubScript(t)
	r, err := New(Options{BinPath: bin, RunDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	c := &Case{
		Name: "verify template typo",
		Steps: []Step{{
			Name:    "create",
			Cmd:     []string{"0", `{"name":"sb-1"}`, ""},
			Expect:  Expectation{Exit: intPtr(0)},
			Capture: map[string]string{"sandbox_name": "$.name"},
			Resource: &Resource{
				Type:       "sandbox",
				Name:       "{{sandbox_name}}",
				Cleanup:    []string{"0", "", ""},
				VerifyGone: &VerifyGone{Cmd: []string{"1", "", "{{missing}}"}, NotFound: "HTTP 404"},
			},
		}},
	}
	if err := r.RunCase(context.Background(), c); err == nil || !strings.Contains(err.Error(), "registered without its verify_gone check") {
		t.Fatalf("expected the step to fail after registering, got %v", err)
	}
	entries := r.Ledger().Entries()
	if len(entries) != 1 || entries[0].Name != "sb-1" || entries[0].VerifyGoneError == "" {
		t.Fatalf("expected sb-1 registered with its verify error, got %+v", entries)
	}
	res := Cleanup(bin, entries, nil)[0]
	if res.Err == nil || res.Verified != VerifiedUnchecked {
		t.Fatalf("expected the cleanup to count as a failure, got %+v", res)
	}
	if rows := AuditRows("c", []CleanupResult{res}, nil); rows[0].Outcome != OutcomeLeaked {
		t.Fatalf("expected the audit to flag it, got %+v", rows[0])
	}
}

func TestLoadCaseRejectsMalformedVerifyGone(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"no-cmd": `
      verify_gone:
        not_found: "HTTP 404"`,
		"neither": `
      verify_gone:
        cmd: [rig, get, sb-1]`,
		"both": `
      verify_gone:
        cmd: [rig, get, sb-1]
        not_found: "HTTP 404"
        absent_from: "$[*].name"`,
		"no-wildcard": `
      verify_gone:
        cmd: [rig, list, -o, json]
        absent_from: "$.name"`,
	}
	for name, block := range cases {
		path := filepath.Join(dir, name+".yaml")
		writeFile(t, path, `name: `+name+`
steps:
  - name: create
    cmd: [rig, create]
    resource:
      type: sandbox
      name: sb-1
      cleanup: [rig, delete, sb-1]`+block+"\n")
		if _, err := LoadCase(path); err == nil {
			t.Errorf("%s: expected LoadCase to reject the verify_gone block", name)
		}
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

	results, err := CleanupFromLedgerFile(bin, ledgerPath, nil)
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

	if err := r.RunCase(context.Background(), c); err != nil {
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

func TestRunnerReleasesResourceOnlyAfterAssertionsPass(t *testing.T) {
	bin := stubScript(t)

	t.Run("successful assertion releases resource", func(t *testing.T) {
		r, err := New(Options{BinPath: bin, RunDir: t.TempDir()})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		c := &Case{
			Name: "release consumed resource",
			Steps: []Step{
				{
					Name:    "create",
					Cmd:     []string{"0", `{"name":"sb-1"}`, ""},
					Capture: map[string]string{"sandbox_name": "$.name"},
					Resource: &Resource{
						Type:    "sandbox",
						Name:    "{{sandbox_name}}",
						Cleanup: []string{"0", "", ""},
					},
				},
				{
					Name:   "confirm deletion",
					Cmd:    []string{"0", "[]", ""},
					Expect: Expectation{StdoutNotContains: "{{sandbox_name}}"},
					ReleaseResource: &ResourceRef{
						Type: "sandbox",
						Name: "{{sandbox_name}}",
					},
				},
			},
		}
		if err := r.RunCase(context.Background(), c); err != nil {
			t.Fatalf("RunCase: %v", err)
		}
		if entries := r.Ledger().Entries(); len(entries) != 0 {
			t.Fatalf("expected released resource to leave cleanup, got %+v", entries)
		}
		rel := r.Ledger().Released()
		if len(rel) != 1 || rel[0].Released.ByStep != "confirm deletion" || rel[0].Released.Verified != VerifiedUnsupported {
			t.Fatalf("expected the release kept as history, got %+v", rel)
		}
	})

	t.Run("failed assertion retains resource", func(t *testing.T) {
		r, err := New(Options{BinPath: bin, RunDir: t.TempDir()})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		c := &Case{
			Name: "retain resource on failure",
			Steps: []Step{
				{
					Name: "create",
					Cmd:  []string{"0", "", ""},
					Resource: &Resource{
						Type:    "sandbox",
						Name:    "sb-1",
						Cleanup: []string{"0", "", ""},
					},
				},
				{
					Name:   "failed deletion check",
					Cmd:    []string{"0", "sb-1", ""},
					Expect: Expectation{StdoutNotContains: "sb-1"},
					ReleaseResource: &ResourceRef{
						Type: "sandbox",
						Name: "sb-1",
					},
				},
			},
		}
		if err := r.RunCase(context.Background(), c); err == nil {
			t.Fatal("expected deletion assertion to fail")
		}
		if entries := r.Ledger().Entries(); len(entries) != 1 || entries[0].Name != "sb-1" {
			t.Fatalf("expected failed assertion to retain cleanup resource, got %+v", entries)
		}
	})
}

// TestReleaseVerifiesBeforeHandingBackFromCleanup covers a release whose
// resource has a verify_gone check: it is released only when the check says
// gone, and otherwise stays with cleanup and fails the step.
func TestReleaseVerifiesBeforeHandingBackFromCleanup(t *testing.T) {
	bin := stubScript(t)
	fast := VerifyPolicy{Timeout: 10 * time.Millisecond, Interval: time.Millisecond}
	run := func(lookupExit, lookupStderr string) (*Runner, error) {
		r, err := New(Options{BinPath: bin, RunDir: t.TempDir(), VerifyPolicy: fast})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		c := &Case{
			Name: "release with verify",
			Steps: []Step{
				{
					Name: "create",
					Cmd:  []string{"0", "", ""},
					Resource: &Resource{
						Type:       "sandbox",
						Name:       "sb-1",
						Cleanup:    []string{"0", "", ""},
						VerifyGone: &VerifyGone{Cmd: []string{lookupExit, "", lookupStderr}, NotFound: "HTTP 404"},
					},
				},
				{
					Name:            "consume",
					Cmd:             []string{"0", "", ""},
					ReleaseResource: &ResourceRef{Type: "sandbox", Name: "sb-1"},
				},
			},
		}
		return r, r.RunCase(context.Background(), c)
	}

	r, err := run("1", "HTTP 404")
	if err != nil {
		t.Fatalf("expected a verified release, got %v", err)
	}
	if rel := r.Ledger().Released(); len(rel) != 1 || rel[0].Released.Verified != VerifiedGone {
		t.Fatalf("expected sb-1 released as verified gone, got %+v", rel)
	}

	r, err = run("0", "")
	if err == nil || !strings.Contains(err.Error(), "kept for cleanup") {
		t.Fatalf("expected the release to fail while sb-1 still exists, got %v", err)
	}
	if pending := r.Ledger().Entries(); len(pending) != 1 {
		t.Fatalf("expected sb-1 kept for cleanup, got %+v", pending)
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
					VerifyGone: &VerifyGone{
						Cmd:      []string{"1", "", "lookup of {{sandbox_name}}: HTTP 404"},
						NotFound: "HTTP 404",
					},
				},
			},
		},
	}

	if err := r.RunCase(context.Background(), c); err != nil {
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
	if v := entries[0].VerifyGone; v == nil || len(v.Cmd) != 3 || v.Cmd[2] != "lookup of sb-xyz: HTTP 404" || v.NotFound != "HTTP 404" {
		t.Fatalf("expected verify_gone cmd templated with the same-step capture, got %#v", entries[0].VerifyGone)
	}
}

// TestRunnerRegistersResourceEvenWhenAssertionFails covers the leak the
// reviewer flagged: a create command that exits successfully but then trips a
// content assertion (stdout_contains here) must still register its resource
// for cleanup, since the resource was really created.
func TestRunnerRegistersResourceEvenWhenAssertionFails(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "assertion fails after a successful create",
		Steps: []Step{
			{
				Name: "create then fail a content assertion",
				Cmd:  []string{"0", `{"name":"sb-leak"}`, ""},
				Expect: Expectation{
					Exit:           intPtr(0),
					StdoutContains: "this-substring-is-not-present",
				},
				Capture: map[string]string{"sandbox_name": "$.name"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "{{sandbox_name}}",
					Cleanup: []string{"0", "", ""},
				},
			},
		},
	}

	if err := r.RunCase(context.Background(), c); err == nil {
		t.Fatal("expected the stdout_contains assertion to fail the case")
	}
	entries := r.Ledger().Entries()
	if len(entries) != 1 || entries[0].Name != "sb-leak" {
		t.Fatalf("expected resource sb-leak registered despite the assertion failure, got %+v", entries)
	}
}

// TestRunnerRegistersResourceWhenCaptureFails covers the follow-on leak: a
// create that exits 0 but whose same-step capture path does not match still
// registers a resource whose name/cleanup do not depend on that capture, so
// it is not orphaned when the capture error fails the case.
func TestRunnerRegistersResourceWhenCaptureFails(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "capture fails but a static resource still registers",
		Steps: []Step{
			{
				Name:    "create with a broken capture path",
				Cmd:     []string{"0", `{"name":"sb-static"}`, ""},
				Expect:  Expectation{Exit: intPtr(0)},
				Capture: map[string]string{"missing": "$.does_not_exist"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "sb-static",
					Cleanup: []string{"0", "", ""},
				},
			},
		},
	}

	if err := r.RunCase(context.Background(), c); err == nil {
		t.Fatal("expected the failed capture to fail the case")
	}
	entries := r.Ledger().Entries()
	if len(entries) != 1 || entries[0].Name != "sb-static" {
		t.Fatalf("expected static resource registered despite capture failure, got %+v", entries)
	}
}

// TestRunnerRegistersResourceFromValidSiblingCapture covers the randomized-map
// leak: when a step has one valid and one invalid capture, the valid one is
// still saved (regardless of iteration order), so a resource templated from it
// registers for cleanup even though the case fails on the bad capture.
func TestRunnerRegistersResourceFromValidSiblingCapture(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "one capture fails, resource uses the valid sibling",
		Steps: []Step{
			{
				Name:   "create with one good and one bad capture",
				Cmd:    []string{"0", `{"name":"sb-good"}`, ""},
				Expect: Expectation{Exit: intPtr(0)},
				Capture: map[string]string{
					"good": "$.name",
					"bad":  "$.does_not_exist",
				},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "{{good}}",
					Cleanup: []string{"0", "", ""},
				},
			},
		},
	}

	if err := r.RunCase(context.Background(), c); err == nil {
		t.Fatal("expected the bad capture to fail the case")
	}
	entries := r.Ledger().Entries()
	if len(entries) != 1 || entries[0].Name != "sb-good" {
		t.Fatalf("expected resource templated from the valid sibling capture, got %+v", entries)
	}
}

// TestRunnerResourceEnvPersistsStateDir covers the standalone-reaper leak: a
// resource entry must record the run's injected AMIKA_STATE_DIRECTORY (plus any
// step overrides) so CleanupFromLedgerFile with a nil base env still deletes it
// from the run's isolated state, not the invoking user's default state.
func TestRunnerResourceEnvPersistsStateDir(t *testing.T) {
	bin := stubScript(t)
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")

	r, err := New(Options{BinPath: bin, RunDir: filepath.Join(dir, "run"), StateDir: stateDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "resource records the injected state dir",
		Steps: []Step{
			{
				Name:   "create",
				Cmd:    []string{"0", `{"name":"sb-1"}`, ""},
				Expect: Expectation{Exit: intPtr(0)},
				Env:    map[string]string{"AMIKA_API_URL": "https://example.test"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "sb-1",
					Cleanup: []string{"0", "", ""},
				},
			},
		},
	}
	if err := r.RunCase(context.Background(), c); err != nil {
		t.Fatalf("RunCase: %v", err)
	}

	entries := r.Ledger().Entries()
	if len(entries) != 1 {
		t.Fatalf("expected one entry, got %+v", entries)
	}
	if got := entries[0].Env["AMIKA_STATE_DIRECTORY"]; got != stateDir {
		t.Fatalf("expected entry to record AMIKA_STATE_DIRECTORY=%q, got %q", stateDir, got)
	}
	if got := entries[0].Env["AMIKA_API_URL"]; got != "https://example.test" {
		t.Fatalf("expected step env override preserved, got %q", got)
	}
}

// TestRunnerResourceEnvHonorsStepStateOverride covers a step that overrides
// AMIKA_STATE_DIRECTORY itself: the entry must record the step's value, not the
// run default, so cleanup targets the same state creation used.
func TestRunnerResourceEnvHonorsStepStateOverride(t *testing.T) {
	bin := stubScript(t)
	dir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: filepath.Join(dir, "run"), StateDir: filepath.Join(dir, "run-default")})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "step overrides the state dir",
		Steps: []Step{
			{
				Name:   "create",
				Cmd:    []string{"0", `{"name":"sb-1"}`, ""},
				Expect: Expectation{Exit: intPtr(0)},
				Env:    map[string]string{"AMIKA_STATE_DIRECTORY": "/tmp/step-state"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "sb-1",
					Cleanup: []string{"0", "", ""},
				},
			},
		},
	}
	if err := r.RunCase(context.Background(), c); err != nil {
		t.Fatalf("RunCase: %v", err)
	}

	entries := r.Ledger().Entries()
	if len(entries) != 1 {
		t.Fatalf("expected one entry, got %+v", entries)
	}
	if got := entries[0].Env["AMIKA_STATE_DIRECTORY"]; got != "/tmp/step-state" {
		t.Fatalf("expected the step's state-dir override recorded, got %q", got)
	}
}

// TestRunnerResourceEnvPersistsBaseAPIURL covers the crash-cleanup gap: a
// target-setting override that lives only in the run's base Options.Env (here
// AMIKA_API_URL) must be recorded on the ledger entry so a standalone reaper
// deletes against the right API. Non-target base vars (PATH) are not persisted.
func TestRunnerResourceEnvPersistsBaseAPIURL(t *testing.T) {
	bin := stubScript(t)
	dir := t.TempDir()
	stateDir := filepath.Join(dir, "state")

	r, err := New(Options{
		BinPath:  bin,
		RunDir:   filepath.Join(dir, "run"),
		StateDir: stateDir,
		Env:      []string{"AMIKA_API_URL=https://api.example.test", "PATH=/usr/bin"},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "base env api url persisted",
		Steps: []Step{
			{
				Name:     "create",
				Cmd:      []string{"0", "", ""},
				Resource: &Resource{Type: "sandbox", Name: "sb-1", Cleanup: []string{"0", "", ""}},
			},
		},
	}
	if err := r.RunCase(context.Background(), c); err != nil {
		t.Fatalf("RunCase: %v", err)
	}

	entries := r.Ledger().Entries()
	if len(entries) != 1 {
		t.Fatalf("expected one entry, got %+v", entries)
	}
	if got := entries[0].Env["AMIKA_API_URL"]; got != "https://api.example.test" {
		t.Fatalf("expected base AMIKA_API_URL persisted, got %q", got)
	}
	if got := entries[0].Env["AMIKA_STATE_DIRECTORY"]; got != stateDir {
		t.Fatalf("expected state dir persisted, got %q", got)
	}
	if _, ok := entries[0].Env["PATH"]; ok {
		t.Fatalf("did not expect a non-target base var (PATH) persisted: %+v", entries[0].Env)
	}
}

// TestRunnerRegistersResourceOnUnexpectedExitWithOptIn covers the
// partial-success case: a create command that creates the resource but then
// exits with an unexpected status registers for cleanup ONLY when the case
// opts in via resource.register_on_failure.
func TestRunnerRegistersResourceOnUnexpectedExitWithOptIn(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "create succeeds then command exits nonzero",
		Steps: []Step{
			{
				Name:   "create then exit nonzero",
				Cmd:    []string{"1", `{"name":"sb-leak"}`, "boom"}, // exits 1, but the step expects 0
				Expect: Expectation{Exit: intPtr(0)},
				Resource: &Resource{
					Type:              "sandbox",
					Name:              "sb-leak",
					Cleanup:           []string{"0", "", ""},
					RegisterOnFailure: true,
				},
			},
		},
	}

	if err := r.RunCase(context.Background(), c); err == nil {
		t.Fatal("expected the unexpected exit code to fail the case")
	}
	entries := r.Ledger().Entries()
	if len(entries) != 1 || entries[0].Name != "sb-leak" {
		t.Fatalf("expected opt-in resource sb-leak registered despite the unexpected exit, got %+v", entries)
	}
}

// TestRunnerDoesNotRegisterOnUnexpectedExitByDefault covers the safe default:
// without register_on_failure, an unexpected exit does NOT register the
// resource, so cleanup cannot delete a resource this run may not have created
// (e.g. when the create failed on a name collision).
func TestRunnerDoesNotRegisterOnUnexpectedExitByDefault(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "create fails, no opt-in",
		Steps: []Step{
			{
				Name:   "create that exits nonzero",
				Cmd:    []string{"1", "", "already exists"},
				Expect: Expectation{Exit: intPtr(0)},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "sb-preexisting",
					Cleanup: []string{"0", "", ""},
				},
			},
		},
	}

	if err := r.RunCase(context.Background(), c); err == nil {
		t.Fatal("expected the unexpected exit code to fail the case")
	}
	if entries := r.Ledger().Entries(); len(entries) != 0 {
		t.Fatalf("expected no resource registered on unexpected exit without opt-in, got %+v", entries)
	}
}

// TestRunnerCaptureClearsStaleValueOnReuse covers the stale-capture leak: a
// later step that reuses a capture name whose path now fails must not leave the
// earlier step's value in place, or registerResource would template cleanup
// with the stale identifier and delete the wrong resource.
func TestRunnerCaptureClearsStaleValueOnReuse(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "reused capture name with a now-failing path",
		Steps: []Step{
			{
				Name:    "create first",
				Cmd:     []string{"0", `{"name":"sb-1"}`, ""},
				Capture: map[string]string{"sandbox_name": "$.name"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "{{sandbox_name}}",
					Cleanup: []string{"0", "", ""},
				},
			},
			{
				Name:    "create second, capture path now fails",
				Cmd:     []string{"0", `{"name":"sb-2"}`, ""},
				Capture: map[string]string{"sandbox_name": "$.does_not_exist"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "{{sandbox_name}}",
					Cleanup: []string{"0", "", ""},
				},
			},
		},
	}

	if err := r.RunCase(context.Background(), c); err == nil {
		t.Fatal("expected the failed re-capture to fail the case")
	}
	entries := r.Ledger().Entries()
	if len(entries) != 1 || entries[0].Name != "sb-1" {
		t.Fatalf("expected only the first resource registered (no stale duplicate), got %+v", entries)
	}
}

// TestRunnerCaptureClearedWhenReusedStepStdoutUnparseable covers the same
// stale-capture hazard when the reusing step's stdout is not valid JSON:
// captureVars is skipped in that case, so the invalidation must happen in
// runStep, not inside captureVars, or the previous step's value would survive.
func TestRunnerCaptureClearedWhenReusedStepStdoutUnparseable(t *testing.T) {
	bin := stubScript(t)
	runDir := t.TempDir()

	r, err := New(Options{BinPath: bin, RunDir: runDir})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	c := &Case{
		Name: "reused capture name, second step stdout is not JSON",
		Steps: []Step{
			{
				Name:    "create first",
				Cmd:     []string{"0", `{"name":"sb-1"}`, ""},
				Capture: map[string]string{"sandbox_name": "$.name"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "{{sandbox_name}}",
					Cleanup: []string{"0", "", ""},
				},
			},
			{
				Name:    "second step prints non-json but reuses the capture",
				Cmd:     []string{"0", "not json at all", ""},
				Capture: map[string]string{"sandbox_name": "$.name"},
				Resource: &Resource{
					Type:    "sandbox",
					Name:    "{{sandbox_name}}",
					Cleanup: []string{"0", "", ""},
				},
			},
		},
	}

	if err := r.RunCase(context.Background(), c); err == nil {
		t.Fatal("expected the unparseable stdout to fail the second step")
	}
	entries := r.Ledger().Entries()
	if len(entries) != 1 || entries[0].Name != "sb-1" {
		t.Fatalf("expected no stale duplicate when the reusing step's stdout is unparseable, got %+v", entries)
	}
}

// TestRunnerSchemaLoadedLazily covers the offline-guarantee: a run whose cases
// never use expect.schema must not fetch the OpenAPI document at all, and one
// that does fetches it exactly once.
func TestRunnerSchemaLoadedLazily(t *testing.T) {
	bin := stubScript(t)
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, tinyOpenAPIDoc)
	}))
	defer srv.Close()

	rNoSchema, err := New(Options{BinPath: bin, RunDir: filepath.Join(t.TempDir(), "run"), SchemaDoc: srv.URL})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := rNoSchema.RunCase(context.Background(), &Case{Name: "no schema", Steps: []Step{{Name: "ok", Cmd: []string{"0", "", ""}}}}); err != nil {
		t.Fatalf("RunCase: %v", err)
	}
	if got := hits.Load(); got != 0 {
		t.Fatalf("expected no schema fetch for a case without expect.schema, got %d", got)
	}

	rSchema, err := New(Options{BinPath: bin, RunDir: filepath.Join(t.TempDir(), "run2"), SchemaDoc: srv.URL})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	cSchema := &Case{
		Name: "schema step",
		Steps: []Step{{
			Name:   "validate",
			Cmd:    []string{"0", `{"ok":true}`, ""},
			Expect: Expectation{Schema: "Thing"},
		}},
	}
	if err := rSchema.RunCase(context.Background(), cSchema); err != nil {
		t.Fatalf("RunCase with schema: %v", err)
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("expected exactly one schema fetch, got %d", got)
	}
}

// TestLoadCaseRejectsResourceWithoutCleanup covers the silent-leak the
// reviewer flagged: a resource block with no cleanup argv would record an
// entry whose cleanup runs a bare binary and appears to succeed.
func TestLoadCaseRejectsResourceWithoutCleanup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "no-cleanup.yaml")
	writeFile(t, path, `name: resource without cleanup
steps:
  - name: create something with no cleanup argv
    cmd: [rig, create]
    resource:
      type: sandbox
      name: sb-1
`)
	if _, err := LoadCase(path); err == nil {
		t.Fatal("expected LoadCase to reject a resource with no cleanup argv")
	}
}

// TestMergeEnv covers the per-entry cleanup environment: a creating step's env
// overrides win over the base cleanup env, keys are deduplicated, and an empty
// override set returns the base unchanged.
func TestMergeEnv(t *testing.T) {
	got := mergeEnv([]string{"A=1", "B=2"}, map[string]string{"B": "override", "C": "3"})
	seen := map[string]string{}
	for _, kv := range got {
		k, v, _ := strings.Cut(kv, "=")
		if _, dup := seen[k]; dup {
			t.Fatalf("duplicate key %q in %v", k, got)
		}
		seen[k] = v
	}
	if seen["A"] != "1" || seen["B"] != "override" || seen["C"] != "3" {
		t.Fatalf("unexpected merge result: %v", got)
	}
	if out := mergeEnv([]string{"X=1"}, nil); len(out) != 1 || out[0] != "X=1" {
		t.Fatalf("expected base returned unchanged with no overrides, got %v", out)
	}
}

// TestLoadCaseRejectsUnknownFields covers the false-positive the reviewer
// flagged: a misspelled assertion key must fail at load rather than being
// silently dropped (which would leave the step asserting nothing).
func TestLoadCaseRejectsUnknownFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "typo.yaml")
	writeFile(t, path, `name: typo case
steps:
  - name: step with a misspelled assertion field
    cmd: [version]
    expect:
      stdout_josn:
        foo: bar
`)
	if _, err := LoadCase(path); err == nil {
		t.Fatal("expected LoadCase to reject the unknown field 'stdout_josn'")
	}
}

// TestLoadCaseRejectsInvalidCaptureName covers the capture-grammar gap: a
// capture name that "{{...}}" cannot reference (e.g. "sandbox/name") must fail
// at load rather than storing a value no template can ever use.
func TestLoadCaseRejectsInvalidCaptureName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad-capture.yaml")
	writeFile(t, path, `name: bad capture name
steps:
  - name: s
    cmd: [version]
    capture:
      "sandbox/name": $.name
`)
	if _, err := LoadCase(path); err == nil {
		t.Fatal("expected LoadCase to reject a capture name outside the template grammar")
	}
}

// TestLoadCaseRejectsMultipleDocuments covers the silent-drop the reviewer
// flagged: a stray second YAML document (after "---") would otherwise be
// ignored, bypassing the known-field validation on the first.
func TestLoadCaseRejectsMultipleDocuments(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "multi.yaml")
	writeFile(t, path, `name: first doc
steps:
  - name: s
    cmd: [version]
---
name: second doc
steps:
  - name: s2
    cmd: [version]
`)
	if _, err := LoadCase(path); err == nil {
		t.Fatal("expected LoadCase to reject a file with multiple YAML documents")
	}

	// A bare trailing "---" (an empty second document) is harmless and loads.
	trailing := filepath.Join(dir, "trailing.yaml")
	writeFile(t, trailing, `name: only doc
steps:
  - name: s
    cmd: [version]
---
`)
	if _, err := LoadCase(trailing); err != nil {
		t.Fatalf("expected a bare trailing --- to load, got: %v", err)
	}

	// A real document must not hide behind empty separators: the scan runs to
	// EOF rather than stopping at the first extra document.
	hidden := filepath.Join(dir, "hidden.yaml")
	writeFile(t, hidden, `name: first doc
steps:
  - name: s
    cmd: [version]
---
---
name: hidden second doc
steps:
  - name: s2
    cmd: [version]
`)
	if _, err := LoadCase(hidden); err == nil {
		t.Fatal("expected LoadCase to reject a content-bearing document hidden behind empty separators")
	}

	// A syntax error in a later document is surfaced, not swallowed by the
	// scan loop.
	badLater := filepath.Join(dir, "bad-later.yaml")
	writeFile(t, badLater, "name: ok doc\nsteps:\n  - name: s\n    cmd: [version]\n---\n:\n  - broken: [\n")
	if _, err := LoadCase(badLater); err == nil {
		t.Fatal("expected LoadCase to surface a parse error in a later document")
	}
}

// TestRunnerExplicitNullStdoutJSON covers the presence-vs-null ambiguity: an
// explicit "stdout_json: null" asserts the command printed JSON null, whereas
// omitting the field makes no JSON assertion at all.
func TestRunnerExplicitNullStdoutJSON(t *testing.T) {
	bin := stubScript(t)
	dir := t.TempDir()

	// stubScript prints its second argv ($2) to stdout, so cmd[1] is stdout.
	pass := filepath.Join(dir, "pass.yaml")
	writeFile(t, pass, `name: explicit null matches null stdout
steps:
  - name: prints null
    cmd: ["0", "null", ""]
    expect:
      stdout_json: null
`)
	cPass, err := LoadCase(pass)
	if err != nil {
		t.Fatalf("LoadCase(pass): %v", err)
	}
	if !cPass.Steps[0].Expect.stdoutJSONSet {
		t.Fatal("expected stdoutJSONSet to be true for an explicit null")
	}
	rPass, err := New(Options{BinPath: bin, RunDir: filepath.Join(dir, "run-pass")})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := rPass.RunCase(context.Background(), cPass); err != nil {
		t.Fatalf("expected null stdout to satisfy stdout_json: null, got: %v", err)
	}

	fail := filepath.Join(dir, "fail.yaml")
	writeFile(t, fail, `name: explicit null rejects non-null stdout
steps:
  - name: prints an object
    cmd: ["0", "{\"a\":1}", ""]
    expect:
      stdout_json: null
`)
	cFail, err := LoadCase(fail)
	if err != nil {
		t.Fatalf("LoadCase(fail): %v", err)
	}
	rFail, err := New(Options{BinPath: bin, RunDir: filepath.Join(dir, "run-fail")})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := rFail.RunCase(context.Background(), cFail); err == nil {
		t.Fatal("expected non-null stdout to fail stdout_json: null")
	}

	// A case that omits stdout_json makes no JSON assertion, so even
	// non-JSON stdout passes.
	omit := filepath.Join(dir, "omit.yaml")
	writeFile(t, omit, `name: omitted stdout_json makes no assertion
steps:
  - name: prints non-json
    cmd: ["0", "not json at all", ""]
    expect:
      exit: 0
`)
	cOmit, err := LoadCase(omit)
	if err != nil {
		t.Fatalf("LoadCase(omit): %v", err)
	}
	if cOmit.Steps[0].Expect.stdoutJSONSet {
		t.Fatal("expected stdoutJSONSet to be false when the field is omitted")
	}
	rOmit, err := New(Options{BinPath: bin, RunDir: filepath.Join(dir, "run-omit")})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := rOmit.RunCase(context.Background(), cOmit); err != nil {
		t.Fatalf("expected omitted stdout_json to make no assertion, got: %v", err)
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

	err = r.RunCase(context.Background(), c)
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
	if err := r.RunCase(context.Background(), c); err != nil {
		t.Fatalf("RunCase: %v", err)
	}
}

func TestRunnerNegativeContentAssertions(t *testing.T) {
	bin := stubScript(t)

	t.Run("pass when forbidden content is absent", func(t *testing.T) {
		r, err := New(Options{BinPath: bin, RunDir: t.TempDir()})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		c := &Case{
			Name: "negative content passes",
			Steps: []Step{{
				Name: "clean output",
				Cmd:  []string{"0", "safe stdout", "safe stderr"},
				Expect: Expectation{
					StdoutNotContains: "secret",
					StderrNotContains: "secret",
				},
			}},
		}
		if err := r.RunCase(context.Background(), c); err != nil {
			t.Fatalf("RunCase: %v", err)
		}
	})

	t.Run("fail when forbidden stdout is present", func(t *testing.T) {
		r, err := New(Options{BinPath: bin, RunDir: t.TempDir()})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		c := &Case{
			Name: "negative stdout fails",
			Steps: []Step{{
				Name:   "leaked stdout",
				Cmd:    []string{"0", "contains secret", ""},
				Expect: Expectation{StdoutNotContains: "secret"},
			}},
		}
		err = r.RunCase(context.Background(), c)
		if err == nil || !strings.Contains(err.Error(), "stdout_not_contains") {
			t.Fatalf("expected stdout_not_contains failure, got %v", err)
		}
	})

	t.Run("fail when forbidden stderr is present", func(t *testing.T) {
		r, err := New(Options{BinPath: bin, RunDir: t.TempDir()})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		c := &Case{
			Name: "negative stderr fails",
			Steps: []Step{{
				Name:   "leaked stderr",
				Cmd:    []string{"0", "", "contains secret"},
				Expect: Expectation{StderrNotContains: "secret"},
			}},
		}
		err = r.RunCase(context.Background(), c)
		if err == nil || !strings.Contains(err.Error(), "stderr_not_contains") {
			t.Fatalf("expected stderr_not_contains failure, got %v", err)
		}
	})
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
	if err := r.RunCase(context.Background(), c); err != nil {
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

// TestSchemaValidatorHonorsNullableComposition covers a nullable schema that
// has no top-level type but constrains its value with allOf/$ref (a shape an
// OpenAPI generator can emit). Dropping "nullable" alone would leave it
// rejecting null, so the rewrite must widen it to accept null via composition.
func TestSchemaValidatorHonorsNullableComposition(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "openapi.json")
	writeFile(t, path, `{
	  "openapi": "3.1.0",
	  "info": {"title": "nullable-composition", "version": "0"},
	  "paths": {},
	  "components": {
	    "schemas": {
	      "Inner": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}},
	      "Thing": {
	        "type": "object",
	        "required": ["child"],
	        "properties": {
	          "child": {"allOf": [{"$ref": "#/components/schemas/Inner"}], "nullable": true}
	        }
	      }
	    }
	  }
	}`)

	v := LoadOpenAPISchema(path)
	// A null child validates because the field is nullable.
	if err := v.Validate("Thing", map[string]any{"child": nil}); err != nil {
		t.Fatalf("expected null child to validate under composed nullable: %v", err)
	}
	// A valid inner object validates.
	if err := v.Validate("Thing", map[string]any{"child": map[string]any{"id": "x"}}); err != nil {
		t.Fatalf("expected a valid inner object to validate: %v", err)
	}
	// An inner object missing its required field still fails: nullable widens
	// to null, not to anything.
	if err := v.Validate("Thing", map[string]any{"child": map[string]any{}}); err == nil {
		t.Fatalf("expected an invalid inner object to fail validation")
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

// TestSchemaValidatorLoadsFromURL covers loading the OpenAPI document from an
// http(s) URL rather than a checked-in file. It serves a tiny doc from a
// localhost test server (so the unit test stays offline) and confirms the
// validator fetches and compiles it.
func TestSchemaValidatorLoadsFromURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, tinyOpenAPIDoc)
	}))
	defer srv.Close()

	v := LoadOpenAPISchema(srv.URL + "/openapi.json")
	if err := v.Validate("Thing", map[string]any{"ok": true, "name": "widget"}); err != nil {
		t.Fatalf("expected valid instance fetched from URL to pass: %v", err)
	}
	if err := v.Validate("Thing", map[string]any{"ok": "not-a-bool"}); err == nil {
		t.Fatalf("expected invalid instance to fail")
	}
}

// TestSchemaValidatorURLFetchFailure covers a URL that returns a non-200
// status: loading is best-effort, so Validate fails with a clear error rather
// than panicking.
func TestSchemaValidatorURLFetchFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer srv.Close()

	v := LoadOpenAPISchema(srv.URL + "/missing.json")
	err := v.Validate("Thing", map[string]any{})
	if err == nil {
		t.Fatalf("expected error when the document could not be fetched")
	}
	if !strings.Contains(err.Error(), "openapi document unavailable") {
		t.Fatalf("expected clear unavailable-document error, got: %v", err)
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
