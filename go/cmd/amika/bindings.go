package main

import (
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/gofixpoint/amika/go/internal/output"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/spf13/cobra"
)

func newBindCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "bind <sandbox-ref> <target-url>",
		Short: "Bind a sandbox to a GitHub pull request",
		Long: `Bind a remote sandbox to a GitHub pull request URL.

The sandbox may be identified by name or ID. The target must be the URL of a
GitHub pull request that your connected GitHub account can access.`,
		Args: cobra.ExactArgs(2),
		RunE: runBind,
	}
}

func newBindingsCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "bindings",
		Short: "Manage sandbox bindings",
	}
	cmd.AddCommand(newBindingsListCommand())
	cmd.AddCommand(newBindingDeleteCommand("delete <binding-id>", []string{"rm"}))
	return cmd
}

func newBindingsListCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List sandbox bindings",
		Args:  cobra.NoArgs,
		RunE:  runBindingsList,
	}
}

func newBindingDeleteCommand(use string, aliases []string) *cobra.Command {
	return &cobra.Command{
		Use:     use,
		Aliases: aliases,
		Short:   "Delete a sandbox binding by ID",
		Long: `Delete a sandbox binding by its opaque binding ID.

Run "amika bindings list" to find the binding ID. Deleting a binding does not
delete or stop its sandbox.`,
		Args: cobra.ExactArgs(1),
		RunE: runBindingDelete,
	}
}

func runBind(cmd *cobra.Command, args []string) error {
	sandboxRef := strings.TrimSpace(args[0])
	targetURL := strings.TrimSpace(args[1])
	if sandboxRef == "" {
		return fmt.Errorf("sandbox reference is required")
	}
	if targetURL == "" {
		return fmt.Errorf("target URL is required")
	}
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
		return err
	}
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}

	response, err := runmode.NewRemoteClient().CreateSandboxBinding(sandboxRef, targetURL)
	if err != nil {
		return err
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), response)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Created binding %s\n", response.ID)
	return nil
}

func runBindingsList(cmd *cobra.Command, _ []string) error {
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
		return err
	}
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}

	response, err := runmode.NewRemoteClient().ListSandboxBindings()
	if err != nil {
		return err
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), response)
	}
	if len(response.Items) == 0 {
		fmt.Fprintln(cmd.OutOrStdout(), "No sandbox bindings found.")
		return nil
	}

	w := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tSANDBOX\tTYPE\tTARGET\tRELATIONSHIP\tCREATED")
	for _, binding := range response.Items {
		fmt.Fprintf(
			w,
			"%s\t%s\t%s/%s\t%s\t%s\t%s\n",
			binding.ID,
			binding.SandboxID,
			binding.TargetNamespace,
			binding.TargetKind,
			binding.TargetURL,
			binding.Relationship,
			binding.CreatedAt,
		)
	}
	return w.Flush()
}

func runBindingDelete(cmd *cobra.Command, args []string) error {
	bindingID := strings.TrimSpace(args[0])
	if bindingID == "" {
		return fmt.Errorf("binding ID is required")
	}
	if err := runmode.RequireAuth(runmode.Remote, runmode.DefaultAuthChecker); err != nil {
		return err
	}
	format, err := output.FormatFrom(cmd)
	if err != nil {
		return err
	}
	if err := runmode.NewRemoteClient().DeleteSandboxBinding(bindingID); err != nil {
		return err
	}
	if format.IsJSON() {
		return format.JSON(cmd.OutOrStdout(), output.ItemResult{Name: bindingID, Status: "deleted"})
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Deleted binding %s\n", bindingID)
	return nil
}

func init() {
	rootCmd.AddCommand(newBindCommand())
	rootCmd.AddCommand(newBindingsCommand())
	rootCmd.AddCommand(newBindingDeleteCommand("unbind <binding-id>", nil))
}
