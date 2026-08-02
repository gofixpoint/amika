// Package sshd owns loopback-only OpenSSH configuration and supervision.
package sshd

import (
	"context"
	"errors"
	"io"
)

// ErrNotImplemented marks the fail-closed sshd stub.
var ErrNotImplemented = errors.New("amikad sshd manager is not implemented")

// Manager controls the daemon-owned OpenSSH instance.
type Manager interface {
	Setup(context.Context) error
	ShowHostKey(context.Context, io.Writer) error
	SetAuthorizedKeys(context.Context, io.Reader) error
	Serve(context.Context) error
}

// UnimplementedManager rejects every operation without file or process changes.
type UnimplementedManager struct{}

// Setup returns ErrNotImplemented without changing configuration.
func (UnimplementedManager) Setup(context.Context) error { return ErrNotImplemented }

// ShowHostKey returns ErrNotImplemented without writing output.
func (UnimplementedManager) ShowHostKey(context.Context, io.Writer) error {
	return ErrNotImplemented
}

// SetAuthorizedKeys returns ErrNotImplemented without reading input.
func (UnimplementedManager) SetAuthorizedKeys(context.Context, io.Reader) error {
	return ErrNotImplemented
}

// Serve returns ErrNotImplemented without starting sshd.
func (UnimplementedManager) Serve(context.Context) error { return ErrNotImplemented }
