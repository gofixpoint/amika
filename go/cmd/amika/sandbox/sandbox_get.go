package sandboxcmd

import (
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

var sandboxGetCmd = &cobra.Command{
	Use:   "get <rig-ref>",
	Short: "Get a rig by name or ID",
	Long: `Get one rig by name or ID. Text output prints one key: value per line.
Nested objects and arrays use dotted keys and numbered indexes.
The hostname is the rig's DNS name when the API provides it.
JSON output uses the API response schema.`,
	Args: cobra.ExactArgs(1),
	RunE: runSandboxGet,
}

func runSandboxGet(cmd *cobra.Command, args []string) error {
	target, err := getRemoteTarget(cmd)
	if err != nil {
		return err
	}
	if err := runmode.RequireAuth(runmode.DefaultAuthChecker); err != nil {
		return err
	}
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	client, err := getRemoteClient(target)
	if err != nil {
		return err
	}
	rig, err := client.GetSandbox(args[0])
	if err != nil {
		return err
	}
	result := normalizeSandboxJSON(*rig)
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), result)
	}
	return writeSandboxGetText(cmd.OutOrStdout(), result)
}

// writeSandboxGetText renders every field in the API mirror so text output
// remains useful as the response grows. A missing hostname is explicit for
// older API servers that do not yet return the guest's DNS hostname.
func writeSandboxGetText(w io.Writer, rig apiclient.RemoteSandbox) error {
	encoded, err := json.Marshal(rig)
	if err != nil {
		return err
	}
	var values map[string]any
	if err := json.Unmarshal(encoded, &values); err != nil {
		return err
	}
	if _, ok := values["hostname"]; !ok {
		values["hostname"] = nil
	}
	// Lead with identity and status, then print the remaining fields by name.
	for _, key := range []string{"id", "name", "hostname", "status", "setup_status"} {
		if value, ok := values[key]; ok {
			if err := writeSandboxValue(w, key, value); err != nil {
				return err
			}
			delete(values, key)
		}
	}
	for _, key := range slices.Sorted(maps.Keys(values)) {
		if err := writeSandboxValue(w, key, values[key]); err != nil {
			return err
		}
	}
	return nil
}

func writeSandboxValue(w io.Writer, key string, value any) error {
	switch v := value.(type) {
	case map[string]any:
		if len(v) == 0 {
			_, err := fmt.Fprintf(w, "%s: {}\n", key)
			return err
		}
		for _, nested := range slices.Sorted(maps.Keys(v)) {
			if err := writeSandboxValue(w, key+"."+nested, v[nested]); err != nil {
				return err
			}
		}
		return nil
	case []any:
		if len(v) == 0 {
			_, err := fmt.Fprintf(w, "%s: []\n", key)
			return err
		}
		for i, item := range v {
			if err := writeSandboxValue(w, key+"["+strconv.Itoa(i)+"]", item); err != nil {
				return err
			}
		}
		return nil
	case nil:
		_, err := fmt.Fprintf(w, "%s: -\n", key)
		return err
	case string:
		// Escape line breaks so every field remains exactly one output line.
		v = strings.NewReplacer(`\`, `\\`, "\r", `\r`, "\n", `\n`).Replace(v)
		_, err := fmt.Fprintf(w, "%s: %s\n", key, v)
		return err
	default:
		_, err := fmt.Fprintf(w, "%s: %v\n", key, v)
		return err
	}
}
