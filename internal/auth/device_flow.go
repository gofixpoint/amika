package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

const workosDeviceAuthorizeURL = "https://api.workos.com/user_management/authorize/device"

type deviceCodeResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// DeviceLogin performs the OAuth 2.0 Device Authorization Flow via WorkOS.
// The sessionTTL controls how long the overall session remains valid before
// the user must log in again. Pass 0 to use DefaultSessionTTL.
func DeviceLogin(clientID string, sessionTTL time.Duration) (*WorkOSSession, error) {
	if sessionTTL == 0 {
		sessionTTL = DefaultSessionTTL
	}
	// Step 1: Request device code.
	dc, err := requestDeviceCode(clientID)
	if err != nil {
		return nil, err
	}

	// Step 2: Display instructions and open browser.
	fmt.Printf("\nYour authorization code is: %s\n\n", dc.UserCode)
	fmt.Printf("Opening browser to: %s\n", dc.VerificationURIComplete)
	fmt.Printf("Or visit %s and enter the code manually.\n\n", dc.VerificationURI)
	openBrowser(dc.VerificationURIComplete)

	// Step 3: Poll for token.
	return pollForToken(clientID, dc, sessionTTL)
}

func requestDeviceCode(clientID string) (*deviceCodeResponse, error) {
	body := url.Values{
		"client_id": {clientID},
	}

	resp, err := http.Post(workosDeviceAuthorizeURL, "application/x-www-form-urlencoded", strings.NewReader(body.Encode()))
	if err != nil {
		return nil, fmt.Errorf("device authorize request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("reading device authorize response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("device authorize failed (HTTP %d): %s", resp.StatusCode, string(respBody))
	}

	var dc deviceCodeResponse
	if err := json.Unmarshal(respBody, &dc); err != nil {
		return nil, fmt.Errorf("parsing device authorize response: %w", err)
	}

	if dc.Interval == 0 {
		dc.Interval = 5
	}
	return &dc, nil
}

func pollForToken(clientID string, dc *deviceCodeResponse, sessionTTL time.Duration) (*WorkOSSession, error) {
	interval := time.Duration(dc.Interval) * time.Second
	deadline := time.Now().Add(time.Duration(dc.ExpiresIn) * time.Second)

	body := url.Values{
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		"device_code": {dc.DeviceCode},
		"client_id":   {clientID},
	}

	fmt.Print("Waiting for authorization...")

	for {
		if time.Now().After(deadline) {
			fmt.Println()
			return nil, fmt.Errorf("authorization expired, please try again")
		}

		time.Sleep(interval)
		fmt.Print(".")

		resp, err := http.Post(workosAuthenticateURL, "application/x-www-form-urlencoded", strings.NewReader(body.Encode()))
		if err != nil {
			continue
		}

		respBody, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			continue
		}

		if resp.StatusCode == http.StatusOK {
			fmt.Println()
			return parseTokenResponse(respBody, sessionTTL)
		}

		var errResp struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(respBody, &errResp); err != nil {
			continue
		}

		switch errResp.Error {
		case "authorization_pending":
			// Keep polling.
		case "slow_down":
			interval += time.Second
		case "access_denied":
			fmt.Println()
			return nil, fmt.Errorf("authorization denied")
		case "expired_token":
			fmt.Println()
			return nil, fmt.Errorf("authorization expired, please try again")
		default:
			fmt.Println()
			return nil, fmt.Errorf("unexpected error: %s", errResp.Error)
		}
	}
}

func parseTokenResponse(respBody []byte, sessionTTL time.Duration) (*WorkOSSession, error) {
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
		return nil, fmt.Errorf("parsing token response: %w", err)
	}

	expiresAt, err := ParseJWTExpiry(result.AccessToken)
	if err != nil {
		return nil, fmt.Errorf("parsing token expiry: %w", err)
	}

	session := &WorkOSSession{
		AccessToken:      result.AccessToken,
		RefreshToken:     result.RefreshToken,
		UserID:           result.User.ID,
		Email:            result.User.Email,
		OrgID:            result.OrganizationID,
		ExpiresAt:        expiresAt,
		SessionExpiresAt: time.Now().Add(sessionTTL),
	}

	if err := SaveSession(*session); err != nil {
		return nil, fmt.Errorf("saving session: %w", err)
	}
	return session, nil
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		return
	}
	_ = cmd.Start()
}
