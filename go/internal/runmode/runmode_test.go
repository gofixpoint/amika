package runmode

import (
	"errors"
	"testing"
)

func TestRequireAuth(t *testing.T) {
	ok := func() error { return nil }
	fail := func() error { return errors.New("no session") }

	tests := []struct {
		name    string
		apiKey  string
		checker AuthChecker
		wantErr bool
	}{
		{name: "valid session", checker: ok, wantErr: false},
		{name: "no session no key", checker: fail, wantErr: true},
		{name: "API key bypasses session", apiKey: "sk-xxx", checker: fail, wantErr: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("AMIKA_API_KEY", tt.apiKey)
			err := RequireAuth(tt.checker)
			if (err != nil) != tt.wantErr {
				t.Errorf("RequireAuth() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
