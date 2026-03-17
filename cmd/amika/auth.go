package main

import (
	"fmt"

	"github.com/gofixpoint/amika/internal/amikaconfig"
	"github.com/gofixpoint/amika/internal/auth"
	"github.com/spf13/cobra"
)

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Authentication credential commands",
	Long:  `Discover and transform local credentials for agent and sandbox use.`,
}

var authLoginCmd = &cobra.Command{
	Use:   "login",
	Short: "Log in to Amika via WorkOS",
	Long: `Authenticate with Amika using the WorkOS Device Authorization Flow.
Opens a browser for you to authorize the CLI.`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true

		clientID, err := amikaconfig.EffectiveAuthClientIDForDir("")
		if err != nil {
			return err
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
	authCmd.AddCommand(authLoginCmd)
	authCmd.AddCommand(authLogoutCmd)
	authCmd.AddCommand(authStatusCmd)

}
