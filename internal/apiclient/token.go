package apiclient

import (
	"fmt"
	"os"

	"github.com/gofixpoint/amika/internal/auth"
	"github.com/gofixpoint/amika/internal/config"
)

// TokenSource provides a bearer token for API requests.
type TokenSource interface {
	Token() (string, error)
}

type staticTokenSource struct {
	accessToken string
}

// NewStaticTokenSource returns a TokenSource that always returns the given token.
func NewStaticTokenSource(accessToken string) TokenSource {
	return &staticTokenSource{accessToken: accessToken}
}

func (s *staticTokenSource) Token() (string, error) {
	return s.accessToken, nil
}

type workosTokenSource struct {
	clientID string
}

// NewWorkOSTokenSource returns a TokenSource that loads and auto-refreshes
// a WorkOS session, returning the current access token.
func NewWorkOSTokenSource(clientID string) TokenSource {
	return &workosTokenSource{clientID: clientID}
}

func (s *workosTokenSource) Token() (string, error) {
	session, err := auth.GetValidSession(s.clientID)
	if err != nil {
		return "", err
	}
	return session.AccessToken, nil
}

type resolvedTokenSource struct {
	clientID string
}

// NewResolvedTokenSource returns a TokenSource that resolves credentials fresh
// on each Token() call using the precedence: AMIKA_API_KEY env var > stored
// API key file > WorkOS session (with auto-refresh).
func NewResolvedTokenSource(clientID string) TokenSource {
	return &resolvedTokenSource{clientID: clientID}
}

func (s *resolvedTokenSource) Token() (string, error) {
	if key := os.Getenv(config.EnvAPIKey); key != "" {
		return key, nil
	}
	// An unreadable API key file must not block fall-through to the
	// session: `auth status` already treats corrupt files as "skip,
	// try the next source", so the resolver has to agree — otherwise
	// status reports the user is authenticated while every request
	// fails. The load error is combined with any downstream error so
	// the final message still mentions the bad file.
	stored, keyErr := auth.LoadAPIKey()
	if keyErr == nil && stored != nil {
		return stored.Key, nil
	}
	session, sessErr := auth.GetValidSession(s.clientID)
	if sessErr == nil {
		return session.AccessToken, nil
	}
	if keyErr != nil {
		return "", fmt.Errorf("no usable credential: stored API key unreadable (%v); %w", keyErr, sessErr)
	}
	return "", sessErr
}
