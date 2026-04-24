package sandboxcmd

// sandbox_update.go implements the sandbox update command.

import (
	"fmt"

	"github.com/gofixpoint/amika/pkg/amika"
	"github.com/spf13/cobra"
)

var sandboxUpdateCmd = &cobra.Command{
	Use:   "update <name>",
	Short: "Update sandbox metadata",
	Long:  `Update metadata for an existing sandbox (rename, TTL, inactivity timeout, auto-delete timeout).`,
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		cmd.SilenceUsage = true

		name := args[0]
		svc := amika.NewService(amika.Options{})

		req := amika.UpdateSandboxRequest{Name: name}
		hasUpdate := false

		if cmd.Flags().Changed("name") {
			newName, _ := cmd.Flags().GetString("name")
			req.NewName = &newName
			hasUpdate = true
		}
		if cmd.Flags().Changed("ttl") {
			ttl, _ := cmd.Flags().GetString("ttl")
			req.TTL = &ttl
			hasUpdate = true
		}
		if cmd.Flags().Changed("inactivity-timeout") {
			timeout, _ := cmd.Flags().GetString("inactivity-timeout")
			req.InactivityTimeout = &timeout
			hasUpdate = true
		}
		if cmd.Flags().Changed("auto-delete-timeout") {
			timeout, _ := cmd.Flags().GetString("auto-delete-timeout")
			req.AutoDeleteTimeout = &timeout
			hasUpdate = true
		}

		if !hasUpdate {
			return fmt.Errorf("no update flags specified; use --name, --ttl, --inactivity-timeout, or --auto-delete-timeout")
		}

		result, err := svc.UpdateSandbox(cmd.Context(), req)
		if err != nil {
			return err
		}

		fmt.Printf("Sandbox %q updated successfully\n", result.Sandbox.Name)
		if req.NewName != nil {
			fmt.Printf("  Renamed to: %s\n", result.Sandbox.Name)
		}
		if req.TTL != nil {
			fmt.Printf("  TTL: %s\n", result.Sandbox.TTL)
		}
		if req.InactivityTimeout != nil {
			fmt.Printf("  Inactivity timeout: %s\n", result.Sandbox.InactivityTimeout)
		}
		if req.AutoDeleteTimeout != nil {
			fmt.Printf("  Auto-delete timeout: %s\n", result.Sandbox.AutoDeleteTimeout)
		}
		return nil
	},
}
