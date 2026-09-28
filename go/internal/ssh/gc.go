package ssh

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
	"github.com/gofixpoint/amika/go/internal/config"
)

const (
	gcMinimumEntries = 50
	gcInterval       = 24 * time.Hour
	gcRetryInterval  = 15 * time.Minute
)

// GCState remembers successful collections separately from failed attempts.
// RetainedEntries includes legacy entries whose ownership is still unknown.
type GCState struct {
	LastSuccess     time.Time `json:"last_success"`
	LastAttempt     time.Time `json:"last_attempt"`
	RetainedEntries int       `json:"retained_entries"`
}

// GCOptions controls an explicit collection or maintenance before opening an
// editor. KeepAlias records ownership and protects the host just prepared,
// even if the list response predates its creation. The caller must have
// resolved that host using the same pinned credential passed to CollectGarbage.
type GCOptions struct {
	Force     bool
	KeepAlias string
}

// GCResult reports concrete host entries, excluding wildcard session settings.
type GCResult struct {
	Collected bool `json:"collected"`
	Removed   int  `json:"removed"`
	Remaining int  `json:"remaining"`
	Unscoped  int  `json:"unscoped"`
}

// CollectGarbage removes deleted sandboxes from managed SSH state. Automatic
// maintenance runs after sufficient growth or one day, with a cooldown after
// failures. Explicit collection bypasses both limits. Other credential scopes
// and entries whose ownership cannot be established are preserved.
func CollectGarbage(paths basedir.Paths, client *apiclient.Client, options GCOptions) (GCResult, error) {
	// Pin the credential for the list request: a concurrently changed login
	// must not change which inventory is used to prune this scope.
	token, err := client.TokenSource.Token()
	if err != nil {
		return GCResult{}, err
	}
	scope := gcScope(client.BaseURL, token)
	pinned := *client
	pinned.TokenSource = apiclient.NewStaticTokenSource(token)
	// Collection must not hold up an editor for the client's full default
	// timeout, including provider enrichment performed by the list endpoint.
	httpClient := *client.HTTP
	if !options.Force && (httpClient.Timeout == 0 || httpClient.Timeout > 5*time.Second) {
		httpClient.Timeout = 5 * time.Second
	}
	pinned.HTTP = &httpClient
	environment, err := config.EnvironmentSlug()
	if err != nil {
		return GCResult{}, err
	}
	return collectGarbage(paths, scope, environment, pinned.ListSandboxes, options, time.Now())
}

// gcScope partitions inventories by endpoint and authenticated organization.
// JWT claims are used only as a local cache key; the API authenticates the
// pinned token. Opaque API keys get separate scopes, so rotating a key can
// delay cleanup but can never delete another organization's entries. Only a
// digest is persisted, never credentials. JWT refreshes within an org retain
// the same scope.
func gcScope(endpoint, token string) string {
	identity := "token:" + token
	parts := strings.Split(token, ".")
	if len(parts) == 3 {
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		var claims struct {
			OrgID string `json:"org_id"`
		}
		if err == nil && json.Unmarshal(payload, &claims) == nil && claims.OrgID != "" {
			identity = "org:" + claims.OrgID
		}
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(strings.TrimRight(endpoint, "/")+"\x00"+identity)))
}

func (s GCState) due(entries int, now time.Time) bool {
	if s.LastAttempt.After(s.LastSuccess) {
		return now.Sub(s.LastAttempt) >= gcRetryInterval
	}
	return entries > max(gcMinimumEntries, 2*s.RetainedEntries) ||
		s.LastSuccess.IsZero() || now.Sub(s.LastSuccess) >= gcInterval
}

func gcCandidate(scope, entryScope, environment, alias string) bool {
	parsed, err := ParseSessionAlias(alias)
	if err == nil && parsed.Environment != environment {
		return false
	}
	if entryScope != "" {
		return entryScope == scope
	}
	if strings.HasPrefix(alias, aliasPrefix) {
		return true
	}
	return err == nil && parsed.Environment == environment
}

func gcEntryCount(state HostsState, scope, environment string) int {
	n := 0
	for _, h := range state.Hosts {
		if gcCandidate(scope, h.GCScope, environment, Alias(h.SandboxID)) {
			n++
		}
	}
	for _, h := range state.SessionHosts {
		if gcCandidate(scope, h.GCScope, environment, h.Alias) {
			n++
		}
	}
	return n
}

func gcResult(state HostsState) GCResult {
	result := GCResult{Remaining: len(state.Hosts) + len(state.SessionHosts)}
	for _, h := range state.Hosts {
		if h.GCScope == "" {
			result.Unscoped++
		}
	}
	for _, h := range state.SessionHosts {
		if h.GCScope == "" {
			result.Unscoped++
		}
	}
	return result
}

