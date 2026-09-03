package main

import (
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
)

var plumbingCmd = &cobra.Command{
	Use:    "plumbing",
	Short:  "Internal machine-facing commands",
	Hidden: true,
}

var sshStdioProxyCmd = &cobra.Command{
	Use:   "ssh-stdio-proxy <host>",
	Short: "Proxy standard IO to one SSH transport",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		pins, err := ssh.SessionPinStore(basedir.New(""))
		if err != nil {
			return err
		}
		return ssh.ProxySession(
			cmd.Context(),
			runmode.NewRemoteClient(),
			ssh.WebSocketDialer{},
			pins,
			args[0],
			cmd.InOrStdin(),
			cmd.OutOrStdout(),
		)
	},
}

func init() {
	rootCmd.AddCommand(plumbingCmd)
	plumbingCmd.AddCommand(sshStdioProxyCmd)
}
