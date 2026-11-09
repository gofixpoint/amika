// Package amikanet is the CLI's side of `amika-net`, the iroh sidecar: it
// finds the binary, keeps this machine's device key, and registers the key
// with the control plane.
//
// The contracts are amika-mono's
// specs/035-host-connection-drops.d/iroh-contracts.md, sections "Devices"
// and "SSH over iroh".
package amikanet

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/basedir"
)

// BinaryName is the sidecar's executable name, without a platform suffix.
const BinaryName = "amika-net"

const (
	dirName           = "amika-net"
	deviceKeyName     = "device.key"
	registrationsName = "registrations.json"
)

// ErrNotInstalled means no amika-net binary is next to amika or on PATH.
var ErrNotInstalled = errors.New("amika-net is not installed")

// ErrUnsafeKeyFile marks a device key file that other users can read, or
// that does not hold a 32-byte seed as base64.
var ErrUnsafeKeyFile = errors.New("unsafe or malformed amika-net device key file")

// FindBinary returns the amika-net next to the running amika binary, or
// else the one on PATH.
func FindBinary() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		executable = ""
	}
	return findBinary(executable, exec.LookPath)
}

// findBinary looks beside amikaPath first, also beside the file a symlink
// at amikaPath points to, and then on PATH through lookPath.
func findBinary(amikaPath string, lookPath func(string) (string, error)) (string, error) {
	name := BinaryName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if amikaPath != "" {
		dirs := []string{filepath.Dir(amikaPath)}
		if resolved, err := filepath.EvalSymlinks(amikaPath); err == nil && filepath.Dir(resolved) != dirs[0] {
			dirs = append(dirs, filepath.Dir(resolved))
		}
		for _, dir := range dirs {
			candidate := filepath.Join(dir, name)
			if isExecutable(candidate) {
				return candidate, nil
			}
		}
	}
	found, err := lookPath(BinaryName)
	if err != nil {
		return "", ErrNotInstalled
	}
	if absolute, err := filepath.Abs(found); err == nil {
		found = absolute
	}
	return found, nil
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode().Perm()&0o111 != 0
}

// DeviceKeyFile returns `<CLI config dir>/amika-net/device.key`.
func DeviceKeyFile(paths basedir.Paths) (string, error) {
	dir, err := paths.AmikaConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, dirName, deviceKeyName), nil
}

// LoadOrCreateDeviceKey returns the device key at path, and makes it first
// if the file does not exist. The file holds the 32-byte Ed25519 seed as
// base64, mode 0600. A key file that other users can read is refused, not
// repaired.
func LoadOrCreateDeviceKey(path string) (ed25519.PrivateKey, error) {
	key, err := loadDeviceKey(path)
	if !errors.Is(err, os.ErrNotExist) {
		return key, err
	}
	return createDeviceKey(path)
}

