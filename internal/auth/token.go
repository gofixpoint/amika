package auth

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofixpoint/amika/internal/config"
)

const sessionFileName = "workos-session.json"

// WorkOSSession holds the persisted WorkOS authentication state.
type WorkOSSession struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	UserID       string    `json:"user_id"`
	Email        string    `json:"email"`
	OrgID        string    `json:"organization_id"`
	ExpiresAt    time.Time `json:"expires_at"`
}

func sessionPath() (string, error) {
	dir, err := config.StateDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, sessionFileName), nil
}

// SaveSession writes the session to disk with restricted permissions.
func SaveSession(session WorkOSSession) error {
	path, err := sessionPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

// LoadSession reads the persisted session. Returns nil, nil if no session file exists.
func LoadSession() (*WorkOSSession, error) {
	path, err := sessionPath()
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
	var session WorkOSSession
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, fmt.Errorf("corrupt session file: %w", err)
	}
	return &session, nil
}

// DeleteSession removes the persisted session file.
func DeleteSession() error {
	path, err := sessionPath()
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// ParseJWTExpiry decodes the JWT payload (without verification) to extract the exp claim.
func ParseJWTExpiry(accessToken string) (time.Time, error) {
	parts := strings.Split(accessToken, ".")
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("invalid JWT: expected 3 parts, got %d", len(parts))
	}
	payload := parts[1]
	// Add padding if needed.
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}
	data, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid JWT payload: %w", err)
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(data, &claims); err != nil {
		return time.Time{}, fmt.Errorf("invalid JWT claims: %w", err)
	}
	if claims.Exp == 0 {
		return time.Time{}, fmt.Errorf("JWT missing exp claim")
	}
	return time.Unix(claims.Exp, 0), nil
}
