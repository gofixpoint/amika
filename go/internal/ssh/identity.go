package ssh

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	cryptossh "golang.org/x/crypto/ssh"
)

// GenerateIdentity creates or validates an unencrypted user-owned Ed25519
// keypair and returns its canonical public key.
func GenerateIdentity(privatePath string) (string, error) {
	publicPath := privatePath + ".pub"
	privateData, privateErr := os.ReadFile(privatePath)
	publicData, publicErr := os.ReadFile(publicPath)
	if privateErr == nil || publicErr == nil {
		if privateErr != nil || publicErr != nil {
			return "", fmt.Errorf("incomplete SSH identity pair")
		}
		privateInfo, err := os.Stat(privatePath)
		if err != nil || privateInfo.Mode().Perm() != 0o600 {
			return "", fmt.Errorf("SSH private key must have mode 0600")
		}
		signer, err := cryptossh.ParsePrivateKey(privateData)
		if err != nil || signer.PublicKey().Type() != cryptossh.KeyAlgoED25519 {
			return "", fmt.Errorf("existing SSH private key is not a valid Ed25519 key")
		}
		canonical, err := canonicalHostPublicKey(string(publicData))
		if err != nil || !bytes.Equal(signer.PublicKey().Marshal(), mustParsePublicKey(canonical).Marshal()) {
			return "", fmt.Errorf("existing SSH keypair does not match")
		}
		return canonical, nil
	}
	if !errors.Is(privateErr, os.ErrNotExist) || !errors.Is(publicErr, os.ErrNotExist) {
		return "", errors.Join(privateErr, publicErr)
	}

	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	privateBlock, err := cryptossh.MarshalPrivateKey(privateKey, "amika SSH identity")
	if err != nil {
		return "", err
	}
	publicKey, err := cryptossh.NewPublicKey(privateKey.Public())
	if err != nil {
		return "", err
	}
	canonical := strings.TrimSpace(string(cryptossh.MarshalAuthorizedKey(publicKey)))
	if err := writeFileAtomic(privatePath, pem.EncodeToMemory(privateBlock), 0o600); err != nil {
		return "", err
	}
	if err := writeFileAtomic(publicPath, []byte(canonical+"\n"), 0o644); err != nil {
		return "", err
	}
	return canonical, nil
}

// ImportIdentity validates a public key and its conventional matching private
// key path without copying private material.
func ImportIdentity(publicPath string) (identityPath, canonicalPublicKey string, err error) {
	if filepath.Ext(publicPath) != ".pub" {
		return "", "", fmt.Errorf("imported public key path must end in .pub")
	}
	publicData, err := os.ReadFile(publicPath)
	if err != nil {
		return "", "", err
	}
	canonical, err := canonicalHostPublicKey(string(publicData))
	if err != nil {
		return "", "", err
	}
	privatePath := strings.TrimSuffix(publicPath, ".pub")
	privateInfo, err := os.Stat(privatePath)
	if err != nil || !privateInfo.Mode().IsRegular() || privateInfo.Mode().Perm()&0o077 != 0 {
		return "", "", fmt.Errorf("matching private key is missing or not owner-only")
	}
	return privatePath, canonical, nil
}

func mustParsePublicKey(value string) cryptossh.PublicKey {
	key, _, _, _, _ := cryptossh.ParseAuthorizedKey([]byte(value))
	return key
}
