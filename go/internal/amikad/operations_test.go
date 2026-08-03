package amikad

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/amikad/norelay"
	"github.com/gofixpoint/amika/go/internal/amikad/sshd"
	"github.com/gofixpoint/amika/go/internal/amikad/state"
)

type fakeSSHDManager struct {
	setupOptions sshd.SetupOptions
	serveCalls   int
}

func (m *fakeSSHDManager) Setup(_ context.Context, options sshd.SetupOptions) error {
	m.setupOptions = options
	return nil
}
func (*fakeSSHDManager) ShowHostKey(context.Context, io.Writer) error       { return nil }
func (*fakeSSHDManager) SetAuthorizedKeys(context.Context, io.Reader) error { return nil }
func (m *fakeSSHDManager) Serve(context.Context) error {
	m.serveCalls++
	return nil
}

func testOperations(t *testing.T) (*DaemonOperations, string, *fakeSSHDManager) {
	t.Helper()
	directory := t.TempDir()
	files := state.OSFiles{}
	manifestPath := filepath.Join(directory, "injected-paths.json")
	tokenPath := filepath.Join(directory, "connect-token")
	store := state.NewStore(manifestPath, files)
	manager := &fakeSSHDManager{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewDaemonOperations(
		manager,
		store,
		norelay.NewFileTokenVerifier(tokenPath, files),
		tokenPath,
		logger,
	), tokenPath, manager
}

func TestSetConnectTokenStoresCanonicalOwnerOnlyValue(t *testing.T) {
	operations, tokenPath, _ := testOperations(t)
	token := base64.RawURLEncoding.EncodeToString(make([]byte, norelay.TokenBytes))
	if err := operations.SetConnectToken(context.Background(), strings.NewReader(token+"\n")); err != nil {
		t.Fatalf("SetConnectToken: %v", err)
	}
	contents, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatalf("read token: %v", err)
	}
	if string(contents) != token {
		t.Fatalf("stored token = %q, want canonical token", contents)
	}
	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatalf("stat token: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("token mode = %o, want 600", info.Mode().Perm())
	}
	if !operations.verifier.Verify(token) {
		t.Fatal("stored token did not authenticate")
	}
}

func TestSetConnectTokenRejectsMalformedInputWithoutLeakingIt(t *testing.T) {
	operations, tokenPath, _ := testOperations(t)
	secret := "secret-that-must-not-appear-in-errors"
	err := operations.SetConnectToken(context.Background(), strings.NewReader(secret))
	if !errors.Is(err, ErrUnsafeConnectToken) {
		t.Fatalf("error = %v, want ErrUnsafeConnectToken", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("error leaked token: %v", err)
	}
	if _, err := os.Stat(tokenPath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("invalid token created file: %v", err)
	}
}

func TestServeFailsClosedBeforeStartingSSHD(t *testing.T) {
	operations, _, manager := testOperations(t)
	if err := operations.Serve(context.Background(), ServeOptions{Port: DefaultPort}); !errors.Is(err, ErrNoServeMode) {
		t.Fatalf("serve without mode error = %v", err)
	}
	if err := operations.Serve(context.Background(), ServeOptions{Port: DefaultPort, BetaNoRelay: true}); !errors.Is(err, ErrUnsafeConnectToken) {
		t.Fatalf("serve without token error = %v", err)
	}
	if manager.serveCalls != 0 {
		t.Fatalf("unsafe serve started sshd %d times", manager.serveCalls)
	}
}

func TestSetupSSHDForwardsOverwriteAuthorization(t *testing.T) {
	operations, _, manager := testOperations(t)
	if err := operations.SetupSSHD(context.Background(), SetupSSHDOptions{ForceOverwrite: true}); err != nil {
		t.Fatalf("SetupSSHD: %v", err)
	}
	if !manager.setupOptions.ForceOverwrite {
		t.Fatal("force-overwrite authorization was not forwarded")
	}
}
