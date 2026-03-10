package auth

import (
	"fmt"
	"time"
)

// GetValidSession loads the current session and refreshes it if expired.
// Returns an error if no session exists (user needs to run "amika auth login").
func GetValidSession(clientID string) (*WorkOSSession, error) {
	session, err := LoadSession()
	if err != nil {
		return nil, fmt.Errorf("loading session: %w", err)
	}
	if session == nil {
		return nil, fmt.Errorf("not logged in, run: amika auth login")
	}

	// Refresh if token expires within 60 seconds.
	if time.Until(session.ExpiresAt) < 60*time.Second {
		session, err = RefreshAccessToken(clientID, session.RefreshToken)
		if err != nil {
			return nil, fmt.Errorf("session expired and refresh failed: %w", err)
		}
	}
	return session, nil
}
