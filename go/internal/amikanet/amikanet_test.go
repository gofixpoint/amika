package amikanet

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
)

func TestDeviceKeyFileIsUnderTheCLIConfigDir(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/home/u/.config")
	path, err := DeviceKeyFile(basedir.New(""))
	if err != nil {
		t.Fatal(err)
	}
	if path != "/home/u/.config/amika/amika-net/device.key" {
		t.Fatalf("path = %q", path)
	}
}

func TestDeviceKeyIsMadeOnFirstUseAsBase64SeedMode0600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "amika-net", "device.key")
	key, err := LoadOrCreateDeviceKey(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	seed, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(data)))
	if err != nil || len(seed) != ed25519.SeedSize {
		t.Fatalf("file %q is not a base64 32-byte seed", data)
	}
	if !bytes.Equal(seed, key.Seed()) {
		t.Fatal("file seed is not the returned key's seed")
	}

	again, err := LoadOrCreateDeviceKey(path)
	if err != nil || !again.Equal(key) {
		t.Fatalf("reload = %v, same key %v", err, again.Equal(key))
	}
	id := EndpointID(key)
	if id != hex.EncodeToString(key.Public().(ed25519.PublicKey)) || len(id) != 64 {
		t.Fatalf("endpoint id = %q", id)
	}
}

func TestDeviceKeyReadsAnExistingSeed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device.key")
	seed := bytes.Repeat([]byte{7}, ed25519.SeedSize)
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(seed)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	key, err := LoadOrCreateDeviceKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if !key.Equal(ed25519.NewKeyFromSeed(seed)) {
		t.Fatal("loaded a different key")
	}
}

func TestDeviceKeyRefusesAnUnsafeOrMalformedFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("modes are not checked on Windows")
	}
	dir := t.TempDir()
	valid := base64.StdEncoding.EncodeToString(make([]byte, ed25519.SeedSize))
	for name, file := range map[string]struct {
		content string
		mode    os.FileMode
	}{
		"group readable": {valid, 0o640},
		"world readable": {valid, 0o604},
		"hex not base64": {hex.EncodeToString(make([]byte, 32)), 0o600},
		"short seed":     {base64.StdEncoding.EncodeToString(make([]byte, 16)), 0o600},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(dir, name)
			if err := os.WriteFile(path, []byte(file.content), file.mode); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, file.mode); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadOrCreateDeviceKey(path); !errors.Is(err, ErrUnsafeKeyFile) {
				t.Fatalf("err = %v, want ErrUnsafeKeyFile", err)
			}
		})
	}
}

func TestConcurrentFirstUseAgreesOnOneKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "amika-net", "device.key")
	keys := make([]ed25519.PrivateKey, 8)
	errs := make([]error, len(keys))
	var wg sync.WaitGroup
	for i := range keys {
		wg.Go(func() { keys[i], errs[i] = LoadOrCreateDeviceKey(path) })
	}
	wg.Wait()
	for i := range keys {
		if errs[i] != nil || !keys[i].Equal(keys[0]) {
			t.Fatalf("process %d: err %v, same key %v", i, errs[i], keys[i].Equal(keys[0]))
		}
	}
}

func TestFindBinaryPrefersTheOneNextToAmika(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses Unix executable bits")
	}
	dir := t.TempDir()
	amika := writeExecutable(t, filepath.Join(dir, "bin", "amika"))
	beside := writeExecutable(t, filepath.Join(dir, "bin", BinaryName))
	onPath := writeExecutable(t, filepath.Join(dir, "path", BinaryName))
	lookPath := func(string) (string, error) { return onPath, nil }

	if got, err := findBinary(amika, lookPath); err != nil || got != beside {
		t.Fatalf("beside amika: %q, %v", got, err)
	}
	if err := os.Remove(beside); err != nil {
		t.Fatal(err)
	}
	if got, err := findBinary(amika, lookPath); err != nil || got != onPath {
		t.Fatalf("on PATH: %q, %v", got, err)
	}
	missing := func(string) (string, error) { return "", errors.New("not found") }
	if _, err := findBinary(amika, missing); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("missing: %v", err)
	}
}

