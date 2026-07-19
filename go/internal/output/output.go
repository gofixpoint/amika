// Package output centralizes CLI output formatting so commands can render
// their results as human-readable text or as JSON in a consistent way across
// the whole command tree.
package output

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"
)

// ItemResult is the JSON outcome of one item in a batch mutating command
// (start, stop, delete). Status is a short verb like "started" or "deleted";
// Error holds the failure message and is empty on success.
type ItemResult struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// Format identifies how a command renders its result.
type Format string

const (
	// FormatText renders human-readable text and is the default.
	FormatText Format = "text"
	// FormatJSON renders compact, single-line JSON suitable for piping into
	// tools like jq.
	FormatJSON Format = "json"
	// FormatJSONPretty renders indented, multi-line JSON for humans.
	FormatJSONPretty Format = "json-pretty"
)

// FlagName is the name of the persistent flag that selects the output format.
const FlagName = "output"

// flagShorthand is the single-letter alias for FlagName.
const flagShorthand = "o"

// ValidValues returns the accepted --output values in display order.
func ValidValues() []string {
	return []string{string(FormatText), string(FormatJSON), string(FormatJSONPretty)}
}

// ParseFormat validates a raw flag value and returns the corresponding Format.
func ParseFormat(raw string) (Format, error) {
	switch Format(raw) {
	case FormatText, FormatJSON, FormatJSONPretty:
		return Format(raw), nil
	default:
		return "", fmt.Errorf("invalid --%s value %q: must be one of %s", FlagName, raw, strings.Join(ValidValues(), ", "))
	}
}

// AddFlag registers the persistent --output/-o flag on cmd. Registering it on
// the root command makes every subcommand inherit it.
func AddFlag(cmd *cobra.Command) {
	cmd.PersistentFlags().StringP(
		FlagName,
		flagShorthand,
		string(FormatText),
		fmt.Sprintf("Output format: %s", strings.Join(ValidValues(), ", ")),
	)
}

// FormatFrom reads and validates the output format from a command's flags. If
// the flag is not registered (e.g. in a unit test that builds a bare command),
// it returns FormatText.
func FormatFrom(cmd *cobra.Command) (Format, error) {
	raw, err := cmd.Flags().GetString(FlagName)
	if err != nil {
		return FormatText, nil
	}
	return ParseFormat(raw)
}

// RejectFlag returns an error if --output was explicitly set. Use it for
// commands that delegate to an underlying shell utility (ssh, scp) which
// streams its own output and cannot emit a structured JSON result, so the flag
// would be meaningless or misleading.
func RejectFlag(cmd *cobra.Command) error {
	if cmd.Flags().Changed(FlagName) {
		return fmt.Errorf("the --%s flag is not supported by this command: it runs an underlying shell utility (ssh/scp) that streams its own output and cannot emit JSON", FlagName)
	}
	return nil
}

// IsJSON reports whether the format is one of the JSON variants.
func (f Format) IsJSON() bool {
	return f == FormatJSON || f == FormatJSONPretty
}

// Progress returns the writer to use for human-readable progress messages,
// banners, and confirmation-free status lines. In JSON modes it returns
// io.Discard so these never corrupt the single JSON value written to stdout;
// in text mode it returns w unchanged (typically cmd.OutOrStdout()).
func (f Format) Progress(w io.Writer) io.Writer {
	if f.IsJSON() {
		return io.Discard
	}
	return w
}

// JSON writes value as JSON to w according to the format: compact for
// FormatJSON and indented for FormatJSONPretty. Output is terminated with a
// trailing newline. HTML escaping is disabled so URLs and shell-friendly
// characters render literally.
func (f Format) JSON(w io.Writer, value any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if f == FormatJSONPretty {
		enc.SetIndent("", "  ")
	}
	return enc.Encode(value)
}
