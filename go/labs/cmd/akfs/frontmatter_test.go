package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const docA = "---\ntitle: First doc\ntags: [a, b]\n---\nbody\n"
const docB = "---\ntitle: Second doc\nstatus: draft\n---\nbody\n"
const docStdin = "---\ntitle: From stdin\n---\nbody\n"

// writeTemp writes content to a temp file and returns its path.
func writeTemp(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "doc.md")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	return path
}

// decodeLines parses the JSONL output into records (the CLI's JSON envelope).
func decodeLines(t *testing.T, out string) []record {
	t.Helper()
	var recs []record
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		var r record
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("invalid JSON line %q: %v", line, err)
		}
		recs = append(recs, r)
	}
	return recs
}

func TestFrontmatterSingleFile(t *testing.T) {
	path := writeTemp(t, docA)
	out, err := runRootCommand("frontmatter", path)
	if err != nil {
		t.Fatalf("runRootCommand: %v", err)
	}
	recs := decodeLines(t, out)
	if len(recs) != 1 {
		t.Fatalf("got %d records, want 1: %q", len(recs), out)
	}
	if recs[0].Filename != path {
		t.Errorf("filename = %q, want %q", recs[0].Filename, path)
	}
	if recs[0].Frontmatter["title"] != "First doc" {
		t.Errorf("data.title = %v, want %q", recs[0].Frontmatter["title"], "First doc")
	}
}

// TestFrontmatterAlias verifies the "fm" alias routes to the same command.
func TestFrontmatterAlias(t *testing.T) {
	path := writeTemp(t, docA)
	out, err := runRootCommand("fm", path)
	if err != nil {
		t.Fatalf("runRootCommand: %v", err)
	}
	if recs := decodeLines(t, out); len(recs) != 1 || recs[0].Filename != path {
		t.Errorf("alias output = %q, want single record for %q", out, path)
	}
}

func TestFrontmatterMultipleFiles(t *testing.T) {
	a, b := writeTemp(t, docA), writeTemp(t, docB)
	out, err := runRootCommand("frontmatter", a, b)
	if err != nil {
		t.Fatalf("runRootCommand: %v", err)
	}
	recs := decodeLines(t, out)
	if len(recs) != 2 {
		t.Fatalf("got %d records, want 2: %q", len(recs), out)
	}
	// Filenames appear in argument order.
	if recs[0].Filename != a || recs[1].Filename != b {
		t.Errorf("filenames = [%q, %q], want [%q, %q]", recs[0].Filename, recs[1].Filename, a, b)
	}
}

// TestFrontmatterStdinDocument verifies that "-" reads a single document from
// stdin, omitting the filename field.
func TestFrontmatterStdinDocument(t *testing.T) {
	out, err := runRootCommandWithStdin(docStdin, "frontmatter", "-")
	if err != nil {
		t.Fatalf("runRootCommandWithStdin: %v", err)
	}
	recs := decodeLines(t, out)
	if len(recs) != 1 {
		t.Fatalf("got %d records, want 1: %q", len(recs), out)
	}
	if recs[0].Filename != "" {
		t.Errorf("filename = %q, want empty (omitted) for stdin document", recs[0].Filename)
	}
	if recs[0].Frontmatter["title"] != "From stdin" {
		t.Errorf("data.title = %v, want %q", recs[0].Frontmatter["title"], "From stdin")
	}
}

// TestFrontmatterStdinFileList verifies that, with no arguments, stdin is read
// as a newline-delimited list of file paths and each file is processed in
// order. This is the `fd ... | akfs fm` use case.
func TestFrontmatterStdinFileList(t *testing.T) {
	a, b := writeTemp(t, docA), writeTemp(t, docB)
	list := a + "\n" + b + "\n"

	out, err := runRootCommandWithStdin(list, "frontmatter")
	if err != nil {
		t.Fatalf("runRootCommandWithStdin: %v", err)
	}
	recs := decodeLines(t, out)
	if len(recs) != 2 {
		t.Fatalf("got %d records, want 2: %q", len(recs), out)
	}
	if recs[0].Filename != a || recs[1].Filename != b {
		t.Errorf("filenames = [%q, %q], want [%q, %q]", recs[0].Filename, recs[1].Filename, a, b)
	}
	if recs[0].Frontmatter["title"] != "First doc" || recs[1].Frontmatter["title"] != "Second doc" {
		t.Errorf("titles = [%v, %v], want [First doc, Second doc]", recs[0].Frontmatter["title"], recs[1].Frontmatter["title"])
	}
}

// TestFrontmatterStdinFileListSkipsBlankLines verifies blank lines in the file
// list are ignored rather than treated as paths.
func TestFrontmatterStdinFileListSkipsBlankLines(t *testing.T) {
	a := writeTemp(t, docA)
	list := "\n" + a + "\n\n"

	out, err := runRootCommandWithStdin(list, "frontmatter")
	if err != nil {
		t.Fatalf("runRootCommandWithStdin: %v", err)
	}
	if recs := decodeLines(t, out); len(recs) != 1 || recs[0].Filename != a {
		t.Errorf("output = %q, want single record for %q", out, a)
	}
}

// TestFrontmatterStdinFileListMissingFile verifies a non-existent path in the
// list surfaces an error.
func TestFrontmatterStdinFileListMissingFile(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.md")
	_, err := runRootCommandWithStdin(missing+"\n", "frontmatter")
	if err == nil {
		t.Fatal("expected error for missing file in list, got nil")
	}
}

