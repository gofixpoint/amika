# Contributing

## Prerequisites

- Go 1.21 or later

## Development

```bash
# Run all CI checks locally (fmt, vet, lint, build, test)
make ci

# Individual targets
make build   # go build ./...
make test    # go test ./...
make vet     # go vet ./...
make fmt     # check formatting
make lint    # run revive linter
```

## Running

```bash
dist/amika
```
