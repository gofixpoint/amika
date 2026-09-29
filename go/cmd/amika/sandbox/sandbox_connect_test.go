package sandboxcmd

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/ssh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

func TestConnectCommandsUseSessionSSH(t *testing.T) {
	root := &cobra.Command{Use: "amika", SilenceUsage: true, SilenceErrors: true}
	root.PersistentFlags().String("output", "text", "Output format")
	root.AddCommand(New())
	const alias = "canonical.sbx_123.app-amika-dev.amika"
	failure := errors.New("session unavailable")
	for _, tt := range []struct {
		name         string
		args         []string
		prepareErr   error
		getFailure   bool
		wantErr      string
		wantRequests int
		wantPrepare  bool
		wantExec     bool
	}{
		{name: "connect", args: []string{"connect", "requested"}, wantRequests: 1, wantPrepare: true, wantExec: true},
		{name: "create and connect", args: []string{"create", "--name", "requested", "--no-git", "--connect"}, wantRequests: 2, wantPrepare: true, wantExec: true},
		{name: "create only", args: []string{"create", "--name", "requested", "--no-git"}, wantRequests: 2},
		{name: "connect unavailable", args: []string{"connect", "requested"}, prepareErr: failure, wantErr: failure.Error(), wantRequests: 1, wantPrepare: true},
		{name: "created session unavailable", args: []string{"create", "--no-git", "--connect"}, prepareErr: failure, wantErr: failure.Error(), wantRequests: 2, wantPrepare: true},
		{name: "lookup fails", args: []string{"connect", "requested"}, getFailure: true, wantErr: "not found", wantRequests: 1},
		{name: "provisioning poll fails", args: []string{"create", "--no-git", "--connect"}, getFailure: true, wantErr: "not found", wantRequests: 2},
		{name: "connect rejects JSON", args: []string{"connect", "requested", "--output", "json"}, wantErr: "not supported"},
		{name: "create connect rejects JSON", args: []string{"create", "--no-git", "--connect", "--output", "json"}, wantErr: "--connect cannot be combined"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Cleanup(func() {
				var reset func(*cobra.Command)
				reset = func(cmd *cobra.Command) {
					cmd.Flags().VisitAll(func(f *pflag.Flag) {
						if f.Changed {
							_ = f.Value.Set(f.DefValue)
							f.Changed = false
						}
					})
					for _, child := range cmd.Commands() {
						reset(child)
					}
				}
				reset(root)
			})
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if strings.Contains(r.URL.Path, "/ssh") {
					t.Errorf("legacy SSH request: %s", r.URL.Path)
				}
				if tt.getFailure && r.Method == "GET" {
					http.Error(w, "not found", 404)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"name":"canonical","id":"sbx_123","state":"active"}`))
			}))
			defer server.Close()
			t.Setenv("AMIKA_API_URL", server.URL)
			t.Setenv("AMIKA_API_KEY", "test-key")
			prevPrepare, prevExec := prepareSessionTarget, execSessionSSH
			t.Cleanup(func() { prepareSessionTarget, execSessionSSH = prevPrepare, prevExec })
			prepared, executed := false, false
			prepareSessionTarget = func(_ basedir.Paths, _ ssh.SessionCreator, name, id string) (string, error) {
				prepared = true
				if name != "canonical" || id != "sbx_123" {
					t.Errorf("prepared %q/%q, want canonical identity", name, id)
				}
				return alias, tt.prepareErr
			}
			execSessionSSH = func(host string, argv []string) error {
				executed = true
				if host != alias || !reflect.DeepEqual(argv, []string{alias}) {
					t.Errorf("exec %q %v", host, argv)
				}
				return nil
			}
			root.SetOut(&bytes.Buffer{})
			root.SetErr(&bytes.Buffer{})
			root.SetArgs(append([]string{"rig"}, tt.args...))
			err := root.Execute()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error=%v, want %q", err, tt.wantErr)
			}
			if requests != tt.wantRequests || prepared != tt.wantPrepare || executed != tt.wantExec {
				t.Fatalf("requests=%d prepared=%v exec=%v", requests, prepared, executed)
			}
		})
	}
}
