# Amika host daemon

`amika-hostd` gives callers an HTTP API for Linux virtual machines running on
one host. It validates machine requests and forwards lifecycle operations,
commands, and file transfers to a local `smolvm serve` process, the Smol VM
runtime. This is the host endpoint for Amika integrations; callers connect to
hostd while the VM runtime stays behind it. It does not install or start that
runtime itself.

## Run locally

Install [smolvm](https://smolmachines.com/docs/local/quick-start) on a host with
hardware virtualization. On Linux the runtime user needs access to `/dev/kvm`,
the kernel virtualization device.
From this repository's root, start the runtime and then the daemon:

```sh
smolvm serve start --listen 127.0.0.1:8080
pnpm install
pnpm --filter @amika/hostd dev
```

The daemon listens on `127.0.0.1:3020`. Authentication is not implemented yet;
use it on a trusted host. `HOST` and `PORT` configure the listener,
`SMOL_API_URL` selects the runtime (default `http://127.0.0.1:8080`), and
`SMOL_REQUEST_TIMEOUT_MS` sets the upstream HTTP deadline (default 300000).
For a compiled build, run `pnpm --filter @amika/hostd build` followed by
`pnpm --filter @amika/hostd start`.

In another terminal, create a machine from an Ubuntu container image, start it,
execute a command, and delete it:

```sh
curl -fsS http://127.0.0.1:3020/health
curl -fsS http://127.0.0.1:3020/api/v1/machines \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","image":"ubuntu:24.04","cpus":2,"memoryMb":2048,"storageGb":20,"network":true}'
curl -fsS -X POST http://127.0.0.1:3020/api/v1/machines/demo/start
curl -fsS http://127.0.0.1:3020/api/v1/machines/demo/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":["/bin/sh","-c","echo hello"],"user":"root"}'
curl -fsS -X DELETE http://127.0.0.1:3020/api/v1/machines/demo
```

The exec response includes `{"exitCode":0,"stdout":"hello\n","stderr":""}`.

Create allocates a stopped machine; start boots it. Stop preserves disk, not
running processes. Like the underlying runtime, exec and file access can
start a stopped machine; inspecting or listing machines never starts them.

## API

The daemon exposes this subset of the Smol local API, using its camelCase
JSON request and response fields (for example, `memoryMb` and `exitCode`):

| Method | Path                                 | Operation                             |
| ------ | ------------------------------------ | ------------------------------------- |
| GET    | `/health`                            | Daemon liveness, returns `status: ok` |
| POST   | `/api/v1/machines`                   | Create a stopped machine              |
| GET    | `/api/v1/machines`                   | List the runtime's machines           |
| GET    | `/api/v1/machines/:name`             | Inspect state and resources           |
| DELETE | `/api/v1/machines/:name`             | Delete a machine                      |
| POST   | `/api/v1/machines/:name/start`       | Start a machine                       |
| POST   | `/api/v1/machines/:name/stop`        | Stop a machine                        |
| POST   | `/api/v1/machines/:name/exec`        | Execute argv, return exit code/output |
| PUT    | `/api/v1/machines/:name/files/*path` | Upload raw file bytes                 |
| GET    | `/api/v1/machines/:name/files/*path` | Download a file                       |

Create requires `name` and `image`. Optional fields are `cpus`, `memoryMb`,
`storageGb`, `network` (defaults to false), and `env` (an array of
`{ "name": "KEY", "value": "value" }`). Enable networking for remote image
pulls and outbound guest traffic. `storageGb` sizes the storage disk backing
`/workspace`, not the image's separate writable overlay.

Exec requires `command` (a nonempty array of arguments) and accepts `user`,
`workdir` (absolute guest path), `env`, and `stdin` (a string). It returns
`exitCode`, `stdout`, and `stderr`; a nonzero guest exit code is still HTTP 200.
The HTTP deadline does not terminate a guest process; stop or delete the
machine to terminate work.

File paths are absolute guest paths with the leading slash omitted from the
URL; encode each path component. For example, `/workspace/hello.txt` maps to
`/api/v1/machines/demo/files/workspace/hello.txt`. Uploads create parent
directories. Request bodies are limited to 64 MiB. Unknown request fields,
invalid machine names, and file paths containing dot segments or NUL are
rejected with 400. Unknown routes return 404.

Runtime success responses and HTTP error statuses are preserved; error bodies
are replaced with a generic message. Transport failures return 502 and HTTP
deadlines return 504. `/health` checks the daemon only, not runtime readiness.
Listings include every machine in that runtime, including machines created
outside Amika. SSH, service routing, snapshots, streaming exec, and automatic timers
are outside this API.
