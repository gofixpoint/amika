package norelay

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"io/fs"
)

// TokenBytes is the decoded size of a no-relay connect token.
const TokenBytes = 32

const encodedTokenBytes = 43

// TokenFileReader reads the current token for every upgrade so rotation takes
// effect without restarting the long-running server process.
type TokenFileReader interface {
	ReadFile(string) ([]byte, error)
	Lstat(string) (fs.FileInfo, error)
}

// FileTokenVerifier compares a canonical base64url token from disk in constant
// time. It fails closed when the file is absent, linked, malformed, or not
// owner-only.
type FileTokenVerifier struct {
	path  string
	files TokenFileReader
}

// NewFileTokenVerifier creates a verifier for one explicit token file.
func NewFileTokenVerifier(path string, files TokenFileReader) *FileTokenVerifier {
	return &FileTokenVerifier{path: path, files: files}
}

// Verify authenticates candidate against the current token file.
func (v *FileTokenVerifier) Verify(candidate string) bool {
	stored, ok := v.currentToken()
	if !ok || !IsCanonicalToken(candidate) {
		return false
	}
	storedDigest := sha256.Sum256(stored)
	candidateDigest := sha256.Sum256([]byte(candidate))
	return subtle.ConstantTimeCompare(storedDigest[:], candidateDigest[:]) == 1
}

// Ready reports whether the current token file is safe and canonical without
// returning its contents.
func (v *FileTokenVerifier) Ready() bool {
	_, ok := v.currentToken()
	return ok
}

func (v *FileTokenVerifier) currentToken() ([]byte, bool) {
	info, err := v.files.Lstat(v.path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Size() != encodedTokenBytes {
		return nil, false
	}
	stored, err := v.files.ReadFile(v.path)
	if err != nil || !IsCanonicalToken(string(stored)) {
		return nil, false
	}
	return stored, true
}

// IsCanonicalToken reports whether token is exactly 32 random bytes encoded
// with unpadded URL-safe base64.
func IsCanonicalToken(token string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(decoded) == TokenBytes && base64.RawURLEncoding.EncodeToString(decoded) == token
}
