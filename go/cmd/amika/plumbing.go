package main

import (
	"os/signal"
	"syscall"

	"github.com/gofixpoint/amika/go/internal/amikanet"
	"github.com/gofixpoint/amika/go/internal/apiclient"
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
		// OpenSSH closes this process's stdin and then sends SIGHUP when it
		// exits. Outliving the SIGHUP lets the proxy send GOODBYE on stdin's
		// EOF, so amikad closes sshd at once rather than after its resume
		// grace period. With SIGPIPE ignored, a write to a closed stdout
		// fails instead of killing the process mid-GOODBYE.
		signal.Ignore(syscall.SIGHUP, syscall.SIGPIPE)
		flag, _ := cmd.Flags().GetString("transport")
		transport, err := ssh.ParseProxyTransport(flag)
		if err != nil {
			return err
		}
		paths := basedir.New("")
		// Stderr, not stdout: stdout is the SSH transport, and a byte of
		// diagnostics on it would corrupt the connection it describes.
		pins, err := ssh.PrepareProxy(paths, cmd.ErrOrStderr())
		if err != nil {
			return err
		}
		events, closeEvents := ssh.OpenProxyEventLog(paths)
		defer closeEvents()
		client := runmode.NewRemoteClient()
		// An identity that cannot be read leaves UserID empty, and the
		// registration then fails and is logged: SSH goes over direct_ws.
		userID, _ := apiclient.CredentialIdentity()
		iroh, irohUnavailable, err := ssh.PrepareIrohRoute(ssh.IrohSetup{
			Paths:     paths,
			Account:   amikanet.Account{APIURL: client.BaseURL, UserID: userID},
			Registrar: client,
			Stderr:    cmd.ErrOrStderr(),
		}, transport, events)
		if err != nil {
			return err
		}
		options := ssh.ProxyOptions{Transport: transport, Iroh: iroh, IrohUnavailable: irohUnavailable}
		if verbose, _ := cmd.Flags().GetBool("verbose"); verbose {
			options.Notice = cmd.ErrOrStderr()
		}
		return ssh.ProxySession(
			cmd.Context(),
			client,
			ssh.WebSocketDialer{},
			pins,
			args[0],
			cmd.InOrStdin(),
			cmd.OutOrStdout(),
			events,
			options,
		)
	},
}

func init() {
	rootCmd.AddCommand(plumbingCmd)
	plumbingCmd.AddCommand(sshStdioProxyCmd)
	// Testing only: `amika rig ssh --transport` passes it on.
	sshStdioProxyCmd.Flags().String("transport", "", "use one SSH transport: iroh or direct_ws")
	_ = sshStdioProxyCmd.Flags().MarkHidden("transport")
	// `amika rig ssh -v` passes it on: one stderr line names the transport.
	sshStdioProxyCmd.Flags().Bool("verbose", false, "print the SSH transport on stderr")
	_ = sshStdioProxyCmd.Flags().MarkHidden("verbose")
}
