package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/gofixpoint/amika/go/labs/akfs/frontmatter"
	"github.com/spf13/cobra"
)

// contentMode selects whether and how the document body ("content") appears in
// the JSON output, set by the --content flag.
type contentMode string

const (
	// contentNone omits the content field entirely (the default).
	contentNone contentMode = "none"
	// contentOnly emits only the content, dropping the frontmatter ("data").
	contentOnly contentMode = "only"
	// contentAlso emits the frontmatter and the content together.
	contentAlso contentMode = "also"
)

func init() {
	var content string

	cmd := &cobra.Command{
		Use:     "frontmatter [file...]",
		Aliases: []string{"fm"},
		Short:   "Parse YAML frontmatter from files or stdin",
		Long: `Parse the YAML frontmatter block from one or more documents and emit
it as JSON.

Each argument is a file path; the special argument "-" reads a single document
from stdin. When no arguments are given, stdin is instead treated as a
newline-delimited list of file paths to process (e.g. piped from "fd" or
"find"). Frontmatter begins on the first line with a "---" delimiter and closes
with a matching "---" line. A document with no leading "---" is treated as
having no frontmatter (an empty "frontmatter" object) rather than an error.

Output is one line of compact JSON per document: the parsed frontmatter under a
"frontmatter" key, alongside a "filename" key naming the source file (omitted
when the document is read from stdin via "-"). With multiple inputs, one JSON
line is emitted per document, in order.

The --content flag controls whether the document body following the
frontmatter is included under a top-level "content" key:

  none  do not include the content (default)
  also  include the frontmatter and the content together
  only  include just the content, dropping the "frontmatter"`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			mode := contentMode(content)
			switch mode {
			case contentNone, contentOnly, contentAlso:
			default:
				return fmt.Errorf("invalid --content value %q: must be one of none, only, also", content)
			}

			enc := json.NewEncoder(cmd.OutOrStdout())
			stdin := cmd.InOrStdin()

			// No arguments: read a newline-delimited list of file paths from
			// stdin and process each. Use "-" as an argument to parse a single
			// document from stdin instead.
			if len(args) == 0 {
				return emitFileList(enc, stdin, mode)
			}
			for _, arg := range args {
				if err := emitPath(enc, stdin, arg, mode); err != nil {
					return err
				}
			}
			return nil
		},
	}

	cmd.Flags().StringVar(&content, "content", string(contentNone),
		"include the document body: none|also|only")

	rootCmd.AddCommand(cmd)
}

// record is the JSON envelope emitted per input: the source filename (omitted
// for stdin) alongside the parsed frontmatter and/or the document body. The
// mode field selects which of those appear and is not itself serialized.
type record struct {
	Filename    string         `json:"filename,omitempty"`
	Frontmatter map[string]any `json:"frontmatter"`
	Content     string         `json:"content"`
	mode        contentMode
}

// MarshalJSON emits the record's fields in a stable order — filename,
// frontmatter, content — including only the fields selected by the record's
// mode. The frontmatter is included unless the mode is content-only; the body
// ("content") is included when the mode is content-only or content-also. An
// empty frontmatter block still renders as "frontmatter":{}.
func (r record) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	first := true
	field := func(key string, val any) error {
		if !first {
			buf.WriteByte(',')
		}
		first = false
		k, err := json.Marshal(key)
		if err != nil {
			return err
		}
		buf.Write(k)
		buf.WriteByte(':')
		v, err := json.Marshal(val)
		if err != nil {
			return err
		}
		buf.Write(v)
		return nil
	}

	if r.Filename != "" {
		if err := field("filename", r.Filename); err != nil {
			return nil, err
		}
	}
	if r.mode != contentOnly {
		if err := field("frontmatter", r.Frontmatter); err != nil {
			return nil, err
		}
	}
	if r.mode == contentOnly || r.mode == contentAlso {
		if err := field("content", r.Content); err != nil {
			return nil, err
		}
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// emitFileList reads r as a newline-delimited list of file paths and emits a
// JSON line for each. Blank lines are skipped; trailing carriage returns are
// trimmed so lists produced on Windows are handled.
func emitFileList(enc *json.Encoder, r io.Reader, mode contentMode) error {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		path := strings.TrimRight(scanner.Text(), "\r")
		if path == "" {
			continue
		}
		if err := emitFile(enc, path, mode); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// emitPath parses the frontmatter of a single argument: "-" reads one document
// from stdin, any other value is treated as a file path.
func emitPath(enc *json.Encoder, stdin io.Reader, path string, mode contentMode) error {
	if path == "-" {
		return emit(enc, stdin, "", mode)
	}
	return emitFile(enc, path, mode)
}

// emitFile parses the frontmatter of the file at path and writes it as a JSON
// line.
func emitFile(enc *json.Encoder, path string, mode contentMode) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return emit(enc, f, path, mode)
}

// emit parses frontmatter from r and encodes it as a single compact JSON line.
// filename names the source for the output's "filename" field and error
// messages; an empty filename denotes stdin. mode selects whether the document
// body is included.
func emit(enc *json.Encoder, r io.Reader, filename string, mode contentMode) error {
	label := filename
	if label == "" {
		label = "<stdin>"
	}
	// Only read the document body when it will actually be emitted; otherwise
	// stop at the closing delimiter so large documents are not loaded.
	parse := frontmatter.Parse
	if mode == contentOnly || mode == contentAlso {
		parse = frontmatter.ParseWithContent
	}
	doc, err := parse(r)
	if err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	return enc.Encode(record{
		Filename:    filename,
		Frontmatter: doc.Frontmatter,
		Content:     doc.Content,
		mode:        mode,
	})
}
