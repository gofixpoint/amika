package main

import sandboxcmd "github.com/gofixpoint/amika/cmd/amika/sandbox"

func init() {
	rootCmd.AddCommand(sandboxcmd.New())
}
