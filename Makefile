.PHONY: goenv build build-cli build-server build-akfs clean test test-unit test-integration test-contract test-expensive test-all coverage vet fmt fmtcheck lint shellcheck ci setup

GO_DIR = go
UNIT_PACKAGES = $$(go -C $(GO_DIR) list ./... | grep -Ev '/test/(integration|contract)($$|/)')
GOFMT_FILES = git ls-files -z --cached --others --exclude-standard -- '*.go'

export GOCACHE := $(CURDIR)/.gocache
export GOTMPDIR := $(CURDIR)/.gotmp

goenv:
	mkdir -p "$(GOCACHE)" "$(GOTMPDIR)"

build: build-cli build-server build-akfs

build-cli: goenv
	mkdir -p dist
	go -C $(GO_DIR) build -o $(CURDIR)/dist/amika ./cmd/amika

build-server: goenv
	mkdir -p dist
	go -C $(GO_DIR) build -o $(CURDIR)/dist/amika-server ./cmd/amika-server

# Experimental (labs) binary.
build-akfs: goenv
	mkdir -p dist
	go -C $(GO_DIR) build -o $(CURDIR)/dist/akfs ./labs/cmd/akfs

clean:
	rm -rf dist .gocache .gotmp .gomodcache

clean-docker:
	docker image rm amika/coder:latest amika/base:latest amika/dind:latest amika/coder-dind:latest amika/daytona-coder-dind:latest

test: goenv
	go -C $(GO_DIR) test ./...

test-unit: goenv
	@pkgs="$(UNIT_PACKAGES)"; \
	go -C $(GO_DIR) test $$pkgs

test-integration: goenv
	go -C $(GO_DIR) test ./test/integration/...

test-contract: goenv
	go -C $(GO_DIR) test ./test/contract/...

test-expensive: goenv
	AMIKA_RUN_DOCKER_INTEGRATION=1 AMIKA_RUN_EXPENSIVE_TESTS=1 $(MAKE) test-all

test-all: test-unit test-integration test-contract

coverage: goenv
	./scripts/test/check_coverage.sh

vet: goenv
	go -C $(GO_DIR) vet ./...

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
	go -C $(GO_DIR) run github.com/mgechev/revive@v1.14.0 -set_exit_status -config revive.toml ./...

shellcheck:
	shellcheck bin/* go/internal/sandbox/presets/*.sh scripts/test/*.sh install.sh setup-repo.sh materialization-scripts/*.sh

ci: shellcheck fmtcheck vet lint build test-unit test-integration test-contract coverage

setup:
	./setup-repo.sh
