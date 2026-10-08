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
	"github.com/gofixpoint/amika/go/internal/rigself"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

var sandboxGetCmd = &cobra.Command{
	Use:   "get <rig-ref>",
	Short: "Get a rig by name or ID",
	Long: `Get one rig by name or ID. Text output prints one key: value per line.
Nested objects and arrays use dotted keys and numbered indexes.

hostname is the rig's DNS name, when the API provides it. ssh_host is the
rig's SSH alias from ~/.ssh/amika.conf (ending in .amika, not resolvable
through DNS), usable with ssh, scp, or an editor's Remote-SSH.
JSON output uses the API response schema plus ssh_host.`,
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
	name, err := rigself.Resolve(args[0])
	if err != nil {
		return err
	}
	rig, err := client.GetSandbox(name)
	if err != nil {
		return err
	}
	result := sandboxGetResult{
		RemoteSandbox: normalizeSandboxJSON(*rig),
		SSHHost:       sandboxSSHHost(*rig),
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), result)
	}
	return writeSandboxGetText(cmd.OutOrStdout(), result)
}

// sandboxGetResult is the API's GetSandboxResponse plus ssh_host, which the
// CLI derives because the alias embeds a slug of its own AMIKA_API_URL.
type sandboxGetResult struct {
	apiclient.RemoteSandbox
	SSHHost *string `json:"ssh_host"`
}

// sandboxSSHHost returns the alias `rig ssh` connects to without preparing a
// session, or nil when the rig's name cannot form one.
func sandboxSSHHost(rig apiclient.RemoteSandbox) *string {
	alias, err := ssh.SessionAlias(rig.Name, rig.ID)
	if err != nil {
		return nil
	}
	return &alias
}

// writeSandboxGetText renders every field in the result so text output
// remains useful as the response grows. A missing hostname is explicit for
// older API servers that do not yet return the guest's DNS hostname.
func writeSandboxGetText(w io.Writer, rig sandboxGetResult) error {
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
	for _, key := range []string{"id", "name", "hostname", "ssh_host", "status", "setup_status"} {
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
