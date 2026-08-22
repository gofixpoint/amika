package main

import (
	"fmt"
	"os"

	policy "github.com/gofixpoint/amika/go/labs/amikalyze"
	"github.com/spf13/cobra"
)

var hooksCmd = &cobra.Command{
	Use:   "hooks",
	Short: "Manage coding-agent hooks",
}

var hooksInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Install amikalyze hooks for selected agents",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		agents, err := selectedAgents(cmd)
		if err != nil {
			return err
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolving home directory: %w", err)
		}
		command, err := policy.DefaultHookCommand()
		if err != nil {
			return err
		}
		reports, err := policy.InstallHooks(home, agents, command)
		if err != nil {
			return err
		}
		for _, report := range reports {
			if report.Updated {
				fmt.Fprintf(cmd.OutOrStdout(), "Installed %s hook in %s\n", report.Agent, report.Path)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "%s hook already present in %s\n", report.Agent, report.Path)
			}
			if report.Agent == policy.AgentCodex {
				fmt.Fprintln(cmd.OutOrStdout(), "Review and trust the Codex hook with /hooks before using it.")
			}
		}
		return nil
	},
}

var hooksUninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove amikalyze hooks for selected agents",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		agents, err := selectedAgents(cmd)
		if err != nil {
			return err
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolving home directory: %w", err)
		}
		reports, err := policy.UninstallHooks(home, agents)
		if err != nil {
			return err
		}
		for _, report := range reports {
			if report.Updated {
				fmt.Fprintf(cmd.OutOrStdout(), "Removed %s hook from %s\n", report.Agent, report.Path)
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "No %s hook found in %s\n", report.Agent, report.Path)
			}
		}
		return nil
	},
}

func selectedAgents(cmd *cobra.Command) ([]policy.Agent, error) {
	values, err := cmd.Flags().GetStringArray("agent")
	if err != nil {
		return nil, err
	}
	if len(values) == 0 {
		return nil, errorsNewAgentRequired()
	}
	agents := make([]policy.Agent, 0, len(values))
	for _, value := range values {
		agent := policy.Agent(value)
		if agent != policy.AgentClaude && agent != policy.AgentCodex {
			return nil, fmt.Errorf("unsupported --agent %q (want claude or codex)", value)
		}
		agents = append(agents, agent)
	}
	return agents, nil
}

func errorsNewAgentRequired() error {
	return fmt.Errorf("at least one --agent is required (claude or codex)")
}

func init() {
	rootCmd.AddCommand(hooksCmd)
	hooksCmd.AddCommand(hooksInstallCmd, hooksUninstallCmd)
	for _, command := range []*cobra.Command{hooksInstallCmd, hooksUninstallCmd} {
		command.Flags().StringArray("agent", nil, "Agent to configure; repeat for multiple agents (claude|codex)")
	}
}
