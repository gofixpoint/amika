# Services

## Overview

This spec defines a declarative way to declare long-running services and their port bindings in `.amika/config.toml`. When a sandbox is created with `--git`, Amika reads service definitions from the repo config, resolves host port bindings, and stores the results as sandbox metadata. A new `amika service list` command surfaces service port mappings across sandboxes.

## Motivation

Today, container port bindings are only configurable via ad-hoc `--port` flags at `sandbox create` time. This has two problems:

1. **Not declarative.** Port configuration lives in shell commands, not in the repo. Every collaborator must know which ports to pass.
2. **No named abstraction.** There is no way to say "this sandbox runs an API server on port 4838" — you only see raw port numbers.

Services solve both problems by letting repos declare named processes and their ports in `.amika/config.toml`. The port bindings are resolved at sandbox creation time, stored in sandbox metadata, and surfaced via CLI and API.

## Goals

1. Allow repos to declare named services with port bindings in `.amika/config.toml`.
2. Resolve service ports to host port bindings at `sandbox create` time, merged with any ad-hoc `--port` flags. Host port binding is only supported for the "local-docker" sandbox provider.
3. Store service metadata in `sandbox.Info` so it persists and can be queried.
4. Provide `amika service list` to display services and their port mappings.
5. Surface service info in the public Go API and HTTP API.

## Non-Goals

1. **Process lifecycle management.** This spec does not start, stop, or restart processes inside the container. Services are a port declaration mechanism only. Process management is a future concern.
2. **Health checks or readiness probes.** No liveness or health checking for declared services.
3. **Remote provider port mapping.** When running on a remote provider, the user cannot specify host ports — port mapping is handled by the remote infrastructure.
4. **Service discovery or DNS.** No inter-sandbox service discovery.

## TOML Configuration

Services are declared under `[services.<name>]` sections in `.amika/config.toml`:

```toml
[services.api]
port = 4838
url_scheme = "http"

[services.metrics]
port = "4982/udp"

[services.web]
ports = ["4982/udp", 4211, "9872/tcp"]
url_scheme = [
  { port = 4211, scheme = "http" },
  { port = "9872/tcp", scheme = "https" },
]
```

### Fields

| Field        | Type                                      | Description                                                   |
| ------------ | ----------------------------------------- | ------------------------------------------------------------- |
| `port`       | int or `"port/protocol"`                  | Single port declaration                                       |
| `ports`      | list of int or `"port/proto"`             | Multiple port declarations                                    |
| `url_scheme` | string or list of `{port, scheme}` tables | Optional. Enables URL generation for specific ports. See below.|

- `port` and `ports` are **mutually exclusive**. Specifying both is a validation error.
- Protocol defaults to `tcp` when omitted.
- Valid protocols: `tcp`, `udp`.
- Port numbers must be in the range 1–65535.
- Ports in the reserved range 60899–60999 are rejected (see `docs/sandbox-configuration.md`).
- A service may omit both `port` and `ports`, in which case it is treated as metadata-only and has no resolved ports.

### `url_scheme` format

The shape of `url_scheme` depends on whether the service uses `port` or `ports`:

**With `port` (single port):** `url_scheme` may be either a plain string or a list of inline tables.

- String form: `"http"` or `"https"`. The scheme applies to the single declared port.
- List form: either `[]` or a single `{port, scheme}` inline table whose `port` exactly matches the declared `port`.

```toml
[services.api]
port = 4838
url_scheme = "http"
```

```toml
[services.api]
port = 4838
url_scheme = [
  { port = 4838, scheme = "http" },
]
```

**With `ports` (multiple ports):** `url_scheme` is a list of `{port, scheme}` inline tables. Each entry specifies which port gets a URL and with what scheme. Ports not listed do not get URLs — this is intentional so that URLs are only generated for ports the user explicitly opts in to.

```toml
[services.web]
ports = [4211, "9872/tcp", "4982/udp"]
url_scheme = [
  { port = 4211, scheme = "http" },
  { port = "9872/tcp", scheme = "https" },
]
# 4982/udp gets no URL
```

**Validation rules for `url_scheme`:**

