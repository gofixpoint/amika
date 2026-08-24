package main

import scpcmd "github.com/gofixpoint/amika/go/cmd/amika/scp"

func init() {
	// `scp` runs over the direct WebSocket transport and also answers to its
	// pre-promotion name `scpv2` as a Cobra alias. `scpv1` is its
	// provider-native predecessor, registered but hidden so existing scripts
	// keep working.
	rootCmd.AddCommand(scpcmd.NewV2())
	rootCmd.AddCommand(scpcmd.NewV1())
}
