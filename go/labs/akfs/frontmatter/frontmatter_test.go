package frontmatter

import (
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	const doc = `---
title: The components of a software factory
status: draft
tags: [software-factory, agents, infrastructure]
slides: content/slides/components-of-a-software-factory/slides.md
---

# Body content here
`
	got, err := ParseWithContent(strings.NewReader(doc))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	want := map[string]any{
		"title":  "The components of a software factory",
		"status": "draft",
		"tags":   []any{"software-factory", "agents", "infrastructure"},
		"slides": "content/slides/components-of-a-software-factory/slides.md",
	}
	if !reflect.DeepEqual(got.Frontmatter, want) {
		t.Errorf("Parse() frontmatter = %#v, want %#v", got.Frontmatter, want)
	}
	// The leading newline after the closing delimiter is stripped; the trailing
	// newline is preserved.
	if wantContent := "# Body content here\n"; got.Content != wantContent {
		t.Errorf("Parse() content = %q, want %q", got.Content, wantContent)
	}
}

// TestParseCRLF verifies that Windows-style line endings are handled when
// matching the delimiter lines.
func TestParseCRLF(t *testing.T) {
	doc := "---\r\ntitle: hi\r\n---\r\nbody\r\n"
	got, err := Parse(strings.NewReader(doc))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if got.Frontmatter["title"] != "hi" {
		t.Errorf("title = %v, want %q", got.Frontmatter["title"], "hi")
	}
}

// TestParseEmptyBlock verifies an empty frontmatter block yields an empty,
// non-nil map rather than an error.
func TestParseEmptyBlock(t *testing.T) {
	got, err := ParseWithContent(strings.NewReader("---\n---\nbody\n"))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if got.Frontmatter == nil {
		t.Fatal("Parse() returned nil map, want empty map")
	}
	if len(got.Frontmatter) != 0 {
		t.Errorf("Parse() = %#v, want empty map", got.Frontmatter)
	}
	// No blank line separates the closing delimiter from the body, so nothing
	// is stripped.
	if got.Content != "body\n" {
		t.Errorf("Parse() content = %q, want %q", got.Content, "body\n")
	}
}

// TestParseDocumentEndDelimiter verifies that a "..." line also closes the
// frontmatter block.
func TestParseDocumentEndDelimiter(t *testing.T) {
	got, err := Parse(strings.NewReader("---\ntitle: hi\n...\nbody\n"))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if got.Frontmatter["title"] != "hi" {
		t.Errorf("title = %v, want %q", got.Frontmatter["title"], "hi")
	}
}

// TestParseContent verifies how ParseWithContent captures the document body:
// the single newline separating the closing delimiter from the body is
// stripped, while a trailing newline (or its absence) is preserved verbatim.
func TestParseContent(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"blank line then body", "---\na: 1\n---\n\nbody\n", "body\n"},
		{"no blank line", "---\na: 1\n---\nbody\n", "body\n"},
		{"no trailing newline", "---\na: 1\n---\nbody", "body"},
		{"empty body", "---\na: 1\n---\n", ""},
		{"multiple trailing blank lines preserved", "---\na: 1\n---\n\nbody\n\n", "body\n\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseWithContent(strings.NewReader(tt.input))
			if err != nil {
				t.Fatalf("Parse returned error: %v", err)
			}
			if got.Content != tt.want {
				t.Errorf("content = %q, want %q", got.Content, tt.want)
			}
		})
	}
}

// TestParseStopsAtClosingDelimiter verifies that Parse does not read the
// document body — only ParseWithContent does. A large body is appended after
// the frontmatter; Parse should read far less than the whole input, while
// ParseWithContent reads all of it.
func TestParseStopsAtClosingDelimiter(t *testing.T) {
	// Body comfortably larger than bufio.Reader's default buffer so that
	// stopping early reads materially less than the whole document.
	body := strings.Repeat("lorem ipsum dolor sit amet\n", 50000) // ~1.3 MB
	doc := "---\ntitle: hi\n---\n" + body

	cr := &countingReader{r: strings.NewReader(doc)}
	got, err := Parse(cr)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if got.Frontmatter["title"] != "hi" {
		t.Errorf("title = %v, want %q", got.Frontmatter["title"], "hi")
	}
	if got.Content != "" {
		t.Errorf("Parse Content = %q, want empty (body not read)", got.Content)
	}
	if cr.n >= len(doc) {
		t.Errorf("Parse read %d of %d bytes; should stop before the body", cr.n, len(doc))
	}

	cr2 := &countingReader{r: strings.NewReader(doc)}
	got2, err := ParseWithContent(cr2)
	if err != nil {
		t.Fatalf("ParseWithContent returned error: %v", err)
	}
	if got2.Content != body {
		t.Errorf("ParseWithContent did not return the full body (got %d bytes, want %d)", len(got2.Content), len(body))
	}
	if cr2.n != len(doc) {
		t.Errorf("ParseWithContent read %d of %d bytes; want all", cr2.n, len(doc))
	}
}

// countingReader wraps an io.Reader and records how many bytes have been read
// from the underlying source.
type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

func TestParseErrors(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr error
	}{
		{"empty input", "", ErrNoFrontmatter},
		{"no leading delimiter", "title: hi\n---\n", ErrNoFrontmatter},
		{"unterminated", "---\ntitle: hi\n", ErrUnterminated},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Parse(strings.NewReader(tt.input))
			if !errors.Is(err, tt.wantErr) {
				t.Errorf("Parse() error = %v, want %v", err, tt.wantErr)
			}
		})
	}
}
