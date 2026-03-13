.PHONY: goenv build build-cli build-server clean test test-unit test-integration test-contract test-expensive test-all coverage vet fmt fmtcheck lint ci setup

UNIT_PACKAGES = $$(go list ./... | grep -Ev '/test/(integration|contract)($$|/)')
GOFMT_FILES = git ls-files -z --cached --others --exclude-standard -- '*.go'

export GOCACHE := $(CURDIR)/.gocache
export GOTMPDIR := $(CURDIR)/.gotmp

goenv:
	mkdir -p "$(GOCACHE)" "$(GOTMPDIR)"

build: build-cli build-server

build-cli: goenv
	mkdir -p dist
	go build -o dist/amika ./cmd/amika

build-server: goenv
	mkdir -p dist
	go build -o dist/amika-server ./cmd/amika-server

clean:
	rm -rf dist .gocache .gotmp .gomodcache

clean-docker:
	docker image rm amika/coder:latest amika/base:latest

test: goenv
	go test ./...

test-unit: goenv
	@pkgs="$(UNIT_PACKAGES)"; \
	go test $$pkgs

test-integration: goenv
	go test ./test/integration/...

test-contract: goenv
	go test ./test/contract/...

test-expensive: goenv
	AMIKA_RUN_DOCKER_INTEGRATION=1 AMIKA_RUN_EXPENSIVE_TESTS=1 $(MAKE) test-all

test-all: test-unit test-integration test-contract

coverage: goenv
	./scripts/test/check_coverage.sh

vet: goenv
	go vet ./...

fmt:
	@$(GOFMT_FILES) | xargs -0 sh -c '[ "$$#" -eq 0 ] || gofmt -w "$$@"' sh

fmtcheck:
	@unformatted=$$($(GOFMT_FILES) | xargs -0 sh -c '[ "$$#" -eq 0 ] || gofmt -l "$$@"' sh); \
	if [ -n "$$unformatted" ]; then \
		echo "Unformatted files:"; \
		echo "$$unformatted"; \
		exit 1; \
	fi

lint: goenv
	go run github.com/mgechev/revive@v1.14.0 -set_exit_status -config revive.toml ./...

ci: fmtcheck vet lint build test-unit test-integration test-contract coverage

setup:
	./setup-repo.sh
