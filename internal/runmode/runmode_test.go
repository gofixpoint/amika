package runmode

import (
	"errors"
	"testing"

	"github.com/spf13/cobra"
)

func newCmd(flags map[string]string) *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().Bool("local", false, "")
	cmd.Flags().Bool("remote", false, "")
	cmd.Flags().String("remote-target", "", "")
	for k, v := range flags {
		if err := cmd.Flags().Set(k, v); err != nil {
			panic(err)
		}
	}
	return cmd
}

func TestResolve(t *testing.T) {
	tests := []struct {
		name  string
		flags map[string]string
		want  Mode
	}{
		{name: "default is remote", want: Remote},
		{name: "explicit local", flags: map[string]string{"local": "true"}, want: Local},
		{name: "explicit remote", flags: map[string]string{"remote": "true"}, want: Remote},
		{name: "both flags local wins", flags: map[string]string{"local": "true", "remote": "true"}, want: Local},
		{name: "remote-target implies remote", flags: map[string]string{"remote-target": "prod"}, want: Remote},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Resolve(newCmd(tt.flags))
			if got != tt.want {
				t.Errorf("Resolve() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestRequireAuth(t *testing.T) {
	ok := func() error { return nil }
	fail := func() error { return errors.New("no session") }

	tests := []struct {
		name    string
		mode    Mode
		apiKey  string
		checker AuthChecker
		wantErr bool
	}{
		{name: "local skips auth", mode: Local, checker: fail, wantErr: false},
		{name: "remote with valid session", mode: Remote, checker: ok, wantErr: false},
		{name: "remote no session no key", mode: Remote, checker: fail, wantErr: true},
		{name: "remote with API key bypasses session", mode: Remote, apiKey: "sk-xxx", checker: fail, wantErr: false},
		{name: "local with API key", mode: Local, apiKey: "sk-xxx", checker: fail, wantErr: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.apiKey != "" {
				t.Setenv("AMIKA_API_KEY", tt.apiKey)
			} else {
				t.Setenv("AMIKA_API_KEY", "")
			}
			err := RequireAuth(tt.mode, tt.checker)
			if (err != nil) != tt.wantErr {
				t.Errorf("RequireAuth() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
