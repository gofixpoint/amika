package sandboxcmd

// sandbox_create_credentials.go parses the --agent-credential,
// --agent-credential-type, and --no-agent-credential flags into the
// agent_credentials request body field accepted by POST /api/sandboxes.

import (
	"fmt"
	"sort"
	"strings"

	"github.com/gofixpoint/amika/internal/apiclient"
)

// agentKindRegistry lists the agent credential kinds the CLI accepts. The
// server owns the canonical registry; this list mirrors it for client-side
// validation and for the default opt-in entries the CLI submits when no
// flags are passed.
var agentKindRegistry = []string{"claude", "codex"}

// validAgentTypes lists the credential types the CLI accepts in the
// --agent-credential-type flag. Hyphenated forms (api-key) are translated
// to the underscored API form (api_key) at the boundary.
var validAgentTypes = map[string]string{
	"oauth":   "oauth",
	"api_key": "api_key",
	"api-key": "api_key",
}

// parseAgentCredentialFlags converts the three repeatable flags into the
// agent_credentials body field.
//
// Combination rules (enforced here, before sending):
//   - --agent-credential and --agent-credential-type may each appear at
//     most once per kind.
//   - They may both target the same kind; the entry is { kind, name, type }.
//   - --no-agent-credential is mutually exclusive with the other two for
//     the same kind.
//   - Unknown kinds are rejected.
//
// When the user passes no flag for a registered kind, an opt-in entry of
// just { kind } is appended for that kind. This signals the server to walk
// repo-config defaults and, if nothing is declared, to fall back to its
// auto-default selection. It is intentional that omission from the request
// is *not* the CLI's "no credential" signal — users opt out explicitly via
// --no-agent-credential.
func parseAgentCredentialFlags(nameFlags, typeFlags, noneFlags []string) ([]apiclient.AgentCredentialRef, error) {
	type entry struct {
		name string
		typ  string
		none bool
	}
	byKind := make(map[string]*entry)
	getEntry := func(kind string) *entry {
		if e, ok := byKind[kind]; ok {
			return e
		}
		e := &entry{}
		byKind[kind] = e
		return e
	}

	for _, raw := range nameFlags {
		kind, value, err := splitKindValue(raw, "--agent-credential")
		if err != nil {
			return nil, err
		}
		if value == "" {
			return nil, fmt.Errorf("--agent-credential %s: empty credential name", raw)
		}
		if err := validateAgentKind(kind); err != nil {
			return nil, err
		}
		e := getEntry(kind)
		if e.none {
			return nil, fmt.Errorf("--agent-credential and --no-agent-credential for kind %q are mutually exclusive", kind)
		}
		if e.name != "" {
			return nil, fmt.Errorf("--agent-credential specified more than once for kind %q", kind)
		}
		e.name = value
	}

	for _, raw := range typeFlags {
		kind, value, err := splitKindValue(raw, "--agent-credential-type")
		if err != nil {
			return nil, err
		}
		if value == "" {
			return nil, fmt.Errorf("--agent-credential-type %s: empty type", raw)
		}
		if err := validateAgentKind(kind); err != nil {
			return nil, err
		}
		canonical, ok := validAgentTypes[strings.ToLower(value)]
		if !ok {
			return nil, fmt.Errorf("--agent-credential-type %s: unknown type %q (expected oauth or api-key)", raw, value)
		}
		e := getEntry(kind)
		if e.none {
			return nil, fmt.Errorf("--agent-credential-type and --no-agent-credential for kind %q are mutually exclusive", kind)
		}
		if e.typ != "" {
			return nil, fmt.Errorf("--agent-credential-type specified more than once for kind %q", kind)
		}
		e.typ = canonical
	}

	for _, raw := range noneFlags {
		kind := strings.TrimSpace(raw)
		if kind == "" {
			return nil, fmt.Errorf("--no-agent-credential requires a kind")
		}
		if err := validateAgentKind(kind); err != nil {
			return nil, err
		}
		e := getEntry(kind)
		if e.name != "" || e.typ != "" {
			return nil, fmt.Errorf("--no-agent-credential and --agent-credential[-type] for kind %q are mutually exclusive", kind)
		}
		if e.none {
			return nil, fmt.Errorf("--no-agent-credential specified more than once for kind %q", kind)
		}
		e.none = true
	}

	// Fill in opt-in defaults for any registered kind the user did not
	// mention. Omitting a kind would tell the server "no credential of
	// this kind" — which is the wrong default for the interactive CLI.
	for _, kind := range agentKindRegistry {
		if _, ok := byKind[kind]; !ok {
			byKind[kind] = &entry{}
		}
	}

	kinds := make([]string, 0, len(byKind))
	for k := range byKind {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)

	out := make([]apiclient.AgentCredentialRef, 0, len(kinds))
	for _, kind := range kinds {
		e := byKind[kind]
		ref := apiclient.AgentCredentialRef{Kind: kind}
		switch {
		case e.none:
			ref.None = true
		default:
			ref.Name = e.name
			ref.Type = e.typ
		}
		out = append(out, ref)
	}
	return out, nil
}

func splitKindValue(raw, flagName string) (string, string, error) {
	idx := strings.Index(raw, "=")
	if idx < 0 {
		return "", "", fmt.Errorf("%s %s: expected <kind>=<value>", flagName, raw)
	}
	kind := strings.TrimSpace(raw[:idx])
	value := strings.TrimSpace(raw[idx+1:])
	if kind == "" {
		return "", "", fmt.Errorf("%s %s: empty kind", flagName, raw)
	}
	return kind, value, nil
}

func validateAgentKind(kind string) error {
	for _, k := range agentKindRegistry {
		if k == kind {
			return nil
		}
	}
	return fmt.Errorf("unknown agent credential kind %q (expected one of: %s)", kind, strings.Join(agentKindRegistry, ", "))
}
