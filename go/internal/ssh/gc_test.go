package ssh

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
)

func gcTestState(t *testing.T, state HostsState) basedir.Paths {
	t.Helper()
	paths := testPaths(t)
	t.Setenv("AMIKA_STATE_DIRECTORY", t.TempDir())
	if len(state.SessionHosts) > 0 {
		identity, _ := paths.SSHIdentityFile()
		pins, _ := paths.SSHKnownHostsFile()
		state.SessionConfig = &SessionConfig{IdentityFile: identity, KnownHostsFile: pins}
		state.SessionProxyCommands = map[string]string{"prod": "/bin/amika plumbing ssh-stdio-proxy %h"}
	}
	if err := SaveState(paths, state); err != nil {
		t.Fatal(err)
	}
	return paths
}

func TestGCMirrorsLegacyOnlyWindowsConfig(t *testing.T) {
	paths := gcTestState(t, HostsState{Hosts: []HostEntry{{SandboxID: "deleted", GCScope: "current"}}})
	winDir := t.TempDir()
	stubWSL(t, winDir, nil)
	result, err := collectGarbage(paths, "current", "prod", func() ([]apiclient.RemoteSandbox, error) {
		return []apiclient.RemoteSandbox{}, nil
	}, GCOptions{Force: true}, time.Now())
	if err != nil || result.Removed != 1 {
		t.Fatalf("collection: %+v, %v", result, err)
	}
	data, err := os.ReadFile(filepath.Join(winDir, "amika.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "amika-deleted") {
		t.Fatalf("stale Windows config: %s", data)
	}
}

func TestGCDue(t *testing.T) {
	now := time.Now().UTC()
	for _, tt := range []struct {
		name    string
		state   GCState
		entries int
		want    bool
	}{
		{"first run", GCState{}, 1, true},
		{"below floor", GCState{LastSuccess: now.Add(-time.Hour)}, 50, false},
		{"above floor", GCState{LastSuccess: now.Add(-time.Hour)}, 51, true},
		{"many survivors", GCState{LastSuccess: now.Add(-time.Hour), RetainedEntries: 80}, 160, false},
		{"growth", GCState{LastSuccess: now.Add(-time.Hour), RetainedEntries: 80}, 161, true},
		{"growth after recent success", GCState{LastSuccess: now.Add(-time.Minute), LastAttempt: now.Add(-time.Minute), RetainedEntries: 80}, 161, true},
		{"age without growth", GCState{LastSuccess: now.Add(-24 * time.Hour), RetainedEntries: 80}, 2, true},
		{"failure cooldown", GCState{LastAttempt: now.Add(-time.Minute)}, 1000, false},
		{"retry", GCState{LastAttempt: now.Add(-15 * time.Minute)}, 1, true},
		{"retry after recent success and pruning", GCState{LastSuccess: now.Add(-time.Hour), LastAttempt: now.Add(-15 * time.Minute), RetainedEntries: 80}, 0, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.state.due(tt.entries, now); got != tt.want {
				t.Fatalf("due = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGCRecordsNewHostsEvenWhenCollectionIsNotDue(t *testing.T) {
	now := time.Now()
	paths := gcTestState(t, HostsState{
		Hosts:        []HostEntry{{SandboxID: "short-lived"}},
		SessionHosts: []SessionHostEntry{{Alias: "short.short-lived.prod.amika"}},
		GarbageCollection: map[string]GCState{"current": {
			LastSuccess: now.Add(-time.Hour), LastAttempt: now.Add(-time.Hour), RetainedEntries: 1,
		}},
	})
	for _, alias := range []string{"amika-short-lived", "short.short-lived.prod.amika"} {
		result, err := collectGarbage(paths, "current", "prod", func() ([]apiclient.RemoteSandbox, error) {
			t.Fatal("collection should not be due")
			return nil, nil
		}, GCOptions{KeepAlias: alias}, now)
		if err != nil || result.Collected {
			t.Fatalf("registration: %+v, %v", result, err)
		}
	}
	result, err := collectGarbage(paths, "current", "prod", func() ([]apiclient.RemoteSandbox, error) {
		return []apiclient.RemoteSandbox{}, nil
	}, GCOptions{}, now.Add(24*time.Hour))
	if err != nil || result.Removed != 2 || result.Remaining != 0 {
		t.Fatalf("short-lived hosts survived collection: %+v, %v", result, err)
	}
}

func TestGCSkipsConcurrentAutomaticCollector(t *testing.T) {
	paths := gcTestState(t, HostsState{Hosts: []HostEntry{{SandboxID: "keep", GCScope: "current"}}})
	now := time.Now()
	list := func() ([]apiclient.RemoteSandbox, error) {
		result, err := collectGarbage(paths, "current", "prod", func() ([]apiclient.RemoteSandbox, error) {
			t.Fatal("concurrent collector fetched inventory")
			return nil, nil
		}, GCOptions{}, now.Add(gcRetryInterval))
		if err != nil || result.Collected {
			t.Fatalf("concurrent collection: %+v, %v", result, err)
		}
		return []apiclient.RemoteSandbox{{ID: "keep"}}, nil
	}
	if _, err := collectGarbage(paths, "current", "prod", list, GCOptions{}, now); err != nil {
		t.Fatal(err)
	}
}

func TestGCPrunesBothHostFormatsAndPreservesOtherScopes(t *testing.T) {
	paths := gcTestState(t, HostsState{
		Hosts: []HostEntry{
			{SandboxID: "deleted", GCScope: "current"},
			{SandboxID: "stopped", GCScope: "current"},
			{SandboxID: "other-org", GCScope: "other"},
			{SandboxID: "legacy-deleted"},
			{SandboxID: "legacy-live"},
		},
		SessionHosts: []SessionHostEntry{
			{Alias: "old.deleted.prod.amika", GCScope: "current"},
			{Alias: "stopped.stopped.prod.amika", GCScope: "current"},
			{Alias: "legacy.legacy-live.prod.amika"},
			{Alias: "amika-other.legacy-live.staging.amika"},
		},
	})
	list := func() ([]apiclient.RemoteSandbox, error) {
		return []apiclient.RemoteSandbox{{ID: "stopped", Status: "stopped"}, {ID: "legacy-live"}}, nil
	}
	result, err := collectGarbage(paths, "current", "prod", list, GCOptions{Force: true}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if result.Removed != 2 || result.Remaining != 7 || result.Unscoped != 2 {
		t.Fatalf("result = %+v", result)
	}
	state, err := LoadState(paths)
	if err != nil {
		t.Fatal(err)
	}
	if state.SessionHosts[2].GCScope != "" {
		t.Fatal("adopted another environment's host")
	}
	configPath, _ := paths.SSHAmikaConfigFile()
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "Host amika-deleted\n") || strings.Contains(string(data), "Host old.deleted.prod.amika\n") {
		t.Fatalf("stale config: %s", data)
	}
	if !strings.Contains(string(data), "Host *.prod.amika") {
		t.Fatalf("lost wildcard: %s", data)
	}
	assertPerm(t, configPath, 0o600)
}

func TestGCUpdatesBaselineEvenWhenNothingRemoved(t *testing.T) {
	state := HostsState{}
	live := []apiclient.RemoteSandbox{}
	for i := 0; i < 80; i++ {
		id := fmt.Sprintf("sb_%d", i)
		state.Hosts = append(state.Hosts, HostEntry{SandboxID: id, GCScope: "current"})
		live = append(live, apiclient.RemoteSandbox{ID: id})
	}
	paths := gcTestState(t, state)
	calls := 0
	list := func() ([]apiclient.RemoteSandbox, error) { calls++; return live, nil }
	now := time.Now()
	for _, offset := range []time.Duration{0, time.Hour, 24 * time.Hour} {
		_, err := collectGarbage(paths, "current", "prod", list, GCOptions{}, now.Add(offset))
		if err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 {
		t.Fatalf("list called %d times; want initial and daily collections", calls)
	}
	state, _ = LoadState(paths)
	if state.GarbageCollection["current"].RetainedEntries != 80 {
		t.Fatalf("baseline = %+v", state.GarbageCollection)
	}
}

func TestGCFailureCooldownAndForcedRetry(t *testing.T) {
	paths := gcTestState(t, HostsState{Hosts: []HostEntry{{SandboxID: "deleted", GCScope: "current"}}})
	now := time.Now()
	calls := 0
	list := func() ([]apiclient.RemoteSandbox, error) { calls++; return nil, errors.New("offline") }
	if _, err := collectGarbage(paths, "current", "prod", list, GCOptions{}, now); err == nil {
		t.Fatal("expected list failure")
	}
	state, _ := LoadState(paths)
	if len(state.Hosts) != 1 || !state.GarbageCollection["current"].LastSuccess.IsZero() {
		t.Fatalf("failed collection changed hosts or success: %+v", state)
	}
	if _, err := collectGarbage(paths, "current", "prod", list, GCOptions{}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("did not back off")
	}
	result, err := collectGarbage(paths, "current", "prod", func() ([]apiclient.RemoteSandbox, error) {
		return []apiclient.RemoteSandbox{}, nil
	}, GCOptions{Force: true}, now.Add(time.Minute))
	if err != nil || result.Removed != 1 {
		t.Fatalf("forced empty inventory: %+v, %v", result, err)
	}
}

func TestGCPreservesConcurrentRegistrationsAndCurrentTarget(t *testing.T) {
	paths := gcTestState(t, HostsState{Hosts: []HostEntry{
		{SandboxID: "refresh", GCScope: "current"},
		{SandboxID: "target", GCScope: "current"},
		{SandboxID: "delete", GCScope: "current"},
	}, SessionHosts: []SessionHostEntry{{Alias: "refresh.refresh.prod.amika", GCScope: "current"}}})
	list := func() ([]apiclient.RemoteSandbox, error) {
		// These acquire the normal session lock, proving it is released for HTTP.
		if _, err := UpsertHost(paths, HostEntry{SandboxID: "refresh"}); err != nil {
			t.Fatal(err)
		}
		if _, err := UpsertHost(paths, HostEntry{SandboxID: "new", GCScope: "current"}); err != nil {
			t.Fatal(err)
		}
		if err := UpsertSessionHost(paths, "refresh.refresh.prod.amika"); err != nil {
			t.Fatal(err)
		}
		return []apiclient.RemoteSandbox{}, nil
	}
	result, err := collectGarbage(paths, "current", "prod", list, GCOptions{KeepAlias: "amika-target"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if result.Removed != 1 || result.Remaining != 4 || result.Unscoped != 0 {
		t.Fatalf("result = %+v", result)
	}
}

func TestGCRejectsIncompleteInventory(t *testing.T) {
	for _, inventory := range [][]apiclient.RemoteSandbox{nil, {{ID: ""}}} {
		paths := gcTestState(t, HostsState{Hosts: []HostEntry{{SandboxID: "keep", GCScope: "current"}}})
		_, err := collectGarbage(paths, "current", "prod", func() ([]apiclient.RemoteSandbox, error) { return inventory, nil }, GCOptions{Force: true}, time.Now())
		if err == nil {
			t.Fatal("expected invalid inventory to fail")
		}
		state, _ := LoadState(paths)
		if len(state.Hosts) != 1 {
			t.Fatal("removed a host using invalid inventory")
		}
	}
}

func TestGCScope(t *testing.T) {
	jwt := func(payload string) string {
		return "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".signature"
	}
	first := gcScope("https://app.amika.dev", jwt(`{"org_id":"org-a","exp":1}`))
	if first != gcScope("https://app.amika.dev/", jwt(`{"org_id":"org-a","exp":2}`)) {
		t.Fatal("JWT refresh changed scope")
	}
	for _, other := range []string{
		gcScope("https://staging.amika.dev", jwt(`{"org_id":"org-a"}`)),
		gcScope("https://app.amika.dev", jwt(`{"org_id":"org-b"}`)),
		gcScope("https://app.amika.dev", "opaque-key"),
	} {
		if first == other {
			t.Fatal("scopes collided")
		}
	}
	if gcScope("https://app.amika.dev", "key-a") == gcScope("https://app.amika.dev", "key-b") {
		t.Fatal("API keys share scope")
	}
}

func TestGCMirrorsWindowsAndRetriesFailedPersistence(t *testing.T) {
	paths := gcTestState(t, HostsState{SessionHosts: []SessionHostEntry{{Alias: "old.deleted.prod.amika", GCScope: "current"}}})
	winDir := t.TempDir()
	stubWSL(t, winDir, nil)
	list := func() ([]apiclient.RemoteSandbox, error) { return []apiclient.RemoteSandbox{}, nil }
	now := time.Now()
	// An existing directory at the output path forces the atomic rename to fail.
	configPath, _ := paths.SSHAmikaConfigFile()
	if err := os.MkdirAll(configPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := collectGarbage(paths, "current", "prod", list, GCOptions{}, now); err == nil {
		t.Fatal("expected write failure")
	}
	state, _ := LoadState(paths)
	if !state.GarbageCollection["current"].LastSuccess.IsZero() {
		t.Fatal("advanced success after write failure")
	}
	if err := os.Remove(configPath); err != nil {
		t.Fatal(err)
	}
	if _, err := collectGarbage(paths, "current", "prod", list, GCOptions{}, now.Add(gcRetryInterval)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(winDir, "amika.conf"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "Host old.deleted.prod.amika") {
		t.Fatalf("stale Windows mirror: %s", data)
	}
}
