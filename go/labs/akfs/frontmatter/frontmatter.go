// Package frontmatter extracts and parses YAML frontmatter from text
// documents. It is part of the experimental akfs labs tooling and carries no
// compatibility guarantees; see go/labs/README.md.
package frontmatter

import (
	"bufio"
	"errors"
	"io"
	"strings"

	"gopkg.in/yaml.v3"
)

// delimiter is the line that opens and closes a YAML frontmatter block.
const delimiter = "---"

// ErrUnterminated is returned when an opening "---" delimiter is found but the
// closing delimiter is missing.
var ErrUnterminated = errors.New("unterminated frontmatter: missing closing '---'")

// Document is the result of parsing a frontmatter document: the YAML
// frontmatter block and the body content that follows it.
type Document struct {
	// Frontmatter is the parsed YAML frontmatter. An empty block yields an
	// empty, non-nil map.
	Frontmatter map[string]any
	// Content is the document body following the closing delimiter, with the
	// single newline that separates the delimiter from the body stripped so
	// the content reads as though the frontmatter block were absent. Any
	// trailing newline at the end of the input is preserved.
	Content string
}

// Parse reads the YAML frontmatter at the start of r and returns it. It stops
// reading at the closing delimiter and does not consume the document body, so
// the returned Document.Content is always empty. The frontmatter must begin on
// the first line with a "---" delimiter and end with a matching "---" (or
// "...") delimiter line.
//
// Use ParseWithContent when the body is needed; Parse exists so callers that
// only want the metadata never read past it (large documents are not loaded
// into memory).
//
// A document with no leading "---" delimiter is treated as having no
// frontmatter rather than an error: the returned frontmatter is an empty,
// non-nil map. (In that case ParseWithContent returns the entire input as the
// content; Parse leaves Content empty, as always.) An empty frontmatter block
// likewise parses to an empty, non-nil map. Parse returns ErrUnterminated when
// an opening delimiter is present but its closing delimiter is absent.
func Parse(r io.Reader) (Document, error) {
	return parse(r, false)
}

// ParseWithContent is like Parse but also reads and returns the document body
// that follows the frontmatter as Document.Content. The single newline
// separating the closing delimiter from the body is stripped so the content
// reads as though the frontmatter block were absent; any trailing newline at
// the end of the input is preserved. When the document has no frontmatter at
// all, the entire input is returned verbatim as the content.
func ParseWithContent(r io.Reader) (Document, error) {
	return parse(r, true)
}

// parse reads the frontmatter block from r. When wantContent is true it also
// reads the remaining body into Document.Content; otherwise it returns as soon
// as the closing delimiter is found, leaving the body unread.
func parse(r io.Reader, wantContent bool) (Document, error) {
	br := bufio.NewReader(r)

	first, err := br.ReadString('\n')
	if err != nil && err != io.EOF {
		return Document{}, err
	}
	if trimLine(first) != delimiter {
		// No leading delimiter: the document has no frontmatter. Treat the
		// whole input as content rather than failing. As with any body, the
		// content is only materialized when the caller asks for it.
		content := ""
		if wantContent {
			rest, err := io.ReadAll(br)
			if err != nil {
				return Document{}, err
			}
			content = first + string(rest)
		}
		return Document{Frontmatter: map[string]any{}, Content: content}, nil
	}
	if err == io.EOF {
		// Input was a single "---" line with no closing delimiter.
		return Document{}, ErrUnterminated
	}

	var body strings.Builder
	closed := false
	for {
		line, err := br.ReadString('\n')
		if err != nil && err != io.EOF {
			return Document{}, err
		}
		trimmed := trimLine(line)
		if trimmed == delimiter || trimmed == "..." {
			closed = true
			break
		}
		body.WriteString(trimmed)
		body.WriteByte('\n')
		if err == io.EOF {
			// Reached the end of input without a closing delimiter.
			break
		}
	}
	if !closed {
		return Document{}, ErrUnterminated
	}

	out := map[string]any{}
	if err := yaml.Unmarshal([]byte(body.String()), &out); err != nil {
		return Document{}, err
	}
	if out == nil {
		out = map[string]any{}
	}

	content := ""
	if wantContent {
		rest, err := io.ReadAll(br)
		if err != nil {
			return Document{}, err
		}
		// Strip the single leading newline separating the closing delimiter
		// from the body so the content renders as though the frontmatter were
		// absent; the trailing newline (if any) is left untouched.
		content = string(rest)
		switch {
		case strings.HasPrefix(content, "\r\n"):
			content = content[2:]
		case strings.HasPrefix(content, "\n"):
			content = content[1:]
		}
	}

	return Document{Frontmatter: out, Content: content}, nil
}

// trimLine strips a line's trailing newline (and carriage return, for
// Windows-style endings) as returned by bufio.Reader.ReadString.
func trimLine(line string) string {
	return strings.TrimRight(strings.TrimSuffix(line, "\n"), "\r")
}
