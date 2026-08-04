// Package amikad defines the sandbox daemon command surface.
package amikad

import (
	"context"
	"errors"
	"io"

	"github.com/gofixpoint/amika/go/internal/buildmeta"
	"github.com/spf13/cobra"
)

// DefaultPort is the single reserved HTTP port used by amikad.
const DefaultPort = 60999

// ErrNotImplemented marks fail-closed daemon operations whose implementation
// has not landed yet.
var ErrNotImplemented = errors.New("amikad operation is not implemented")

// ServeOptions selects the daemon transports and listen port.
type ServeOptions struct {
	Port        int
	BetaNoRelay bool
	Background  bool
}

// SetupSSHDOptions controls whether managed setup may replace an existing
// user-defined sshd configuration.
type SetupSSHDOptions struct {
	ForceOverwrite bool
}

// Operations is the command layer's sandbox-interior boundary.
type Operations interface {
	SetupSSHD(context.Context, SetupSSHDOptions) error
	ShowHostKey(context.Context, io.Writer) error
	SetAuthorizedKeys(context.Context, io.Reader) error
	SetConnectToken(context.Context, io.Reader) error
	Serve(context.Context, ServeOptions) error
}

// UnimplementedOperations is a fail-closed Operations implementation. It does
// not read command input, write output, mutate files, or open listeners.
type UnimplementedOperations struct{}

// SetupSSHD returns ErrNotImplemented without changing sshd state.
func (UnimplementedOperations) SetupSSHD(context.Context, SetupSSHDOptions) error {
	return ErrNotImplemented
}

// ShowHostKey returns ErrNotImplemented without writing key material.
func (UnimplementedOperations) ShowHostKey(context.Context, io.Writer) error {
	return ErrNotImplemented
}

// SetAuthorizedKeys returns ErrNotImplemented without reading or writing keys.
func (UnimplementedOperations) SetAuthorizedKeys(context.Context, io.Reader) error {
	return ErrNotImplemented
}

// SetConnectToken returns ErrNotImplemented without reading or writing a token.
func (UnimplementedOperations) SetConnectToken(context.Context, io.Reader) error {
	return ErrNotImplemented
}

// Serve returns ErrNotImplemented without opening a listener.
func (UnimplementedOperations) Serve(context.Context, ServeOptions) error {
	return ErrNotImplemented
}

// NewCommand builds the amikad command tree around an injectable Operations
// boundary.
func NewCommand(operations Operations) *cobra.Command {
	root := &cobra.Command{
		Use:           "amikad",
		Short:         "Run the Amika sandbox daemon",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       buildmeta.New("amikad", buildmeta.AmikadVersion).String(),
	}

	setup := &cobra.Command{Use: "setup", Short: "Configure sandbox services"}
	setupSSHDOptions := SetupSSHDOptions{}
	setupSSHD := &cobra.Command{
		Use:   "sshd",
		Short: "Configure loopback-only OpenSSH",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return operations.SetupSSHD(cmd.Context(), setupSSHDOptions)
		},
	}
	setupSSHD.Flags().BoolVar(
		&setupSSHDOptions.ForceOverwrite,
		"force-overwrite",
		false,
		"replace an existing user-defined sshd configuration",
	)
	setup.AddCommand(setupSSHD)

	hostKey := &cobra.Command{Use: "host-key", Short: "Manage the SSH host key"}
	hostKey.AddCommand(&cobra.Command{
		Use:   "show",
		Short: "Print the SSH host public key",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return operations.ShowHostKey(cmd.Context(), cmd.OutOrStdout())
		},
	})

	authorizedKeys := &cobra.Command{
		Use:   "authorized-keys",
		Short: "Manage authorized SSH public keys",
	}
	authorizedKeys.AddCommand(&cobra.Command{
		Use:   "set",
		Short: "Replace authorized keys from standard input",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return operations.SetAuthorizedKeys(cmd.Context(), cmd.InOrStdin())
		},
	})

	connectToken := &cobra.Command{
		Use:   "connect-token",
		Short: "Manage the no-relay connection token",
	}
	connectToken.AddCommand(&cobra.Command{
		Use:   "set",
		Short: "Replace the connection token from standard input",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return operations.SetConnectToken(cmd.Context(), cmd.InOrStdin())
		},
	})

	serveOptions := ServeOptions{Port: DefaultPort}
	serve := &cobra.Command{
		Use:   "serve",
		Short: "Serve the amikad HTTP API",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return operations.Serve(cmd.Context(), serveOptions)
		},
	}
	serve.Flags().IntVar(&serveOptions.Port, "port", DefaultPort, "HTTP listen port")
	serve.Flags().BoolVar(
		&serveOptions.BetaNoRelay,
		"beta-no-relay",
		false,
		"enable the unstable no-relay WebSocket SSH transport",
	)
	serve.Flags().BoolVar(
		&serveOptions.Background,
		"bg",
		false,
		"start in the background and wait until healthy",
	)

	root.AddCommand(setup, hostKey, authorizedKeys, connectToken, serve)
	return root
}
