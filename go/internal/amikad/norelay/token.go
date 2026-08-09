package norelay

// This file implements only the sandbox-side verification half of the
// no-relay connect-token system. The full round trip:
//
//  1. The control plane (js/coding-agents in the ssh-relay repo) generates a
//     random 32-byte token per rotation, base64url-encodes it, and delivers
//     the plaintext to this sandbox over the provider's exec/stdin channel by
//     invoking `amikad connect-token set` — never a CLI argument, so it never
//     appears in `ps` or shell history. See operations.go's SetConnectToken
//     for the write side.
//  2. The control plane keeps only a SHA-256 hash of the token (plus a
//     Vault-encrypted copy) in its own database, and hands the plaintext back
//     to an authorized CLI caller as a bearer credential scoped to one SSH
//     session.
//  3. FileTokenVerifier below re-reads the on-disk token on every WebSocket
//     upgrade (see handler.go), so a control-plane rotation takes effect
//     immediately without restarting `amikad serve`. It fails closed on
//     anything but an owner-only, exact-size, canonically-encoded token file,
//     and never returns the stored value to callers — only whether a
//     candidate matches.
//
// This file has no knowledge of Vault, orgs, or rotation history; it only
// answers "does this candidate match what's currently on disk."

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
