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

// ErrNoFrontmatter is returned when the input does not begin with a frontmatter
// block (a line containing only "---").
var ErrNoFrontmatter = errors.New("no frontmatter found: input does not start with '---'")

// ErrUnterminated is returned when an opening "---" delimiter is found but the
// closing delimiter is missing.
var ErrUnterminated = errors.New("unterminated frontmatter: missing closing '---'")

// Parse reads r and returns the parsed YAML frontmatter found at the start of
// the input. The frontmatter must begin on the first line with a "---"
// delimiter and end with a matching "---" (or "...") delimiter line.
//
// An empty frontmatter block parses to an empty, non-nil map. Parse returns
// ErrNoFrontmatter if the input has no leading delimiter and ErrUnterminated if
// the closing delimiter is absent.
func Parse(r io.Reader) (map[string]any, error) {
	scanner := bufio.NewScanner(r)
	// Allow long frontmatter lines (e.g. inline arrays/objects) beyond the
	// default 64 KiB token limit.
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)

	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNoFrontmatter
	}
	if strings.TrimRight(scanner.Text(), "\r") != delimiter {
		return nil, ErrNoFrontmatter
	}

	var body strings.Builder
	closed := false
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == delimiter || line == "..." {
			closed = true
			break
		}
		body.WriteString(scanner.Text())
		body.WriteByte('\n')
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if !closed {
		return nil, ErrUnterminated
	}

	out := map[string]any{}
	if err := yaml.Unmarshal([]byte(body.String()), &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}
