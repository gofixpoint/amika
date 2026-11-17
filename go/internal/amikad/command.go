// Package amikad defines the sandbox daemon command surface.
package amikad

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/gofixpoint/amika/go/internal/amikad/norelay"
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
	// MaxConnections bounds concurrent no-relay bridge sessions. Values <= 0
	// fall back to norelay.DefaultMaxConnections (see norelay.NewHandler).
	MaxConnections int
}

// SetupSSHDOptions controls whether managed setup may replace an existing
// user-defined sshd configuration.
type SetupSSHDOptions struct {
	ForceOverwrite bool
}

// BootstrapOptions selects the rig user `amikad bootstrap` sets up.
type BootstrapOptions struct {
	// Home is the home directory for the amika user when bootstrap creates
	// it.
	Home string
	// Log receives progress lines.
	Log io.Writer
}

// InstallOptions selects what `amikad install` installs and how.
type InstallOptions struct {
	// Lockfile is the lockfile's path; "-" reads standard input.
	Lockfile string
	// Deps adds dependencies to the defaults; Without removes defaults.
	Deps    []string
	Without []string
	// Background returns at once and installs in a detached process that
	// logs to /var/log/amikad/install.log.
	Background bool
	// DeleteLockfile removes Lockfile once read; set for the detached
	// process, whose lockfile is a copy.
	DeleteLockfile bool
	// Out receives one JSON timing line per dependency; Log, progress text.
	Out io.Writer
	Log io.Writer
}

// WaitReadyOptions selects the listener `amikad wait-ready` polls.
type WaitReadyOptions struct {
	Port    int
	Timeout time.Duration
}

// Operations is the command layer's sandbox-interior boundary.
type Operations interface {
	SetupSSHD(context.Context, SetupSSHDOptions) error
	ShowHostKey(context.Context, io.Writer) error
	SetAuthorizedKeys(context.Context, io.Reader) error
	ClearAuthorizedKeys(context.Context) error
	SetConnectToken(context.Context, io.Reader) error
	Serve(context.Context, ServeOptions) error
	Bootstrap(context.Context, BootstrapOptions) error
	InstallToolchain(context.Context, InstallOptions, io.Reader) error
	WaitReady(context.Context, WaitReadyOptions) error
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

// ClearAuthorizedKeys returns ErrNotImplemented without writing keys.
func (UnimplementedOperations) ClearAuthorizedKeys(context.Context) error {
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

// Bootstrap returns ErrNotImplemented without changing the machine.
func (UnimplementedOperations) Bootstrap(context.Context, BootstrapOptions) error {
	return ErrNotImplemented
}

// InstallToolchain returns ErrNotImplemented without reading the lockfile.
func (UnimplementedOperations) InstallToolchain(context.Context, InstallOptions, io.Reader) error {
	return ErrNotImplemented
}

// WaitReady returns ErrNotImplemented without polling.
func (UnimplementedOperations) WaitReady(context.Context, WaitReadyOptions) error {
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
	authorizedKeys.AddCommand(&cobra.Command{
		Use:   "clear",
		Short: "Install an empty authorized-key set (authorize no logins)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return operations.ClearAuthorizedKeys(cmd.Context())
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
	serve.Flags().IntVar(
		&serveOptions.MaxConnections,
		"max-connections",
		norelay.DefaultMaxConnections,
		"maximum concurrent no-relay bridge sessions",
	)

	root.AddCommand(setup, hostKey, authorizedKeys, connectToken, serve,
		newBootstrapCommand(operations),
		newInstallCommand(operations),
		newWaitReadyCommand(operations),
	)
	return root
}

// newBootstrapCommand installs the Amika runtime on a rig that booted the
// provider's own image.
func newBootstrapCommand(operations Operations) *cobra.Command {
	options := BootstrapOptions{}
	command := &cobra.Command{
		Use:   "bootstrap",
		Short: "Install the Amika runtime on a machine without an Amika image",
		Long: "Install what an Amika base image ships for amikad and the lifecycle\n" +
			"hooks: sudo, the amika user and its sudo rule, the directories, and the\n" +
			"hooks. Run it as root. It is idempotent.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			options.Log = cmd.ErrOrStderr()
			return operations.Bootstrap(cmd.Context(), options)
		},
	}
	command.Flags().StringVar(&options.Home, "home", "", "home directory for the amika user when it must be created (default /home/amika)")
	return command
}

// newInstallCommand installs dependencies from the toolchain lockfile.
func newInstallCommand(operations Operations) *cobra.Command {
	options := InstallOptions{}
	command := &cobra.Command{
		Use:   "install",
		Short: "Install a rig's dependencies from the toolchain lockfile",
		Long: "Install the default dependencies (OpenSSH server when the image has\n" +
			"no sshd, and gh) plus each --dep, minus each --without, from a toolchain\n" +
			"lockfile. Downloads are checked against the lockfile's sha256 and\n" +
			"unpacked under /opt/amika; commands are linked onto PATH. A dependency\n" +
			"already at its pinned version is skipped. Prints one JSON timing line\n" +
			"per dependency. Run it as root.",
		Example: "  amikad install --lockfile /var/lib/amikad/toolchain.lock.json\n" +
			"  amikad install --dep opencode --dep pi-web < toolchain.lock.json\n" +
			"  amikad install --without gh --background < toolchain.lock.json",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			options.Out = cmd.OutOrStdout()
			options.Log = cmd.ErrOrStderr()
			return operations.InstallToolchain(cmd.Context(), options, cmd.InOrStdin())
		},
	}
	flags := command.Flags()
	flags.StringVar(&options.Lockfile, "lockfile", "-", "path of the toolchain lockfile; - reads standard input")
	flags.StringArrayVar(&options.Deps, "dep", nil, "also install this dependency (repeatable)")
	flags.StringArrayVar(&options.Without, "without", nil, "skip this default dependency (repeatable)")
	flags.BoolVar(&options.Background, "background", false, "return at once and install in the background")
	flags.BoolVar(&options.DeleteLockfile, "delete-lockfile", false, "remove the lockfile once read")
	_ = flags.MarkHidden("delete-lockfile")
	return command
}

// newWaitReadyCommand waits for a started amikad to answer.
func newWaitReadyCommand(operations Operations) *cobra.Command {
	options := WaitReadyOptions{}
	command := &cobra.Command{
		Use:   "wait-ready",
		Short: "Wait until amikad serve answers on its port",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return operations.WaitReady(cmd.Context(), options)
		},
	}
	command.Flags().IntVar(&options.Port, "port", DefaultPort, "the port amikad serve was given")
	command.Flags().DurationVar(&options.Timeout, "timeout", 10*time.Second, "how long to wait")
	return command
}
