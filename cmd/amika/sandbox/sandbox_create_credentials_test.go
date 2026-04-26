package sandboxcmd

import (
	"reflect"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/apiclient"
)

func TestParseAgentCredentialFlags_DefaultsToOptInPerKind(t *testing.T) {
	got, err := parseAgentCredentialFlags(nil, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []apiclient.AgentCredentialRef{
		{Kind: "claude"},
		{Kind: "codex"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestParseAgentCredentialFlags_NameOnly(t *testing.T) {
	got, err := parseAgentCredentialFlags([]string{"claude=personal-oauth"}, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []apiclient.AgentCredentialRef{
		{Kind: "claude", Name: "personal-oauth"},
		{Kind: "codex"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestParseAgentCredentialFlags_TypeTranslatesHyphenToUnderscore(t *testing.T) {
	got, err := parseAgentCredentialFlags(nil, []string{"claude=api-key"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var claude apiclient.AgentCredentialRef
	for _, r := range got {
		if r.Kind == "claude" {
			claude = r
		}
	}
	if claude.Type != "api_key" {
		t.Errorf("type = %q, want %q", claude.Type, "api_key")
	}
}

func TestParseAgentCredentialFlags_NameAndTypeCombineForSameKind(t *testing.T) {
	got, err := parseAgentCredentialFlags([]string{"claude=foo"}, []string{"claude=oauth"}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var claude apiclient.AgentCredentialRef
	for _, r := range got {
		if r.Kind == "claude" {
			claude = r
		}
	}
	want := apiclient.AgentCredentialRef{Kind: "claude", Name: "foo", Type: "oauth"}
	if !reflect.DeepEqual(claude, want) {
		t.Errorf("got %+v, want %+v", claude, want)
	}
}

func TestParseAgentCredentialFlags_NoAgentCredential(t *testing.T) {
	got, err := parseAgentCredentialFlags(nil, nil, []string{"claude"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []apiclient.AgentCredentialRef{
		{Kind: "claude", None: true},
		{Kind: "codex"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestParseAgentCredentialFlags_UserFlagsDoNotSuppressOtherKinds(t *testing.T) {
	// Codex still gets its implicit { kind } opt-in entry.
	got, err := parseAgentCredentialFlags([]string{"claude=foo"}, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	hasCodex := false
	for _, r := range got {
		if r.Kind == "codex" && r.Name == "" && r.Type == "" && !r.None {
			hasCodex = true
		}
	}
	if !hasCodex {
		t.Errorf("expected default {kind:codex} opt-in, got %+v", got)
	}
}

func TestParseAgentCredentialFlags_Errors(t *testing.T) {
	tests := []struct {
		name      string
		nameFlags []string
		typeFlags []string
		noneFlags []string
		wantErr   string
	}{
		{
			name:      "duplicate kind via --agent-credential",
			nameFlags: []string{"claude=a", "claude=b"},
			wantErr:   "specified more than once",
		},
		{
			name:      "duplicate kind via --agent-credential-type",
			typeFlags: []string{"claude=oauth", "claude=api_key"},
			wantErr:   "specified more than once",
		},
		{
			name:      "name + none mutually exclusive",
			nameFlags: []string{"claude=x"},
			noneFlags: []string{"claude"},
			wantErr:   "mutually exclusive",
		},
		{
			name:      "type + none mutually exclusive",
			typeFlags: []string{"claude=oauth"},
			noneFlags: []string{"claude"},
			wantErr:   "mutually exclusive",
		},
		{
			name:      "unknown kind in --agent-credential",
			nameFlags: []string{"foo=bar"},
			wantErr:   "unknown agent credential kind",
		},
		{
			name:      "unknown kind in --no-agent-credential",
			noneFlags: []string{"foo"},
			wantErr:   "unknown agent credential kind",
		},
		{
			name:      "missing equals in --agent-credential",
			nameFlags: []string{"claude"},
			wantErr:   "expected <kind>=<value>",
		},
		{
			name:      "empty name",
			nameFlags: []string{"claude="},
			wantErr:   "empty credential name",
		},
		{
			name:      "unknown type",
			typeFlags: []string{"claude=password"},
			wantErr:   "unknown type",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseAgentCredentialFlags(tt.nameFlags, tt.typeFlags, tt.noneFlags)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error %q does not contain %q", err.Error(), tt.wantErr)
			}
		})
	}
}