- Optional. When omitted, no URLs are generated for the service.
- When `port` is used, `url_scheme` may be a string, an empty list, or a one-entry list whose `port` matches the declared `port`.
- When `ports` is used, `url_scheme` must be a list of `{port, scheme}` tables. A string value is a validation error.
- Each `scheme` value must be `"http"` or `"https"`.
- Each `port` in a `url_scheme` mapping must reference a port declared in the service. For single-port services using list form, the mapping must match the declared `port` exactly.
- Duplicate port entries within `url_scheme` are a validation error.
- For single-port services using list form, more than one entry is a validation error.

### Port format

Each port value is either:
- An integer (e.g. `4838`) — interpreted as `containerPort/tcp`.
- A string `"containerPort/protocol"` (e.g. `"4982/udp"`) — explicit protocol.

This matches the container-port side of the existing `--port` CLI flag syntax.

### URL generation

For each port that has an associated scheme, Amika generates a URL using the format:

```
<scheme>://<host-or-bind-address>:<hostPort>
```

For loopback bindings (`127.0.0.1`, `::1`, or empty/default), Amika uses `localhost` in the generated URL. For other bind addresses, it uses the configured bind address directly.

For example, a service with `port = 4838` and `url_scheme = "http"` that resolves to loopback on port 4838 produces `http://localhost:4838`. A service bound to `0.0.0.0` on port 4838 produces `http://0.0.0.0:4838`.

For a multi-port service, only ports with `url_scheme` mappings get URLs. A service with `ports = [3000, 3001, 9090]` and `url_scheme = [{port = 3000, scheme = "https"}]` generates one URL (`https://localhost:3000` for loopback binding); ports 3001 and 9090 get no URLs.

URLs are computed at sandbox creation time (after port resolution) and stored in the service metadata. They appear in `amika service list` output and API responses.

### Full example

```toml
[lifecycle]
setup_script = "scripts/setup.sh"

[services.api]
port = 4838
url_scheme = "http"

[services.metrics]
port = "9090/tcp"

[services.frontend]
ports = [3000, "3001/tcp"]
url_scheme = [
  { port = 3000, scheme = "https" },
]
```

## Config Parsing Changes

### Package: `internal/amikaconfig`

Extend the `Config` struct:

```go
type Config struct {
    Lifecycle LifecycleConfig            `toml:"lifecycle"`
    Services  map[string]ServiceConfig   `toml:"services"`
}

type ServiceConfig struct {
    Port      interface{}   `toml:"port"`       // int or string
    Ports     []interface{} `toml:"ports"`      // list of int or string
    URLScheme interface{}   `toml:"url_scheme"` // string, []URLSchemeMapping, or empty list depending on port/ports
}

// URLSchemeMapping maps a port to a URL scheme.
type URLSchemeMapping struct {
    Port   interface{} `toml:"port"`   // int or "port/protocol" string
    Scheme string      `toml:"scheme"` // "http" or "https"
}
```

### Validation function

Add `ValidateServices(services map[string]ServiceConfig) error` that checks:

1. Each service has at most one of `port` or `ports`. A service may omit both and remain metadata-only.
2. Every port value parses to a valid container port (1–65535) and protocol (`tcp` or `udp`).
3. No port falls in the reserved range 60899–60999.
4. No duplicate container port/protocol pair across all services in the file.
5. If `url_scheme` is set:
   - With `port`: may be a string (`"http"` or `"https"`), an empty list, or a one-entry list whose `port` matches the declared port.
   - With `ports`: must be a list of `{port, scheme}` mappings. A string is a validation error.
   - Each `scheme` must be `"http"` or `"https"`.
   - Each `port` in a mapping must match a declared port in the service.
   - With `port` and list form, the list may contain at most one entry.
   - No duplicate ports within the `url_scheme` list.

### Parsed representation

After validation, produce a normalized form:

```go
type ServicePortParsed struct {
    ContainerPort int
    Protocol      string // "tcp" or "udp"
    URLScheme     string // "" (no URL), "http", or "https"
}

type ServiceParsed struct {
    Name  string
    Ports []ServicePortParsed
}
```

Each `ServicePortParsed` carries its own `URLScheme`. For a single-port service with `url_scheme = "http"`, the port's `URLScheme` is `"http"`. For a single-port service using the list form, the port gets the mapped scheme when the list contains a matching entry, or `""` when the list is empty. For a multi-port service, only ports that appear in the `url_scheme` list get a non-empty `URLScheme`; the rest have `""`.

Add a method `Config.ParsedServices() ([]ServiceParsed, error)` that validates and returns the normalized list.

## Port Resolution at `sandbox create` Time

