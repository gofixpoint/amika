.PHONY: goenv build build-cli build-server build-amikad build-amikalog build-akfs clean test test-unit test-integration test-contract test-e2e test-e2e-api sweep-e2e test-expensive test-all test-sandbox-image coverage vet fmt fmtcheck lint shellcheck ci setup

GO_DIR = go
UNIT_PACKAGES = $$(go -C $(GO_DIR) list ./... | grep -Ev '/test/(integration|contract)($$|/)')
GOFMT_FILES = git ls-files -z --cached --others --exclude-standard -- '*.go'
E2E_API_TIMEOUT ?= 45m
E2E_SANDBOX_PROVIDER ?= daytona

export GOCACHE := $(CURDIR)/.gocache
export GOTMPDIR := $(CURDIR)/.gotmp

goenv:
	mkdir -p "$(GOCACHE)" "$(GOTMPDIR)"

build: build-cli build-server build-amikad build-amikalog build-akfs

build-cli: goenv
	mkdir -p dist
	go -C $(GO_DIR) build -o $(CURDIR)/dist/amika ./cmd/amika

build-server: goenv
	mkdir -p dist
	go -C $(GO_DIR) build -o $(CURDIR)/dist/amika-server ./cmd/amika-server

build-amikad: goenv
	mkdir -p dist
	go -C $(GO_DIR) build -o $(CURDIR)/dist/amikad ./cmd/amikad

build-amikalog: goenv
	mkdir -p dist
	go -C $(GO_DIR) build -o $(CURDIR)/dist/amikalog ./cmd/amikalog

# Experimental (labs) binary.
build-akfs: goenv
	mkdir -p dist
	go -C $(GO_DIR) build -o $(CURDIR)/dist/akfs ./labs/cmd/akfs

clean:
	rm -rf dist .gocache .gotmp .gomodcache

clean-docker:
	docker image rm amika/coder:latest amika/coder-dind:latest

test: test-sandbox-image goenv
	go -C $(GO_DIR) test ./...

test-unit: goenv
	@pkgs="$(UNIT_PACKAGES)"; \
	go -C $(GO_DIR) test $$pkgs

test-integration: goenv
	go -C $(GO_DIR) test ./test/integration/...

test-contract: goenv
	go -C $(GO_DIR) test ./test/contract/...

test-e2e: goenv
	go -C $(GO_DIR) test ./test/e2e/runner/...
	E2E_SANDBOX_PROVIDER=$(E2E_SANDBOX_PROVIDER) AMIKA_RUN_E2E=1 go -C $(GO_DIR) test ./test/e2e

# Runs the offline E2E cases AND the api-*.yaml cases that hit the real
# remote API (which may create billable resources). Requires credentials
# (AMIKA_API_KEY / AMIKA_API_URL) in the environment. Select a non-default
# provider with `E2E_SANDBOX_PROVIDER=sailbox`.
#
# Each api-* case provisions and tears down real remote resources and takes
# minutes, so the suite runs well past `go test`'s default 10m timeout. That
# default does not fail the run cleanly: it panics the test binary mid-step,
# skipping the ledger cleanup that deletes what the case created. Override
# with `make test-e2e-api E2E_API_TIMEOUT=1h` when adding more cases.
test-e2e-api: goenv
	go -C $(GO_DIR) test ./test/e2e/runner/...
	E2E_SANDBOX_PROVIDER=$(E2E_SANDBOX_PROVIDER) AMIKA_RUN_E2E=1 AMIKA_RUN_E2E_API=1 go -C $(GO_DIR) test -timeout $(E2E_API_TIMEOUT) ./test/e2e

# Reclaims remote resources left behind by an E2E run that was killed before
# its own cleanup could run (SIGKILL, a dead machine). Deliberately manual:
# an unreclaimed ledger looks just like one belonging to a run still in
# flight, so look before you delete.
#   make sweep-e2e SWEEP_ARGS=-dry-run    # show what would be deleted
#   make sweep-e2e                        # delete it
sweep-e2e: build-cli
	go -C $(GO_DIR) run ./test/e2e/cmd/e2e-sweep \
		-bin $(CURDIR)/dist/amika \
		-runs $(CURDIR)/$(GO_DIR)/test/e2e/.runs $(SWEEP_ARGS)

test-expensive: goenv
	AMIKA_RUN_DOCKER_INTEGRATION=1 AMIKA_RUN_EXPENSIVE_TESTS=1 $(MAKE) test-all

test-all: test-unit test-integration test-contract

test-sandbox-image:
	./sandbox-image/tests/run-tests.sh

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
	shellcheck bin/* sandbox-image/build.sh sandbox-image/steps/*.sh sandbox-image/assets/hooks/*.sh sandbox-image/verify/run.sh sandbox-image/verify/checks/*.sh sandbox-image/verify/lib/check.sh scripts/test/*.sh install.sh setup-repo.sh materialization-scripts/*.sh

ci: test-sandbox-image shellcheck fmtcheck vet lint build test-unit test-integration test-contract coverage

setup:
	./setup-repo.sh
