// Package output resolves the --output flag that selects how a CLI command
// renders its result: human-readable text or machine-readable JSON. The flag
// is registered only on commands that actually implement it (via AddFlag), so
// commands that do not support it reject --output with an unknown-flag error
// rather than silently emitting text.
package output

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Format is the rendering format selected by the --output flag.
type Format int

const (
	// Text renders human-readable output. It is the default.
	Text Format = iota
	// JSON renders machine-readable JSON.
	JSON
)

// String returns the flag value that selects the format.
func (f Format) String() string {
	switch f {
	case Text:
		return "text"
	case JSON:
		return "json"
	default:
		return "unknown"
	}
}

// FlagName is the name of the output-format flag.
const FlagName = "output"

// AddFlag registers the --output/-o flag on a command that implements it.
// Register it only on commands that honor the flag; leaving it off other
// commands makes Cobra reject --output there automatically.
func AddFlag(cmd *cobra.Command) {
	cmd.Flags().StringP(FlagName, "o", "text", "Output format: \"text\" or \"json\"")
}

// Resolve reads the --output flag from cmd and returns the selected Format.
// An unrecognized value is an error.
func Resolve(cmd *cobra.Command) (Format, error) {
	value, _ := cmd.Flags().GetString(FlagName)
	switch value {
	case "", "text":
		return Text, nil
	case "json":
		return JSON, nil
	default:
		return Text, fmt.Errorf("invalid --output value %q: expected \"text\" or \"json\"", value)
	}
}
