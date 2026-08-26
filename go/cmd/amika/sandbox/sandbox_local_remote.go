package sandboxcmd

// sandbox_local_remote.go provides shared remote-target and client helpers,
// plus the local-to-API-shape unification used by `sandbox create`/`list`
// (see AGENTS.md, "CLI Output Format (--output)"): a local Docker sandbox's
// JSON output is built as an apiclient.RemoteSandbox, the same mirror type
// used for remote sandboxes, populating only the fields that have a local
// meaning and leaving API-only fields (org_id, user_id, provider_url, repo_*,
// etc.) null or empty.

import (
	"fmt"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/runmode"
	"github.com/gofixpoint/amika/go/internal/sandbox"
	"github.com/gofixpoint/amika/go/pkg/amika"
	"github.com/spf13/cobra"
)

// TODO: Parse env variables from an environment file (e.g. .amika/.env or ~/.config/amika/env)
// so users don't need to export AMIKA_API_URL, AMIKA_WORKOS_CLIENT_ID, etc. in their shell profile.

// getRemoteTarget validates that --remote-target is not combined with --local or --remote, and returns the target string.
// The flag is currently hidden and disabled; it will be enabled once named-remote config is implemented.
func getRemoteTarget(cmd *cobra.Command) (string, error) {
	target, _ := cmd.Flags().GetString("remote-target")
	if target != "" {
		return "", fmt.Errorf("--remote-target is not yet supported")
	}
	return target, nil
}

// getRemoteClient returns an API client for the given remote target. The client
// construction is shared via runmode.NewRemoteClient; target is threaded through
// (currently a no-op) so named-remote support can resolve a per-target endpoint
// here without touching call sites.
func getRemoteClient(target string) (*apiclient.Client, error) {
	_ = target
	return runmode.NewRemoteClient(), nil
}

// stringPtr returns nil for an empty string and a pointer to s otherwise, so
// callers can populate a nullable API-shaped *string field only when the
// local value is meaningful (an empty local field becomes JSON null, matching
// how an absent value is represented remotely).
func stringPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// deref returns the empty string for a nil pointer, or the pointed-to value.
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// remoteSandboxServicesFromInfo flattens a local sandbox's named services
// (sandbox.Info.Services, grouped by name with resolved port bindings) into
// the API's flat `services` array shape: one apiclient.RemoteSandboxService
// per port binding. This is the inverse of the grouping the text output (and
// the remote `service list` path) applies to the API's flat shape.
func remoteSandboxServicesFromInfo(services []sandbox.ServiceInfo) []apiclient.RemoteSandboxService {
	out := make([]apiclient.RemoteSandboxService, 0, len(services))
	for _, svc := range services {
		for _, port := range svc.Ports {
			out = append(out, apiclient.RemoteSandboxService{
				Name:          svc.Name,
				URL:           port.URL,
				HostPort:      port.HostPort,
				ContainerPort: port.ContainerPort,
				Protocol:      port.Protocol,
			})
		}
	}
	return out
}

// remoteSandboxServicesFromPublic is remoteSandboxServicesFromInfo's
// counterpart for pkg/amika.Sandbox.Services (the type returned by the local
// service layer's ListSandboxes, used by `sandbox list`).
func remoteSandboxServicesFromPublic(services []amika.ServiceInfo) []apiclient.RemoteSandboxService {
	out := make([]apiclient.RemoteSandboxService, 0, len(services))
	for _, svc := range services {
		for _, port := range svc.Ports {
			out = append(out, apiclient.RemoteSandboxService{
				Name:          svc.Name,
				URL:           port.URL,
				HostPort:      port.HostPort,
				ContainerPort: port.ContainerPort,
				Protocol:      port.Protocol,
			})
		}
	}
	return out
}