func collectGarbage(paths basedir.Paths, scope, environment string, list func() ([]apiclient.RemoteSandbox, error), options GCOptions, now time.Time) (GCResult, error) {
	var snapshot HostsState
	// Upsert revisions protect hosts refreshed while another collector runs.
	// The caller has just verified KeepAlias through an authenticated API
	// response. Record its ownership even when the inventory refresh is not
	// due, so a sandbox deleted before the next refresh remains collectible.
	err := withSessionLock(paths, func() error {
		var err error
		snapshot, err = LoadState(paths)
		if err != nil {
			return err
		}
		changed := false
		for i, h := range snapshot.Hosts {
			if Alias(h.SandboxID) == options.KeepAlias && h.GCScope != scope {
				snapshot.Hosts[i].GCScope = scope
				changed = true
			}
		}
		for i, h := range snapshot.SessionHosts {
			if h.Alias == options.KeepAlias && h.GCScope != scope {
				snapshot.SessionHosts[i].GCScope = scope
				changed = true
			}
		}
		if changed {
			return SaveState(paths, snapshot)
		}
		return nil
	})
	if err != nil {
		return GCResult{}, err
	}
	result := gcResult(snapshot)
	entries := gcEntryCount(snapshot, scope, environment)
	metadata := snapshot.GarbageCollection[scope]
	// Failed publication may have already pruned the final source entry. Still
	// retry it so a stale derived config cannot survive forever in that case.
	if !options.Force && ((entries == 0 && !metadata.LastAttempt.After(metadata.LastSuccess)) ||
		!metadata.due(entries, now)) {
		return result, nil
	}
	// A separate lock serializes collectors while leaving host registration and
	// key rotation free to proceed during the HTTP request.
	wait := sessionLockTimeout
	if !options.Force {
		wait = time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	acquired := false
	err = withStateFileLock(ctx, paths, ".gc.lock", func() error {
		acquired = true
		run := false
		if err := withSessionLock(paths, func() error {
			var err error
			snapshot, err = LoadState(paths)
			if err != nil {
				return err
			}
			result = gcResult(snapshot)
			metadata := snapshot.GarbageCollection[scope]
			if !options.Force && !metadata.due(gcEntryCount(snapshot, scope, environment), now) {
				return nil
			}
			if snapshot.GarbageCollection == nil {
				snapshot.GarbageCollection = make(map[string]GCState)
			}
			metadata.LastAttempt = now
			snapshot.GarbageCollection[scope] = metadata
			run = true
			return SaveState(paths, snapshot)
		}); err != nil {
			return err
		}
		if !run {
			return nil
		}
		sandboxes, err := list()
		if err != nil {
			return err
		}
		// A null/empty HTTP body is not an authoritative empty inventory. The
		// API's successful empty list is [], decoded as a non-nil slice.
		if sandboxes == nil {
			return fmt.Errorf("sandbox list returned no inventory")
		}
		live := make(map[string]bool, len(sandboxes))
		for _, sb := range sandboxes {
			if sb.ID == "" {
				return fmt.Errorf("sandbox list contains an empty id")
			}
			live[sb.ID] = true
		}
		oldHosts := make(map[string]HostEntry, len(snapshot.Hosts))
		for _, h := range snapshot.Hosts {
			oldHosts[h.SandboxID] = h
		}
		oldSessions := make(map[string]SessionHostEntry, len(snapshot.SessionHosts))
		for _, h := range snapshot.SessionHosts {
			oldSessions[h.Alias] = h
		}
		return withSessionLock(paths, func() error {
			state, err := LoadState(paths)
			if err != nil {
				return err
			}
			removed := 0
			hosts := state.Hosts[:0]
			for _, h := range state.Hosts {
				old, existed := oldHosts[h.SandboxID]
				if existed && h == old && gcCandidate(scope, h.GCScope, environment, Alias(h.SandboxID)) {
					if live[h.SandboxID] {
						h.GCScope = scope
					}
					if h.GCScope == scope && !live[h.SandboxID] && Alias(h.SandboxID) != options.KeepAlias {
						removed++
						continue
					}
				}
				hosts = append(hosts, h)
			}
			state.Hosts = hosts
			sessions := state.SessionHosts[:0]
			for _, h := range state.SessionHosts {
				old, existed := oldSessions[h.Alias]
				parsed, parseErr := ParseSessionAlias(h.Alias)
				if existed && h == old && parseErr == nil && gcCandidate(scope, h.GCScope, environment, h.Alias) {
					if live[parsed.ID] {
						h.GCScope = scope
					}
					if h.GCScope == scope && !live[parsed.ID] && h.Alias != options.KeepAlias {
						removed++
						continue
					}
				}
				sessions = append(sessions, h)
			}
			state.SessionHosts = sessions
			// Keep the successful baseline pending until all derived files,
			// including Windows copies, have been published successfully.
			if err := persistManagedStateLocked(paths, state, true); err != nil {
				return err
			}
			// The shared persistence path mirrors session artifacts only when a
			// session identity exists. Legacy-only configs need the same pruning
			// on Windows even when no v2 identity has ever been configured.
			if state.SessionConfig == nil && isWSL() {
				target, err := resolveWSLTarget()
				if err != nil {
					return err
				}
				if err := mirrorStateToWindowsLocked(paths, state, target); err != nil {
					return err
				}
			}
			metadata := state.GarbageCollection[scope]
			metadata.LastSuccess = now
			metadata.RetainedEntries = gcEntryCount(state, scope, environment)
			state.GarbageCollection[scope] = metadata
			// persistManagedStateLocked updates the version in its own copy.
			if state.SessionConfig != nil {
				state.SSHConfigVersion = currentSSHConfigVersion
			}
			if err := SaveState(paths, state); err != nil {
				return err
			}
			result = gcResult(state)
			result.Collected, result.Removed = true, removed
			return nil
		})
	})
	if !options.Force && !acquired && ctx.Err() != nil {
		return result, nil
	}
	return result, err
}
