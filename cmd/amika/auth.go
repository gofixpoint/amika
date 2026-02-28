package main

import (
	"fmt"

	"github.com/gofixpoint/amika/internal/auth"
	"github.com/spf13/cobra"
)

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Authentication credential commands",
	Long:  `Discover and transform local credentials for agent and sandbox use.`,
}

var authExtractCmd = &cobra.Command{
	Use:   "extract",
	Short: "Extract discovered credentials as shell environment assignments",
	Long: `Discover local API credentials and print environment assignments.

Examples:
  amika auth extract
  amika auth extract --export
  eval "$(amika auth extract --export)"`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		withExport, _ := cmd.Flags().GetBool("export")
		homeDir, _ := cmd.Flags().GetString("homedir")
		noOAuth, _ := cmd.Flags().GetBool("no-oauth")

		result, err := auth.Discover(auth.Options{
			HomeDir:      homeDir,
			IncludeOAuth: !noOAuth,
		})
		if err != nil {
			return err
		}

		env := auth.BuildEnvMap(result)
		for _, line := range env.Lines(withExport) {
			fmt.Fprintln(cmd.OutOrStdout(), line)
		}
		return nil
	},
}

func init() {
	rootCmd.AddCommand(authCmd)
	authCmd.AddCommand(authExtractCmd)

	authExtractCmd.Flags().Bool("export", false, "Prefix each line with export")
	authExtractCmd.Flags().String("homedir", "", "Override home directory used for credential discovery")
	authExtractCmd.Flags().Bool("no-oauth", false, "Skip OAuth credential sources")
}