When `--git` is used and the cloned repo contains `.amika/config.toml` with service declarations, the service ports are resolved to host port bindings using the existing `PortBinding` mechanism.

### Resolution algorithm

For each service port (`containerPort/protocol`):

1. **Try direct mirror**: attempt `hostPort = containerPort`. If the host port is not already claimed by another binding in this sandbox creation and is available on the configured bind address, use it.
2. **Fallback**: pick a random available host port by binding to port 0 and reading the assigned port (same mechanism as Docker's random port assignment).

The host IP defaults to `127.0.0.1`, consistent with the `--port-host-ip` default.

### Merging with `--port` flags

Service port bindings are merged with any ad-hoc `--port` flag bindings:

1. Parse `--port` flags first (existing behavior).
2. Parse service ports from config.
3. Check for conflicts: if a container port/protocol pair appears in both `--port` flags and a service declaration, return an error.
4. Combine both sets into the final `publishedPorts` list.

### Where this happens

In `collectMounts` (or a new `collectServices` helper called alongside it), after reading `.amika/config.toml` — the same place where `setupScriptMountFromConfig` is called today.

## Storage — Extend `sandbox.Info`

### New types in `internal/sandbox/store.go`

```go
// ServiceInfo describes a named service and its resolved port bindings.
type ServiceInfo struct {
    Name  string            `json:"name"`
    Ports []ServicePortInfo `json:"ports"`
}

// ServicePortInfo is a resolved port binding with an optional generated URL.
type ServicePortInfo struct {
    PortBinding          // embedded: HostIP, HostPort, ContainerPort, Protocol
    URL         string   `json:"url,omitempty"` // e.g. "http://localhost:4838", or ""
}
```

`URL` is computed at creation time for ports that have an associated `url_scheme`. For example, a port with scheme `"http"` resolved to loopback on port 4838 gets `URL: "http://localhost:4838"`. Ports without a scheme have an empty `URL` (omitted from JSON).

### Extended `Info` struct

```go
type Info struct {
    Name        string         `json:"name"`
    Provider    string         `json:"provider"`
    ContainerID string         `json:"containerId"`
    Image       string         `json:"image"`
    CreatedAt   string         `json:"createdAt"`
    Preset      string         `json:"preset,omitempty"`
    Mounts      []MountBinding `json:"mounts,omitempty"`
    Env         []string       `json:"env,omitempty"`
    Ports       []PortBinding  `json:"ports,omitempty"`
    Services    []ServiceInfo  `json:"services,omitempty"`
}
```

**Backward compatibility**: existing `sandboxes.jsonl` entries have no `services` key, which deserializes to `nil`. No migration needed.

## CLI — `amika service list`

### Command structure

```
amika service list [--sandbox-name <name>]
```

New top-level command `amika service` with subcommand `list`.

### Behavior

1. Load all sandboxes from the store.
2. If `--sandbox-name` is provided, filter to that sandbox.
3. For each sandbox with services, print each service's port bindings.

### Output format

Tab-separated columns:

```
SERVICE    SANDBOX          PORTS                                                URL
api        teal-tokyo       127.0.0.1:4838->4838/tcp                            http://localhost:4838
metrics    teal-tokyo       127.0.0.1:9090->9090/tcp                            -
frontend   teal-tokyo       127.0.0.1:3000->3000/tcp,127.0.0.1:3001->3001/tcp   https://localhost:3000
api        blue-paris       127.0.0.1:4838->4838/tcp                            http://localhost:4838
```

Port formatting uses the same `hostIP:hostPort->containerPort/protocol` format as existing `sandbox list` output.

The `URL` column shows generated URLs for ports that have a `url_scheme`, or `-` when no port in the service has a scheme. When a multi-port service has URLs for a subset of its ports, only those URLs are shown (comma-separated).

If no services are found, print "No services found."

### Future subcommands

The `amika service` command group is designed for future subcommands:

- `amika service stop <name> --sandbox-name <sandbox>` — stop a service process
- `amika service restart <name> --sandbox-name <sandbox>` — restart a service process
- `amika service logs <name> --sandbox-name <sandbox>` — tail service logs

These are **not implemented** in this spec. They will require process lifecycle management inside the container (a non-goal of this spec).

## Public API Changes

### Package: `pkg/amika`

#### New types in `responses.go`

```go
// ServiceInfo describes a named service running in a sandbox.
type ServiceInfo struct {
    Name  string            `json:"Name"`
    Ports []ServicePortInfo `json:"Ports"`
}

// ServicePortInfo is a resolved port binding with an optional generated URL.
type ServicePortInfo struct {
    PortBinding          // embedded: HostIP, HostPort, ContainerPort, Protocol
    URL         string   `json:"URL,omitempty"` // e.g. "http://localhost:4838", or ""
}
```

#### Extended `Sandbox` response

Add `Services []ServiceInfo` to the `Sandbox` struct:

```go
type Sandbox struct {
    Name        string
    Provider    string
    ContainerID string
    Image       string
    CreatedAt   string
    Preset      string
    Location    string
    Mounts      []Mount
    Env         []string
    Ports       []PortBinding
    Services    []ServiceInfo
}
```

#### New `ListServices` method

Add to the `Service` interface:

```go
ListServices(ctx context.Context, req ListServicesRequest) (ListServicesResult, error)
```

#### New request/response types

```go
// ListServicesRequest describes service listing input.
type ListServicesRequest struct {
    SandboxName string // optional filter
}

// ListServicesResult reports listed services.
type ListServicesResult struct {
    Items []ServiceListItem
}

// ServiceListItem is a service with its owning sandbox name.
type ServiceListItem struct {
    Service     string
    SandboxName string
    Ports       []ServicePortInfo
}
```

#### Implementation

`ListServices` loads all sandboxes (or a filtered one), iterates their `Services` fields, and returns flattened items.

Service info is also populated in `CreateSandbox` and `ListSandboxes` responses via the existing `Sandbox` type, which now includes `Services`.

## HTTP API Changes

### Existing endpoints

`GET /v1/sandboxes` and `POST /v1/sandboxes` responses already serialize the `Sandbox` struct. Adding `Services []ServiceInfo` to `Sandbox` automatically surfaces service info in these responses. No breaking change — the field is `omitempty`-compatible (nil serializes as absent or `null`).

### New endpoint

```
GET /v1/services?sandbox_name=<optional>
```

Registered in `internal/httpapi/server.go`:

```go
type listServicesInput struct {
    SandboxName string `query:"sandbox_name"`
}
type listServicesOutput struct {
    Body amika.ListServicesResult
}

func registerListServices(api huma.API, service amika.Service) {
    huma.Get(api, "/v1/services", func(ctx context.Context, input *listServicesInput) (*listServicesOutput, error) {
        result, err := service.ListServices(ctx, amika.ListServicesRequest{
            SandboxName: input.SandboxName,
        })
        if err != nil {
            return nil, toHTTPError(err)
        }
        return &listServicesOutput{Body: result}, nil
    })
}
```

## Test Plan

### `internal/amikaconfig` unit tests

1. Parse config with a single `[services.api]` using `port = 4838` — returns one service with port 4838/tcp.
2. Parse config with `port = "9090/udp"` — returns port 9090/udp.
3. Parse config with `ports = [3000, "3001/tcp", "9090/udp"]` — returns three ports with correct protocols.
4. Validation error when both `port` and `ports` are set on the same service.
5. Validation error when neither `port` nor `ports` is set.
6. Validation error for port outside 1–65535.
7. Validation error for invalid protocol (e.g. `"4838/sctp"`).
8. Validation error for reserved port in range 60899–60999.
9. Validation error for duplicate container port/protocol across services.
10. Parse config with no `[services.*]` sections — returns nil services, no error.
11. Parse single-port service with `url_scheme = "http"` — parsed port has `URLScheme: "http"`.
12. Parse single-port service with `url_scheme = "https"` — parsed port has `URLScheme: "https"`.
13. Parse config with no `url_scheme` — all parsed ports have `URLScheme: ""`.
14. Validation error for invalid scheme value (e.g. `"ftp"`, `"ws"`).
15. Parse multi-port service with `url_scheme = [{port = 3000, scheme = "http"}]` — only port 3000 has `URLScheme: "http"`, others have `""`.
16. Parse single-port service with `url_scheme = [{port = 4838, scheme = "http"}]` — parsed port has `URLScheme: "http"`.
17. Validation error when `ports` is used with a string-form `url_scheme`.
18. Parse single-port service with `url_scheme = []` — parsed port has `URLScheme: ""`.
19. Validation error when a single-port `url_scheme` list references a port other than the declared `port`.
20. Validation error when a single-port `url_scheme` list contains more than one entry.
21. Validation error when a `url_scheme` mapping references a port not in the service's `ports` list.
22. Validation error for duplicate port in `url_scheme` list.

### Port resolution and URL generation unit tests

1. Service ports resolve to direct-mirror host ports when available.
2. Service ports fall back to random host port when direct mirror is taken by a `--port` flag.
3. Error when a service container port conflicts with a `--port` flag container port.
4. Multiple services with non-overlapping ports all resolve correctly.
5. Single-port service with `url_scheme = "http"` resolved to loopback on port 4838 — port has `URL: "http://localhost:4838"`.
6. Single-port service with non-loopback bind address uses that bind address in the generated URL.
7. Multi-port service with `url_scheme` mapping for one port — only that port has a URL, others have `URL: ""`.
8. Service without `url_scheme` — all ports have `URL: ""`.

### `sandbox.Info` storage tests

1. `Info` with `Services` (including ports with URLs) round-trips through JSON marshal/unmarshal.
2. `Info` without `Services` (legacy format) deserializes with `Services == nil`.
3. `ServicePortInfo` with empty `URL` omits `url` from JSON.

### CLI integration tests

1. `amika service list` with no sandboxes prints "No services found."
2. `amika service list` with a sandbox that has services prints correct table.
3. `amika service list --sandbox-name <name>` filters to the specified sandbox.

### HTTP API tests

1. `GET /v1/sandboxes` includes `services` in response when present.
2. `POST /v1/sandboxes` with a git repo containing service config returns `services` in response.
3. `GET /v1/services` returns services across all sandboxes.
4. `GET /v1/services?sandbox_name=<name>` filters correctly.

### End-to-end (expensive, Docker-required)

1. Create a sandbox with `--git` pointing to a repo with `.amika/config.toml` containing service declarations. Verify `amika sandbox list` shows the ports and `amika service list` shows named services.
2. Create a sandbox with both `--git` (services in config) and `--port` flags. Verify both sets of ports are published and services are tracked.
3. Create a sandbox with a conflicting `--port` flag and service port. Verify an error is returned.

## Acceptance Criteria

1. `.amika/config.toml` with `[services.<name>]` sections is parsed and validated at sandbox creation time.
2. Service ports are resolved to host port bindings and published on the container.
3. Service metadata is stored in `sandbox.Info.Services` and persists in `sandboxes.jsonl`.
4. `amika service list` displays services with their port mappings in the expected table format.
5. `amika service list --sandbox-name <name>` filters to one sandbox.
6. The `Sandbox` response type in `pkg/amika` includes `Services`.
7. `GET /v1/services` endpoint returns service info.
8. Existing sandboxes without services continue to work (backward compatibility).
9. `--port` flags and service ports merge cleanly; duplicates produce a clear error.
10. Reserved ports (60899–60999) are rejected in service declarations.
11. Single-port services with `url_scheme` string have auto-generated URLs in stored metadata, CLI output, and API responses.
12. Single-port services may also use `url_scheme = []` or a one-entry list whose port matches the declared `port`.
13. Multi-port services with `url_scheme` list generate URLs only for the mapped ports.
14. Services without `url_scheme` have no URLs in output.
15. Using a string `url_scheme` with `ports` is a validation error.

## Dependencies

1. Existing `.amika/config.toml` parsing in `internal/amikaconfig`.
2. Existing `PortBinding` type and port resolution in `internal/sandbox/store.go` and `pkg/amika/service.go`.
3. Existing `--port` flag parsing in `cmd/amika/sandbox.go`.
4. Reserved port range documented in `docs/sandbox-configuration.md`.

## Future Considerations

1. **Process lifecycle management.** Future specs may add `amika service start/stop/restart` commands that manage processes inside the container via the amikad daemon.
2. **Service health checks.** A `healthcheck` field on `[services.<name>]` (e.g. an HTTP endpoint or TCP check) could be used by `amika service list` to show service status.
3. **Inter-sandbox networking.** Services could be exposed to other sandboxes via Docker networks, enabling multi-sandbox development environments.
4. **Environment variables per service.** A service may need its own env vars (e.g. `PORT=4838`). This could be added as an `env` field on the service config.
5. **Remote provider support.** Remote providers may handle port mapping differently. The service config format is provider-agnostic, but resolution logic will need provider-specific implementations.
