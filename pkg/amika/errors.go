package amika

import "errors"

var (
	// ErrInvalidArgument indicates a request failed validation.
	ErrInvalidArgument = errors.New("invalid argument")
	// ErrNotFound indicates a named resource does not exist.
	ErrNotFound = errors.New("not found")
	// ErrDependency indicates an external dependency failed (for example Docker).
	ErrDependency = errors.New("dependency failure")
	// ErrInternal indicates an internal runtime failure.
	ErrInternal = errors.New("internal error")
	// ErrUnimplemented indicates behavior has not been wired yet.
	ErrUnimplemented = errors.New("unimplemented")
)
