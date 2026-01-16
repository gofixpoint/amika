# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Build the binary
go build -o dist/wisp ./cmd/wisp

# Run the binary
dist/wisp

# Run tests
go test ./...
```

## Project Overview

Wisp is a Go CLI tool. The project uses standard Go tooling with no external build systems.

## Code Structure

- `cmd/wisp/main.go` - Main entry point for the CLI
- `dist/` - Build output directory (gitignored)
- `bin/wisp` - Symlink to the compiled binary

## Development Notes

- Requires Go 1.21 or later
- No linter is currently configured
- No external dependencies yet
