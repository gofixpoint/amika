# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Build the binary
go build -o dist/clawbox ./cmd/clawbox

# Run the binary
dist/clawbox

# Run tests
go test ./...
```

## Project Overview

Clawbox is a Go CLI tool. The project uses standard Go tooling with no external build systems.

## Code Structure

- `cmd/clawbox/main.go` - Main entry point for the CLI
- `dist/` - Build output directory (gitignored)
- `bin/clawbox` - Wrapper script that auto-builds and runs dist/clawbox

## Development Notes

- Requires Go 1.21 or later
- No linter is currently configured
- No external dependencies yet
