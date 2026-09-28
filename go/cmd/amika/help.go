package main

// help.go customizes the Cobra usage template to show command aliases in the
// Available Commands list.

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

func init() {
	rootCmd.SetHelpCommand(newHelpCommand())
	cobra.AddTemplateFunc("cmdAliasesStr", func(cmd *cobra.Command) string {
		if len(cmd.Aliases) == 0 {
			return ""
		}
		return " (aliases: " + strings.Join(cmd.Aliases, ", ") + ")"
	})

	// Modified from cobra's defaultUsageTemplate: each subcommand's Short
	// description is followed by its aliases (if any).
	rootCmd.SetUsageTemplate(`Usage:{{if .Runnable}}
  {{.UseLine}}{{end}}{{if .HasAvailableSubCommands}}
  {{.CommandPath}} [command]{{end}}{{if gt (len .Aliases) 0}}

Aliases:
  {{.NameAndAliases}}{{end}}{{if .HasExample}}

Examples:
{{.Example}}{{end}}{{if .HasAvailableSubCommands}}{{$cmds := .Commands}}{{if eq (len .Groups) 0}}

Available Commands:{{range $cmds}}{{if (or .IsAvailableCommand (eq .Name "help"))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{cmdAliasesStr .}}{{end}}{{end}}{{else}}{{range $group := .Groups}}

{{.Title}}{{range $cmds}}{{if (and (eq .GroupID $group.ID) (or .IsAvailableCommand (eq .Name "help")))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{cmdAliasesStr .}}{{end}}{{end}}{{end}}{{if not .AllChildCommandsHaveGroup}}

Additional Commands:{{range $cmds}}{{if (and (eq .GroupID "") (or .IsAvailableCommand (eq .Name "help")))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{cmdAliasesStr .}}{{end}}{{end}}{{end}}{{end}}{{end}}{{if .HasAvailableLocalFlags}}

Flags:
{{.LocalFlags.FlagUsages | trimTrailingWhitespaces}}{{end}}{{if .HasAvailableInheritedFlags}}

Global Flags:
{{.InheritedFlags.FlagUsages | trimTrailingWhitespaces}}{{end}}{{if .HasHelpSubCommands}}

Additional help topics:{{range .Commands}}{{if .IsAdditionalHelpTopicCommand}}
  {{rpad .CommandPath .CommandPathPadding}} {{.Short}}{{end}}{{end}}{{end}}{{if .HasAvailableSubCommands}}

Use "{{.CommandPath}} [command] --help" for more information about a command.{{end}}
`)
}

func newHelpCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "help [command]",
		Short: "Help about any command",
		Long:  "Show help for a command. Use --all (-a) to include hidden commands.",
		ValidArgsFunction: func(cmd *cobra.Command, args []string, prefix string) ([]string, cobra.ShellCompDirective) {
			target, _, err := cmd.Root().Find(args)
			if err != nil {
				return nil, cobra.ShellCompDirectiveNoFileComp
			}
			all, _ := cmd.Flags().GetBool("all")
			var matches []string
			for _, child := range target.Commands() {
				if (all || child.IsAvailableCommand() || child.Name() == "help") && strings.HasPrefix(child.Name(), prefix) {
					matches = append(matches, child.Name()+"\t"+child.Short)
				}
			}
			return matches, cobra.ShellCompDirectiveNoFileComp
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			target, remaining, err := cmd.Root().Find(args)
			if err != nil {
				return err
			}
			if len(remaining) != 0 {
				return fmt.Errorf("unknown help topic %q", strings.Join(args, " "))
			}
			all, _ := cmd.Flags().GetBool("all")
			if all {
				var hidden []*cobra.Command
				var reveal func(*cobra.Command)
				reveal = func(parent *cobra.Command) {
					for _, child := range parent.Commands() {
						if child.Hidden {
							hidden = append(hidden, child)
							child.Hidden = false
						}
						reveal(child)
					}
				}
				reveal(cmd.Root())
				defer func() {
					for _, child := range hidden {
						child.Hidden = true
					}
				}()
			}
			target.InitDefaultHelpFlag()
			target.InitDefaultVersionFlag()
			target.SetContext(cmd.Context())
			return target.Help()
		},
	}
	cmd.Flags().BoolP("all", "a", false, "Include hidden commands")
	return cmd
}
