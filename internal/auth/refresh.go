package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// workosAuthenticateURL is the WorkOS endpoint used for both refresh-token
// exchange and device-authorization polling. It is a var (not a const) so
// tests can point it at a local httptest server.
var workosAuthenticateURL = "https://api.workos.com/user_management/authenticate"

// SetWorkOSAuthenticateURLForTesting overrides the WorkOS authenticate URL
// and returns a function that restores the previous value. Intended only
// for use in cross-package tests.
func SetWorkOSAuthenticateURLForTesting(url string) func() {
	prev := workosAuthenticateURL
	workosAuthenticateURL = url
	return func() { workosAuthenticateURL = prev }
}

// RefreshAccessToken exchanges a refresh token for a new access token via WorkOS.
func RefreshAccessToken(clientID, refreshToken string) (*WorkOSSession, error) {
	body := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {clientID},
	}

	resp, err := http.Post(workosAuthenticateURL, "application/x-www-form-urlencoded", strings.NewReader(body.Encode()))
	if err != nil {
		return nil, fmt.Errorf("refresh request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading refresh response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("refresh failed (HTTP %d): %s", resp.StatusCode, string(respBody))
	}

	var result struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		User         struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"user"`
		OrganizationID string `json:"organization_id"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("parsing refresh response: %w", err)
	}

	expiresAt, err := ParseJWTExpiry(result.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("parsing token expiry: %w", err)
	}

	session := &WorkOSSession{
		AccessToken:  result.AccessToken,
		RefreshToken: result.RefreshToken,
		UserID:       result.User.ID,
		Email:        result.User.Email,
		OrgID:        result.OrganizationID,
		ExpiresAt:    expiresAt,
	}

	if err := SaveSession(*session); err != nil {
		return nil, fmt.Errorf("saving refreshed session: %w", err)
	}
	return session, nil
}