// TestFrontmatterFilesAndStdinInterleaved is the behavior in question: mixing
// file paths and stdin (via "-") in a single invocation. Each input is emitted
// in argument order, with stdin read at the position of "-".
func TestFrontmatterFilesAndStdinInterleaved(t *testing.T) {
	a, b := writeTemp(t, docA), writeTemp(t, docB)
	out, err := runRootCommandWithStdin(docStdin, "frontmatter", a, "-", b)
	if err != nil {
		t.Fatalf("runRootCommandWithStdin: %v", err)
	}
	recs := decodeLines(t, out)
	if len(recs) != 3 {
		t.Fatalf("got %d records, want 3: %q", len(recs), out)
	}
	if recs[0].Filename != a {
		t.Errorf("record 0 filename = %q, want %q", recs[0].Filename, a)
	}
	// The middle record is stdin: no filename, parsed from docStdin.
	if recs[1].Filename != "" {
		t.Errorf("record 1 filename = %q, want empty (stdin)", recs[1].Filename)
	}
	if recs[1].Frontmatter["title"] != "From stdin" {
		t.Errorf("record 1 data.title = %v, want %q", recs[1].Frontmatter["title"], "From stdin")
	}
	if recs[2].Filename != b {
		t.Errorf("record 2 filename = %q, want %q", recs[2].Filename, b)
	}
}

// TestFrontmatterFilesIgnoreUnreferencedStdin documents that piped stdin is not
// read when file arguments are given without "-".
func TestFrontmatterFilesIgnoreUnreferencedStdin(t *testing.T) {
	a := writeTemp(t, docA)
	out, err := runRootCommandWithStdin(docStdin, "frontmatter", a)
	if err != nil {
		t.Fatalf("runRootCommandWithStdin: %v", err)
	}
	recs := decodeLines(t, out)
	if len(recs) != 1 {
		t.Fatalf("got %d records, want 1 (stdin ignored): %q", len(recs), out)
	}
	if recs[0].Frontmatter["title"] != "First doc" {
		t.Errorf("data.title = %v, want %q (stdin should be ignored)", recs[0].Frontmatter["title"], "First doc")
	}
}

// docWithBody has a blank line between the closing delimiter and the body so
// the leading-newline-stripping behavior is exercised.
const docWithBody = "---\ntitle: With body\n---\n\nHello, body.\n"

// TestFrontmatterContentNoneDefault verifies that without --content (the
// default "none") no content field is emitted and data is present.
func TestFrontmatterContentNoneDefault(t *testing.T) {
	path := writeTemp(t, docWithBody)
	out, err := runRootCommand("frontmatter", path)
	if err != nil {
		t.Fatalf("runRootCommand: %v", err)
	}
	if strings.Contains(out, "content") {
		t.Errorf("default output should not contain a content field: %q", out)
	}
	recs := decodeLines(t, out)
	if recs[0].Frontmatter["title"] != "With body" {
		t.Errorf("data.title = %v, want %q", recs[0].Frontmatter["title"], "With body")
	}
}

// TestFrontmatterContentAlso verifies --content=also emits both data and the
// body, with the leading newline stripped and trailing newline preserved.
func TestFrontmatterContentAlso(t *testing.T) {
	path := writeTemp(t, docWithBody)
	out, err := runRootCommand("frontmatter", "--content", "also", path)
	if err != nil {
		t.Fatalf("runRootCommand: %v", err)
	}
	recs := decodeLines(t, out)
	if recs[0].Frontmatter["title"] != "With body" {
		t.Errorf("data.title = %v, want %q", recs[0].Frontmatter["title"], "With body")
	}
	if recs[0].Content != "Hello, body.\n" {
		t.Errorf("content = %q, want %q", recs[0].Content, "Hello, body.\n")
	}
}

// TestFrontmatterContentOnly verifies --content=only emits the body and drops
// the data field.
func TestFrontmatterContentOnly(t *testing.T) {
	path := writeTemp(t, docWithBody)
	out, err := runRootCommand("frontmatter", "--content", "only", path)
	if err != nil {
		t.Fatalf("runRootCommand: %v", err)
	}
	if strings.Contains(out, "\"frontmatter\"") {
		t.Errorf("--content=only output should not contain a frontmatter field: %q", out)
	}
	recs := decodeLines(t, out)
	if recs[0].Content != "Hello, body.\n" {
		t.Errorf("content = %q, want %q", recs[0].Content, "Hello, body.\n")
	}
	if recs[0].Filename != path {
		t.Errorf("filename = %q, want %q", recs[0].Filename, path)
	}
}

// TestFrontmatterContentInvalid verifies an unrecognized --content value is
// rejected.
func TestFrontmatterContentInvalid(t *testing.T) {
	path := writeTemp(t, docWithBody)
	_, err := runRootCommand("frontmatter", "--content", "bogus", path)
	if err == nil {
		t.Fatal("expected error for invalid --content value, got nil")
	}
}

func TestFrontmatterMissingFile(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.md")
	_, err := runRootCommand("frontmatter", missing)
	if err == nil {
		t.Fatal("expected error for missing file, got nil")
	}
}

func TestFrontmatterParseErrorNamesSource(t *testing.T) {
	path := writeTemp(t, "no frontmatter here\n")
	_, err := runRootCommand("frontmatter", path)
	if err == nil {
		t.Fatal("expected parse error, got nil")
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("error %q should mention source path %q", err, path)
	}
}
