# Services, repository config, and snapshots

## Service result shape

Follow the live-service-first workflow in `SKILL.md`. Each JSON result includes
`service`, `sandbox`, `ports`, and `url`. Multiple bindings are comma-joined and
multiple URLs are space-joined.

## Managing services

```bash
amika service create --sandbox my-sandbox --name web --port 3000 --url-scheme http
amika service list --sandbox-name my-sandbox -o json
amika service delete --sandbox my-sandbox --name web --force
```

Services in `.amika/config.toml` are created with the sandbox. Use
`service create` for services added afterward.

## Repository configuration

`.amika/config.toml` declares version-controlled sandbox defaults. CLI flags and
UI settings can override it. In a multi-repository sandbox, only the primary
repository's config applies.

```toml
[lifecycle]
setup_script = ".amika/setup.sh"

[services.web]
port = 3000
url_scheme = "http"

[sandbox]
preset = "coder"
size = "m"

[env]
NODE_ENV = "development"
API_KEY = { secret = "my-api-key" }
```

Supported areas include lifecycle scripts, services, sandbox sizing and base
images, environment and secret references, additional repositories, and agent
credentials. For the full schema, use:

- <https://docs.amika.dev/guides/config-toml>
- <https://docs.amika.dev/guides/configuration>

## Snapshots

`scrub_and_delete` removes injected secrets, captures the snapshot, and deletes
the source sandbox. The non-interactive form does not ask for confirmation.

```bash
amika snapshot create --sandbox my-sandbox --no-interactive \
  --mode scrub_and_delete --name my-base
amika snapshot list -o json | jq -r '.items[].name'
amika snapshot delete my-base --force
```

Use `scrub_and_delete` only when deleting the source sandbox is intended. Use
`full` to keep the source sandbox and capture its complete state, including any
credentials present in it.
