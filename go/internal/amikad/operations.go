package amikad

// SetConnectToken (below) is the sandbox-side write half of the no-relay
// connect-token system that norelay.FileTokenVerifier (norelay/token.go)
// verifies. Round trip, briefly:
//
//   - The control plane generates a fresh 32-byte token on every
//     start/resume, keeps a SHA-256 hash of it (plus a Vault-encrypted copy)
//     in its own database, and delivers the plaintext here over the
//     provider's exec/stdin channel by running `amikad connect-token set`.
//   - SetConnectToken validates the token is canonical (see
//     norelay.IsCanonicalToken) and writes it at 0600 through the
//     scrub-registered SensitiveStore, so it is both fail-closed on bad input
//     and covered by the snapshot-scrubbing manifest.
//   - Serve refuses to start the bridge at all unless a valid token is
//     already on disk (verifier.Ready()); once serving, every WebSocket
//     upgrade re-reads the file, so a later rotation takes effect without a
//     restart.
//
// See the ssh-relay repo's specs/019-sandbox-ssh-stream-relay.d/
// no-relay-websocket-ssh.md ("Connection flow" / "Resolved decisions") for
// the control-plane side: generation, hashing, and per-start rotation.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/gofixpoint/amika/go/internal/amikad/norelay"
	"github.com/gofixpoint/amika/go/internal/amikad/sshd"
	"github.com/gofixpoint/amika/go/internal/amikad/state"
)

const (
	defaultManifestPath = "/var/lib/amikad/injected-paths.json"
	defaultTokenPath    = "/var/lib/amikad/connect-token"
	defaultServeLogPath = "/var/log/amikad/no-relay.log"
)

// ErrNoServeMode marks a serve invocation with no explicitly enabled
// transport.
var ErrNoServeMode = errors.New("no amikad serve mode enabled")

// ErrUnsafeConnectToken marks missing, malformed, or unsafe token state.
var ErrUnsafeConnectToken = errors.New("connect token is missing or unsafe")

// SSHDManager is the daemon operation boundary implemented by package sshd.
type SSHDManager interface {
	Setup(context.Context, sshd.SetupOptions) error
	ShowHostKey(context.Context, io.Writer) error
	SetAuthorizedKeys(context.Context, io.Reader) error
	ClearAuthorizedKeys(context.Context) error
	Serve(context.Context) error
	// LoopbackAddress is the managed sshd's listen address, which the bridge
	// dials. Sourced from the manager so the two can never disagree.
	LoopbackAddress() string
}

// DaemonOperations implements the amikad command surface.
type DaemonOperations struct {
	sshd      SSHDManager
	store     state.SensitiveStore
	verifier  *norelay.FileTokenVerifier
	tokenPath string
	logger    *slog.Logger
}

// NewDaemonOperations creates a command implementation around explicit
// security-sensitive dependencies.
func NewDaemonOperations(
	sshdManager SSHDManager,
	store state.SensitiveStore,
	verifier *norelay.FileTokenVerifier,
	tokenPath string,
	logger *slog.Logger,
) *DaemonOperations {
	return &DaemonOperations{
		sshd: sshdManager, store: store, verifier: verifier, tokenPath: tokenPath, logger: logger,
	}
}

// NewProductionOperations wires amikad to the host filesystem and image
// OpenSSH binaries.
func NewProductionOperations() *DaemonOperations {
	files := state.OSFiles{}
	store := state.NewStore(defaultManifestPath, files)
	manager := sshd.NewManager(
		sshd.DefaultPaths(),
		store,
		files,
		sshd.Ed25519KeyGenerator{},
		sshd.ExecProcessRunner{},
	)
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	return NewDaemonOperations(
		manager,
		store,
		norelay.NewFileTokenVerifier(defaultTokenPath, files),
		defaultTokenPath,
		logger,
	)
}

// SetupSSHD installs the managed OpenSSH policy.
func (o *DaemonOperations) SetupSSHD(ctx context.Context, options SetupSSHDOptions) error {
	return o.sshd.Setup(ctx, sshd.SetupOptions{ForceOverwrite: options.ForceOverwrite})
}

// ShowHostKey prints only the canonical public host key.
func (o *DaemonOperations) ShowHostKey(ctx context.Context, output io.Writer) error {
	return o.sshd.ShowHostKey(ctx, output)
}

// SetAuthorizedKeys validates and replaces the complete authorized key set.
func (o *DaemonOperations) SetAuthorizedKeys(ctx context.Context, input io.Reader) error {
	return o.sshd.SetAuthorizedKeys(ctx, input)
}