// remoteSandboxFromInfo builds the `sandbox create` JSON for a local sandbox
// as an apiclient.RemoteSandbox: the same API-shaped mirror type used for
// remote sandboxes (decision: unify local output to the API's Sandbox shape).
// Only fields with a local meaning are populated; the ones with no local
// equivalent at all (org_id, user_id, provider_url, created_by) are left null
// or empty. ContainerID and Image have no schema equivalent but are preserved
// as extra keys (the schema's additionalProperties allows this) rather than
// dropped.
//
// `repo_name` and `snapshot` are populated even though a local Docker sandbox
// has neither concept natively, because it has an equivalent of each: repos are
// the workspace mounts, and the base it was built from is its image. The point
// of the mirror is that one field name answers a question for both kinds, so a
// script does not have to know whether it is reading a local sandbox to find the
// base. `image` stays alongside as the local-native spelling.
func remoteSandboxFromInfo(info sandbox.Info, state string) apiclient.RemoteSandbox {
	return apiclient.RemoteSandbox{
		ID:          info.Name,
		Name:        info.Name,
		Provider:    stringPtr(info.Provider),
		Branch:      stringPtr(info.Branch),
		RepoName:    repoNameForJSON(amika.ExtractRepoNamesFromMounts(mountsFromInfo(info.Mounts))),
		Snapshot:    stringPtr(info.Image),
		Services:    remoteSandboxServicesFromInfo(info.Services),
		State:       state,
		CreatedAt:   info.CreatedAt,
		UpdatedAt:   info.CreatedAt,
		ContainerID: info.ContainerID,
		Image:       info.Image,
	}
}

// mountsFromInfo converts stored mounts to the public shape that
// ExtractRepoNamesFromMounts reads, so the repo names in the JSON come from the
// same derivation the service layer uses rather than a second copy of the rule.
func mountsFromInfo(in []sandbox.MountBinding) []amika.Mount {
	out := make([]amika.Mount, 0, len(in))
	for _, m := range in {
		out = append(out, amika.Mount{
			Type:         m.Type,
			Source:       m.Source,
			Volume:       m.Volume,
			Target:       m.Target,
			Mode:         m.Mode,
			SnapshotFrom: m.SnapshotFrom,
		})
	}
	return out
}

// repoNameForJSON renders the mounted repos into the schema's single
// `repo_name`, joined exactly as the table's REPO column joins them so the two
// outputs cannot disagree about the same sandbox. Nil when there are none, so
// the field is null rather than an empty string.
func repoNameForJSON(repos []string) *string {
	joined := formatRepos(repos)
	if joined == "" {
		return nil
	}
	return &joined
}

// remoteSandboxFromPublic is remoteSandboxFromInfo's counterpart for
// `sandbox list`, which reads local sandboxes through the pkg/amika service
// layer (amika.Sandbox) rather than sandbox.Info directly.
func remoteSandboxFromPublic(sb amika.Sandbox) apiclient.RemoteSandbox {
	return apiclient.RemoteSandbox{
		ID:       sb.Name,
		Name:     sb.Name,
		Provider: stringPtr(sb.Provider),
		Branch:   stringPtr(sb.Branch),
		// See remoteSandboxFromInfo on why a local sandbox reports these.
		RepoName:    repoNameForJSON(sb.Repos),
		Snapshot:    stringPtr(sb.Image),
		Services:    remoteSandboxServicesFromPublic(sb.Services),
		State:       sb.State,
		CreatedAt:   sb.CreatedAt,
		UpdatedAt:   sb.CreatedAt,
		ContainerID: sb.ContainerID,
		Image:       sb.Image,
	}
}

// normalizeSandboxJSON applies one CLI-side output convention on top of the
// API mirror before encoding: `services` is always emitted as `[]` rather
// than `null`, even though the schema marks the field nullable, since an
// empty array is easier for scripts to consume uniformly than having to
// handle both `[]` and `null`.
func normalizeSandboxJSON(sb apiclient.RemoteSandbox) apiclient.RemoteSandbox {
	if sb.Services == nil {
		sb.Services = []apiclient.RemoteSandboxService{}
	}
	return sb
}