func loadDeviceKey(path string) (ed25519.PrivateKey, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return nil, fmt.Errorf("%w: %s must be a regular file with mode 0600", ErrUnsafeKeyFile, path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seed, err := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(data)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("%w: %s", ErrUnsafeKeyFile, path)
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// createDeviceKey writes a new key to a temporary file and links it into
// place, so two processes that start at once agree on one key, and neither
// reads a half-written file.
func createDeviceKey(path string) (ed25519.PrivateKey, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create %s: %w", dir, err)
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	defer clear(seed)
	temp, err := os.CreateTemp(dir, ".device.key-*")
	if err != nil {
		return nil, fmt.Errorf("create device key: %w", err)
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	encoded := base64.StdEncoding.EncodeToString(seed) + "\n"
	_, writeErr := temp.WriteString(encoded)
	if writeErr == nil {
		writeErr = temp.Chmod(0o600)
	}
	if writeErr == nil {
		writeErr = temp.Sync()
	}
	if closeErr := temp.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		return nil, fmt.Errorf("write device key: %w", writeErr)
	}
	if err := os.Link(tempPath, path); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, fmt.Errorf("install device key: %w", err)
	}
	return loadDeviceKey(path)
}

// EndpointID is the key's iroh endpoint id: its public key in lowercase hex.
func EndpointID(key ed25519.PrivateKey) string {
	return hex.EncodeToString(key.Public().(ed25519.PublicKey))
}

// Registrar registers a device key with the control plane.
type Registrar interface {
	RegisterDevice(apiclient.RegisterDeviceRequest) (*apiclient.Device, error)
}

// ErrKeyTaken means the control plane refused to register the device key
// because another user registered it: two Amika accounts on one machine
// share the key file. That account uses direct_ws.
var ErrKeyTaken = errors.New("the amika-net device key is registered to another user")

// Account names who registers the key: a control plane and a user on it.
// A second account on the same machine registers for itself.
type Account struct {
	// APIURL is the control plane's API base URL.
	APIURL string
	// UserID identifies the logged-in user.
	UserID string
}

func (a Account) recordKey() string { return a.APIURL + " " + a.UserID }

// Registrations records which accounts have registered this machine's
// device key, so the CLI registers it once per account. The file holds no
// secret.
type Registrations struct {
	path string
}

// registration is one account's record.
type registration struct {
	EndpointID string `json:"endpoint_id"`
	DeviceID   string `json:"device_id,omitempty"`
	// Taken records a refusal because another user has the key, so the
	// CLI does not ask again on every run.
	Taken bool `json:"taken,omitempty"`
}

type registrationsFile struct {
	// ByAccount maps "<API URL> <user id>" to its record.
	ByAccount map[string]registration `json:"by_account"`
}

// OpenRegistrations returns the registration records beside the device key.
func OpenRegistrations(paths basedir.Paths) (Registrations, error) {
	dir, err := paths.AmikaConfigDir()
	if err != nil {
		return Registrations{}, err
	}
	return Registrations{path: filepath.Join(dir, dirName, registrationsName)}, nil
}

// Ensure registers key for account unless a record says the account
// already has this endpoint id. It returns the device id. It returns
// ErrKeyTaken, without a request after the first, when the control plane
// answers 409 because another user has the key.
func (r Registrations) Ensure(account Account, registrar Registrar, key ed25519.PrivateKey) (string, error) {
	if account.APIURL == "" || account.UserID == "" {
		return "", errors.New("register device: no logged-in account")
	}
	endpointID := EndpointID(key)
	if record, ok := r.load().ByAccount[account.recordKey()]; ok && record.EndpointID == endpointID {
		if record.Taken {
			return "", ErrKeyTaken
		}
		if record.DeviceID != "" {
			return record.DeviceID, nil
		}
	}
	device, err := registrar.RegisterDevice(apiclient.RegisterDeviceRequest{
		EndpointID: endpointID,
		Name:       deviceName(),
		Platform:   runtime.GOOS,
	})
	var httpErr *apiclient.HTTPError
	if errors.As(err, &httpErr) && httpErr.StatusCode == 409 {
		if saveErr := r.put(account, registration{EndpointID: endpointID, Taken: true}); saveErr != nil {
			return "", fmt.Errorf("record device registration: %w", saveErr)
		}
		return "", ErrKeyTaken
	}
	if err != nil {
		return "", err
	}
	if err := r.put(account, registration{EndpointID: endpointID, DeviceID: device.DeviceID}); err != nil {
		return "", fmt.Errorf("record device registration: %w", err)
	}
	return device.DeviceID, nil
}

// Forget drops account's record, so the next Ensure registers again. The
// CLI calls it when the host refuses the device, which is what a control
// plane that no longer knows the device looks like.
func (r Registrations) Forget(account Account) error {
	records := r.load()
	if _, ok := records.ByAccount[account.recordKey()]; !ok {
		return nil
	}
	delete(records.ByAccount, account.recordKey())
	return r.save(records)
}

func (r Registrations) put(account Account, record registration) error {
	records := r.load()
	records.ByAccount[account.recordKey()] = record
	return r.save(records)
}

// load reads the records. A missing or unreadable file is no records: the
// cost is one more registration, which is safe to repeat.
func (r Registrations) load() registrationsFile {
	records := registrationsFile{}
	if data, err := os.ReadFile(r.path); err == nil {
		_ = json.Unmarshal(data, &records)
	}
	if records.ByAccount == nil {
		records.ByAccount = map[string]registration{}
	}
	return records
}

func (r Registrations) save(records registrationsFile) error {
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(r.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".registrations-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	_, writeErr := temp.Write(append(data, '\n'))
	if closeErr := temp.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		return writeErr
	}
	return os.Rename(temp.Name(), r.path)
}

// deviceName names the device for the user's device list: the host name,
// cut to 64 bytes.
func deviceName() string {
	name, err := os.Hostname()
	if err != nil || name == "" {
		name = "unknown"
	}
	if len(name) > 64 {
		name = name[:64]
	}
	return name
}
