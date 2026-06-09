package main

import "strings"

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
	return buf.String(), err
}
