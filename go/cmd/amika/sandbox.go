package main

import sandboxcmd "github.com/gofixpoint/amika/go/cmd/amika/sandbox"

func init() {
	rig := sandboxcmd.New()
	rig.AddCommand(newRigAgentSendCommand())
	rootCmd.AddCommand(rig)
}
