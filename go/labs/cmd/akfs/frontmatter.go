package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/gofixpoint/amika/go/labs/akfs/frontmatter"
	"github.com/spf13/cobra"
)

func init() {
	cmd := &cobra.Command{
		Use:     "frontmatter [file...]",
		Aliases: []string{"fm"},
		Short:   "Parse YAML frontmatter from files or stdin",
		Long: `Parse the YAML frontmatter block from one or more documents and emit
it as JSON.

Each argument is a file path; the special argument "-" reads a single document
from stdin. When no arguments are given, stdin is instead treated as a
newline-delimited list of file paths to process (e.g. piped from "fd" or
"find"). Each document must begin with a "---" delimiter line and close the
frontmatter with a matching "---" line.

Output is one line of compact JSON per document: the parsed frontmatter under a
"data" key, alongside a "filename" key naming the source file (omitted when the
document is read from stdin via "-"). With multiple inputs, one JSON line is
emitted per document, in order.`,
		Args: cobra.ArbitraryArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			enc := json.NewEncoder(cmd.OutOrStdout())
			stdin := cmd.InOrStdin()

			// No arguments: read a newline-delimited list of file paths from
			// stdin and process each. Use "-" as an argument to parse a single
			// document from stdin instead.
			if len(args) == 0 {
				return emitFileList(enc, stdin)
			}
			for _, arg := range args {
				if err := emitPath(enc, stdin, arg); err != nil {
					return err
				}
			}
			return nil
		},
	}

	rootCmd.AddCommand(cmd)
}

// record is the JSON envelope emitted per input: the source filename (omitted
// for stdin) alongside the parsed frontmatter.
type record struct {
	Filename string         `json:"filename,omitempty"`
	Data     map[string]any `json:"data"`
}

// emitFileList reads r as a newline-delimited list of file paths and emits a
// JSON line for each. Blank lines are skipped; trailing carriage returns are
// trimmed so lists produced on Windows are handled.
func emitFileList(enc *json.Encoder, r io.Reader) error {
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		path := strings.TrimRight(scanner.Text(), "\r")
		if path == "" {
			continue
		}
		if err := emitFile(enc, path); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// emitPath parses the frontmatter of a single argument: "-" reads one document
// from stdin, any other value is treated as a file path.
func emitPath(enc *json.Encoder, stdin io.Reader, path string) error {
	if path == "-" {
		return emit(enc, stdin, "")
	}
	return emitFile(enc, path)
}

// emitFile parses the frontmatter of the file at path and writes it as a JSON
// line.
func emitFile(enc *json.Encoder, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return emit(enc, f, path)
}

// emit parses frontmatter from r and encodes it as a single compact JSON line.
// filename names the source for the output's "filename" field and error
// messages; an empty filename denotes stdin.
func emit(enc *json.Encoder, r io.Reader, filename string) error {
	label := filename
	if label == "" {
		label = "<stdin>"
	}
	data, err := frontmatter.Parse(r)
	if err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	return enc.Encode(record{Filename: filename, Data: data})
}
