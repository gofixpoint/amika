package apiclient

import "github.com/gofixpoint/amika/internal/auth"

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