// ClearAuthorizedKeys installs an empty authorized-key set so sshd can serve
// while authorizing no logins.
func (o *DaemonOperations) ClearAuthorizedKeys(ctx context.Context) error {
	return o.sshd.ClearAuthorizedKeys(ctx)
}

// SetConnectToken validates canonical base64url input and stores it without a
// trailing newline through the scrub-registered sensitive store.
func (o *DaemonOperations) SetConnectToken(ctx context.Context, input io.Reader) error {
	contents, err := io.ReadAll(io.LimitReader(input, 129))
	if err != nil {
		return err
	}
	if len(contents) > 128 {
		return ErrUnsafeConnectToken
	}
	token := strings.TrimSuffix(string(contents), "\n")
	token = strings.TrimSuffix(token, "\r")
	if !norelay.IsCanonicalToken(token) {
		return ErrUnsafeConnectToken
	}
	return o.store.WriteAndRegister(ctx, o.tokenPath, strings.NewReader(token), 0o600)
}

// Serve runs the no-relay HTTP bridge and the loopback OpenSSH child until
// either fails or ctx is cancelled.
func (o *DaemonOperations) Serve(ctx context.Context, options ServeOptions) error {
	if !options.BetaNoRelay {
		return ErrNoServeMode
	}
	if options.Port < 1 || options.Port > 65535 {
		return fmt.Errorf("invalid HTTP listen port %d", options.Port)
	}
	if !o.verifier.Ready() {
		return ErrUnsafeConnectToken
	}
	if options.Background {
		return o.serveBackground(ctx, options)
	}

	handler := norelay.NewHandler(
		norelay.Config{MaxConnections: 64, SSHDAddress: o.sshd.LoopbackAddress()},
		norelay.Dependencies{
			Verifier: o.verifier,
			Upgrader: norelay.WebSocketUpgrader{},
			Dialer:   &norelay.NetDialer{},
			Logger:   o.logger,
		},
	)
	mux := http.NewServeMux()
	mux.Handle(norelay.SSHSessionsPath, handler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/v1/status", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			Mode              string `json:"mode"`
			Port              int    `json:"port"`
			ActiveConnections int64  `json:"active_connections"`
		}{Mode: "beta_no_relay", Port: options.Port, ActiveConnections: handler.ActiveConnections()})
	})

	server := &http.Server{
		Addr:              ":" + strconv.Itoa(options.Port),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    16 * 1024,
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	type componentResult struct {
		component string
		err       error
	}
	results := make(chan componentResult, 2)
	go func() { results <- componentResult{component: "sshd", err: o.sshd.Serve(runCtx)} }()
	go func() { results <- componentResult{component: "http", err: server.ListenAndServe()} }()

	first := <-results
	cancel()
	handler.Close()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = server.Shutdown(shutdownCtx)
	shutdownCancel()
	select {
	case <-results:
	case <-time.After(5 * time.Second):
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if first.err == nil || errors.Is(first.err, http.ErrServerClosed) {
		return fmt.Errorf("%s stopped unexpectedly", first.component)
	}
	return fmt.Errorf("%s failed: %w", first.component, first.err)
}

func (o *DaemonOperations) serveBackground(ctx context.Context, options ServeOptions) error {
	if serveReady(ctx, options.Port) {
		return nil
	}
	if err := os.MkdirAll("/var/log/amikad", 0o755); err != nil {
		return fmt.Errorf("prepare daemon log directory: %w", err)
	}
	logFile, err := os.OpenFile(defaultServeLogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open daemon log: %w", err)
	}
	defer logFile.Close()
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate amikad executable: %w", err)
	}
	args := []string{"serve", "--port", strconv.Itoa(options.Port)}
	if options.BetaNoRelay {
		args = append(args, "--beta-no-relay")
	}
	command := exec.Command(executable, args...)
	command.Stdout = logFile
	command.Stderr = logFile
	configureBackgroundProcess(command)
	if err := command.Start(); err != nil {
		return fmt.Errorf("start background amikad: %w", err)
	}
	if err := command.Process.Release(); err != nil {
		return fmt.Errorf("release background amikad: %w", err)
	}

	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("background amikad did not become healthy")
		case <-ticker.C:
			if serveReady(ctx, options.Port) {
				return nil
			}
		}
	}
}

func serveReady(ctx context.Context, port int) bool {
	requestCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodGet,
		"http://127.0.0.1:"+strconv.Itoa(port)+"/v1/status",
		nil,
	)
	if err != nil {
		return false
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var status struct {
		Mode string `json:"mode"`
		Port int    `json:"port"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&status); err != nil {
		return false
	}
	return status.Mode == "beta_no_relay" && status.Port == port
}
