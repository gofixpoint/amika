package main

import (
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

func runRootCommand(stdin string, args ...string) (string, error) {
	buffer := &strings.Builder{}
	rootCmd.SetOut(buffer)
	rootCmd.SetErr(buffer)
	rootCmd.SetIn(strings.NewReader(stdin))
	rootCmd.SetArgs(args)
	err := rootCmd.Execute()
	rootCmd.SetArgs(nil)
	rootCmd.SetIn(nil)
	resetFlags(rootCmd)
	return buffer.String(), err
}

func resetFlags(command *cobra.Command) {
	reset := func(flags *pflag.FlagSet) {
		flags.VisitAll(func(flag *pflag.Flag) {
			if slice, ok := flag.Value.(pflag.SliceValue); ok {
				_ = slice.Replace(nil)
			} else {
				_ = flag.Value.Set(flag.DefValue)
			}
			flag.Changed = false
		})
	}
	reset(command.Flags())
	for _, child := range command.Commands() {
		resetFlags(child)
	}
}