func TestFindBinaryFollowsASymlinkedAmika(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses Unix symlinks")
	}
	dir := t.TempDir()
	target := writeExecutable(t, filepath.Join(dir, "opt", "amika"))
	beside := writeExecutable(t, filepath.Join(dir, "opt", BinaryName))
	link := filepath.Join(dir, "bin", "amika")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	missing := func(string) (string, error) { return "", errors.New("not found") }
	got, err := findBinary(link, missing)
	if err != nil {
		t.Fatal(err)
	}
	if resolved, _ := filepath.EvalSymlinks(got); resolved != mustEval(t, beside) {
		t.Fatalf("found %q, want %q", got, beside)
	}
}

func TestFindBinarySkipsAFileThatIsNotExecutable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses Unix executable bits")
	}
	dir := t.TempDir()
	amika := writeExecutable(t, filepath.Join(dir, "amika"))
	if err := os.WriteFile(filepath.Join(dir, BinaryName), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	missing := func(string) (string, error) { return "", errors.New("not found") }
	if _, err := findBinary(amika, missing); !errors.Is(err, ErrNotInstalled) {
		t.Fatalf("err = %v", err)
	}
}

type fakeRegistrar struct {
	requests []apiclient.RegisterDeviceRequest
	err      error
}

func (r *fakeRegistrar) RegisterDevice(request apiclient.RegisterDeviceRequest) (*apiclient.Device, error) {
	r.requests = append(r.requests, request)
	if r.err != nil {
		return nil, r.err
	}
	return &apiclient.Device{DeviceID: "dev_01"}, nil
}

func TestRegistrationHappensOncePerControlPlane(t *testing.T) {
	paths := basedir.New(t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	registrations, err := OpenRegistrations(paths)
	if err != nil {
		t.Fatal(err)
	}
	key := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	registrar := &fakeRegistrar{}

	for range 2 {
		id, err := registrations.Ensure("https://app.amika.dev", registrar, key)
		if err != nil || id != "dev_01" {
			t.Fatalf("Ensure = %q, %v", id, err)
		}
	}
	if len(registrar.requests) != 1 {
		t.Fatalf("registrations = %d, want 1", len(registrar.requests))
	}
	request := registrar.requests[0]
	if request.EndpointID != EndpointID(key) || request.Platform != runtime.GOOS || request.Name == "" {
		t.Fatalf("request = %+v", request)
	}

	if _, err := registrations.Ensure("https://staging.amika.dev", registrar, key); err != nil {
		t.Fatal(err)
	}
	if len(registrar.requests) != 2 {
		t.Fatalf("a second control plane did not register: %d", len(registrar.requests))
	}

	otherKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, ed25519.SeedSize))
	if _, err := registrations.Ensure("https://app.amika.dev", registrar, otherKey); err != nil {
		t.Fatal(err)
	}
	if len(registrar.requests) != 3 {
		t.Fatalf("a new key did not register: %d", len(registrar.requests))
	}
}

func TestForgetMakesTheNextEnsureRegisterAgain(t *testing.T) {
	paths := basedir.New(t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	registrations, _ := OpenRegistrations(paths)
	key := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	registrar := &fakeRegistrar{}
	if _, err := registrations.Ensure("https://app.amika.dev", registrar, key); err != nil {
		t.Fatal(err)
	}
	if err := registrations.Forget("https://app.amika.dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := registrations.Ensure("https://app.amika.dev", registrar, key); err != nil {
		t.Fatal(err)
	}
	if len(registrar.requests) != 2 {
		t.Fatalf("registrations = %d, want 2", len(registrar.requests))
	}
}

func TestAFailedRegistrationIsNotRecorded(t *testing.T) {
	paths := basedir.New(t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	registrations, _ := OpenRegistrations(paths)
	key := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	failing := &fakeRegistrar{err: errors.New("HTTP 503")}
	if _, err := registrations.Ensure("https://app.amika.dev", failing, key); err == nil {
		t.Fatal("Ensure succeeded")
	}
	working := &fakeRegistrar{}
	if _, err := registrations.Ensure("https://app.amika.dev", working, key); err != nil || len(working.requests) != 1 {
		t.Fatalf("retry: %v, %d requests", err, len(working.requests))
	}
}

func writeExecutable(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func mustEval(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}
