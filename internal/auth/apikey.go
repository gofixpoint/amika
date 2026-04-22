package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofixpoint/amika/internal/config"
)

// ErrCorruptAPIKey is returned by LoadAPIKey when the file exists but
// cannot be parsed or is missing the key value.
var ErrCorruptAPIKey = errors.New("corrupt API key file")

// APIKeyAuth holds a persisted WorkOS organization API key used as a static bearer token.
type APIKeyAuth struct {
	Key      string    `json:"key"`
	StoredAt time.Time `json:"stored_at"`
}

// SaveAPIKey writes the API key to disk with restricted permissions.
func SaveAPIKey(a APIKeyAuth) error {
	path, err := config.APIKeyFile()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

// LoadAPIKey reads the persisted API key. Returns nil, nil if no file exists.
func LoadAPIKey() (*APIKeyAuth, error) {
	path, err := config.APIKeyFile()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var a APIKeyAuth
	if err := json.Unmarshal(data, &a); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCorruptAPIKey, err)
	}
	if a.Key == "" {
		return nil, fmt.Errorf("%w: empty key", ErrCorruptAPIKey)
	}
	return &a, nil
}

// DeleteAPIKey removes the persisted API key file.
func DeleteAPIKey() error {
	path, err := config.APIKeyFile()
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// ReadAPIKeyFromReader reads an API key from r, trimming surrounding whitespace.
// Returns an error when the result is empty.
func ReadAPIKeyFromReader(r io.Reader) (string, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return "", err
	}
	key := strings.TrimSpace(string(data))
	if key == "" {
		return "", fmt.Errorf("API key is empty")
	}
	return key, nil
}
