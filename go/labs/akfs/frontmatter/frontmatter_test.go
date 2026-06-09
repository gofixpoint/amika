package frontmatter

import (
	"errors"
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
	got, err := Parse(strings.NewReader(doc))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	want := map[string]any{
		"title":  "The components of a software factory",
		"status": "draft",
		"tags":   []any{"software-factory", "agents", "infrastructure"},
		"slides": "content/slides/components-of-a-software-factory/slides.md",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Parse() = %#v, want %#v", got, want)
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
	if got["title"] != "hi" {
		t.Errorf("title = %v, want %q", got["title"], "hi")
	}
}

// TestParseEmptyBlock verifies an empty frontmatter block yields an empty,
// non-nil map rather than an error.
func TestParseEmptyBlock(t *testing.T) {
	got, err := Parse(strings.NewReader("---\n---\nbody\n"))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if got == nil {
		t.Fatal("Parse() returned nil map, want empty map")
	}
	if len(got) != 0 {
		t.Errorf("Parse() = %#v, want empty map", got)
	}
}

// TestParseDocumentEndDelimiter verifies that a "..." line also closes the
// frontmatter block.
func TestParseDocumentEndDelimiter(t *testing.T) {
	got, err := Parse(strings.NewReader("---\ntitle: hi\n...\nbody\n"))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if got["title"] != "hi" {
		t.Errorf("title = %v, want %q", got["title"], "hi")
	}
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
