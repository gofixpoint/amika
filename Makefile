.PHONY: build test vet fmt fmtcheck lint ci setup

build:
	mkdir -p dist
	go build -o dist/amika ./cmd/amika

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

fmtcheck:
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then \
		echo "Unformatted files:"; \
		echo "$$unformatted"; \
		exit 1; \
	fi

lint:
	go run github.com/mgechev/revive@v1.14.0 -set_exit_status -config revive.toml ./...

ci: fmtcheck vet lint build test

setup:
	./setup-repo.sh
