package main

import scpcmd "github.com/gofixpoint/amika/go/cmd/amika/scp"

func init() {
	rootCmd.AddCommand(scpcmd.New())
}
