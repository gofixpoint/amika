package main

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/internal/auth"
	"github.com/spf13/cobra"
)

const defaultWorkOSClientID = "client_01KHA495MJS1KT6QBRTYJ239DY"

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

var authLoginCmd = &cobra.Command{
	Use:   "login",
	Short: "Log in to Amika via WorkOS",
	Long: `Authenticate with Amika using the WorkOS Device Authorization Flow.
Opens a browser for you to authorize the CLI.`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		clientID := os.Getenv("AMIKA_WORKOS_CLIENT_ID")
		if clientID == "" {
			clientID = defaultWorkOSClientID
		}

		session, err := auth.DeviceLogin(clientID)
		if err != nil {
			return err
		}

		fmt.Fprintf(cmd.OutOrStdout(), "Logged in as %s\n", session.Email)
		return nil
	},
}

var authLogoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out of Amika",
	RunE: func(cmd *cobra.Command, _ []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		if err := auth.DeleteSession(); err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), "Logged out")
		return nil
	},
}

var authStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show current authentication status",
	RunE: func(cmd *cobra.Command, _ []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		session, err := auth.LoadSession()
		if err != nil {
			return err
		}
		if session == nil {
			fmt.Fprintln(cmd.OutOrStdout(), "Not logged in")
			return nil
		}

		fmt.Fprintf(cmd.OutOrStdout(), "Logged in as %s", session.Email)
		if session.OrgID != "" {
			fmt.Fprintf(cmd.OutOrStdout(), " (org: %s)", session.OrgID)
		}
		fmt.Fprintln(cmd.OutOrStdout())
		return nil
	},
}

func init() {
	rootCmd.AddCommand(authCmd)
	authCmd.AddCommand(authExtractCmd)
	authCmd.AddCommand(authLoginCmd)
	authCmd.AddCommand(authLogoutCmd)
	authCmd.AddCommand(authStatusCmd)

	authExtractCmd.Flags().Bool("export", false, "Prefix each line with export")
	authExtractCmd.Flags().String("homedir", "", "Override home directory used for credential discovery")
	authExtractCmd.Flags().Bool("no-oauth", false, "Skip OAuth credential sources")

}
