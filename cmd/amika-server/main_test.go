package main

import (
	"flag"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gofixpoint/amika/internal/buildmeta"
)

func TestResolveListenAddr_Default(t *testing.T) {
	addr, err := resolveListenAddr(newTestFlagSet(), nil, mapEnv(nil))
	if err != nil {
		t.Fatalf("resolveListenAddr() error = %v", err)
	}
	if addr != ":8080" {
		t.Fatalf("resolveListenAddr() = %q, want %q", addr, ":8080")
	}
}

func TestResolveListenAddr_FromPort(t *testing.T) {
	addr, err := resolveListenAddr(newTestFlagSet(), nil, mapEnv(map[string]string{
		"PORT": "9090",
	}))
	if err != nil {
		t.Fatalf("resolveListenAddr() error = %v", err)
	}
	if addr != ":9090" {
		t.Fatalf("resolveListenAddr() = %q, want %q", addr, ":9090")
	}
}

func TestResolveListenAddr_FromAddrFlag(t *testing.T) {
	addr, err := resolveListenAddr(newTestFlagSet(), []string{"-addr", ":7070"}, mapEnv(nil))
	if err != nil {
		t.Fatalf("resolveListenAddr() error = %v", err)
	}
	if addr != ":7070" {
		t.Fatalf("resolveListenAddr() = %q, want %q", addr, ":7070")
	}
}

func TestResolveListenAddr_AddrAndPortMutuallyExclusive(t *testing.T) {
	_, err := resolveListenAddr(newTestFlagSet(), []string{"-addr", ":7070"}, mapEnv(map[string]string{
		"PORT": "9090",
	}))
	if err == nil {
		t.Fatal("resolveListenAddr() error = nil, want conflict error")
	}
	if !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("resolveListenAddr() error = %q, want mutually exclusive error", err.Error())
	}
}

func TestRunVersion(t *testing.T) {
	originalVersion := buildmeta.AmikaServerVersion
	t.Cleanup(func() {
		buildmeta.AmikaServerVersion = originalVersion
	})
	buildmeta.AmikaServerVersion = buildmeta.MustParseSemVer("v1.2.3-rc.1")

	buf := &strings.Builder{}
	called := false
	err := run([]string{"--version"}, buf, mapEnv(nil), func(_ string, _ http.Handler) error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if called {
		t.Fatal("run() started server for --version")
	}

	got := buf.String()
	if !strings.Contains(got, "amika-server version v1.2.3-rc.1") {
		t.Fatalf("run() output = %q, want version line", got)
	}
	if !strings.Contains(got, "commit: ") {
		t.Fatalf("run() output = %q, want commit line", got)
	}
}

func TestRunVersionIgnoresAddrConflicts(t *testing.T) {
	buf := &strings.Builder{}
	err := run([]string{"--version", "-addr", ":7070"}, buf, mapEnv(map[string]string{
		"PORT": "9090",
	}), func(_ string, _ http.Handler) error {
		t.Fatal("run() started server for --version")
		return nil
	})
	if err != nil {
		t.Fatalf("run() error = %v, want nil for --version", err)
	}
}

func newTestFlagSet() *flag.FlagSet {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

func mapEnv(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}
