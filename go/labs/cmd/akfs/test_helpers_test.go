package main

import (
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// runRootCommand executes the akfs root command in-process with the given args,
// capturing stdout and stderr. It mirrors the amika CLI test harness: the
// command is driven through rootCmd.Execute() so real flag parsing, subcommand
// routing, and alias resolution are exercised.
func runRootCommand(args ...string) (string, error) {
	return runRootCommandWithStdin("", args...)
}

// runRootCommandWithStdin is runRootCommand with stdin wired to the given
// string. Stdin reaches subcommands via cmd.InOrStdin().
func runRootCommandWithStdin(stdin string, args ...string) (string, error) {
	buf := &strings.Builder{}
	rootCmd.SetOut(buf)
	rootCmd.SetErr(buf)
	rootCmd.SetIn(strings.NewReader(stdin))
	rootCmd.SetArgs(args)
	err := rootCmd.Execute()
	rootCmd.SetArgs(nil)
	rootCmd.SetIn(nil)
	// rootCmd is a shared global, so flag values parsed during this run would
	// otherwise leak into the next. Reset every command's flags to their
	// defaults to keep invocations isolated.
	resetFlags(rootCmd)
	return buf.String(), err
}

// resetFlags restores every flag of cmd and its subcommands to its default
// value, undoing any values set by a prior Execute on the shared root command.
func resetFlags(cmd *cobra.Command) {
	reset := func(fs *pflag.FlagSet) {
		fs.VisitAll(func(f *pflag.Flag) {
			_ = f.Value.Set(f.DefValue)
			f.Changed = false
		})
	}
	reset(cmd.Flags())
	for _, sub := range cmd.Commands() {
		resetFlags(sub)
	}
}
