# CLI command guidance

## Usage and help text

- Treat a Cobra command's `Use` as a precise synopsis. Write required
  positional arguments as `<value>`, optional arguments in brackets, and
  repeatable arguments with `...`.
- When a command accepts multiple distinct positional forms, show each complete
  invocation on its own line under `Usage:`, following Git's help style. Do not
  join variants with `|` in a single usage line.
- Keep the first or most common form in `Use` so Cobra's command name,
  completion, and generated-document behavior remain well-defined. Use a
  command-specific usage template to render additional forms while preserving
  the standard `Aliases`, `Flags`, and `Global Flags` sections.
- Use the full command path in every rendered variant and include `[flags]`
  consistently when the command accepts flags.
- Keep `Short` descriptions concise and action-oriented. Put behavioral detail,
  constraints, and explanations in `Long`, `Example`, or flag descriptions
  rather than overloading the synopsis.
- Add or update a help-output test when introducing a custom usage template.

## Replacing a flag or argument

When a new spelling supersedes a flag (`rig create <name>` over `--name`,
`service list --rig` over `--rig-name`, the `name=`/`id=` prefixes over
`rig bind --rig-by`), keep the old flag registered but hidden with `MarkHidden` so existing scripts keep working, refuse a command
that gives both, and show only the new form in `Use`, help, and docs.

## Naming a rig

Every field that names an existing rig (a positional `<rig>`, `--rig`, `scp`'s
`<rig>:<path>`) takes a rig reference: a name or id, `name=<name>` or
`id=<id>` to pin the field, or `_self` for the current rig. Parse it with
`rigref.Parse`/`ParseAll` as soon as it is read, before the auth check, so a
malformed reference or `_self` outside a rig reports itself instead of a login
prompt. Write the placeholder as `<rig>` and word flag help as "a name or id,
or name=<name> / id=<id> to match one field".

Send the reference and its kind in one request (`Ref.Selector()` becomes `by`,
`sandbox_by`, or a `sandbox_ref`/`_name`/`_id` field) and let the server
resolve it; never look the rig up first to check the kind. An id the API
itself returned goes out with `apiclient.SandboxByID`, not as a plain ref,
because a rig can be named after another rig's id. `rig get`, `ssh`, `open`,
`connect`, and `scp` build the `*.amika` SSH alias only from the canonical name
and id their lookup returns, so a `name=`/`id=`/`_self` spelling never becomes
a hostname. Wrap API errors with `rigref.Explain` so a 409
`resource_ref_ambiguous` suggests `id=`/`name=`, and name the rig in output
with `rigref.Label` until the canonical name is known. `service list --rig`
filters `ListSandboxes` with `rigref.Find`, since `/sandbox-services` returns
no rig names.

## Output format (`--output`)

`--output`/`-o` (`text` default, `json`, `json-pretty`) is a persistent root flag, validated once in the root `PersistentPreRunE`. When adding or changing a command, honor it:

- Read the format with `output.FormatFrom(cmd)`, and when `format.IsJSON()` write the result via `format.JSON(w, v)`.
- Emit snake_case JSON keys, empty lists as `[]` (never `null`), and per-item batch results as `output.ItemResult{name, status, error}`. The one exception is a field the API itself spells otherwise: a mirror struct copies the API's spelling, so `Host.Sizes` entries keep the control plane's `memoryGib`, `diskGib`, and `diskGrowOnly`. Renaming one to snake_case decodes that field as its zero value with no error: `amika host get` then prints the row `small  2  0 GiB  40 GiB` and `-o json` emits `"memory_gib":0`, rather than failing.
- In JSON mode stdout carries only the JSON value: emit human progress through `format.Progress(w)` (which discards it in JSON mode) and send any subprocess or build output to stderr.
- Do not prompt in JSON mode: destructive commands require their confirmation flag (`--force` or `--no-interactive`).
- Commands that open a shell or editor, or that prompt over a masked table with no structured result (`secret extract`, `secret push`), call `output.RejectJSON(cmd)`. Commands that delegate to a shell utility reject the flag instead: `ssh` calls `output.RejectFlag(cmd)`; `scp` sets `DisableFlagParsing` (so its own `-o` ssh_config option forwards to the system scp) and therefore rejects only the unambiguous long form via `output.RejectFlagInArgs(rawArgs)`.

**Remote-backed commands emit the API's response schema.** For any command backed by a remote API resource (`sandbox create/list/start/stop`, `snapshot create/list`, `host list/get`), `-o json`/`-o json-pretty` emit the same shape as the documented Amika API response (see `/api/openapi.json`), via the typed mirror structs in `internal/apiclient` (`RemoteSandbox`, `SandboxSnapshot`, `SecretSummary`, `AgentSessionSendResponse`, `Host`). Those structs are the single decode/encode type: the CLI decodes an API response into one and re-encodes the same value for `-o json`, so a field the schema marks `nullable` is a Go pointer (emits explicit `null`, never omitted) and a field the schema marks `required` has no `omitempty` (always present). `sandbox list` and `snapshot list` mirror `ListSandboxesResponse`/`ListSandboxSnapshotsResponse` exactly, including the latter's `{"items": [...]}` envelope (`sandbox list` is a bare array; `snapshot list` is not). These structs carry only schema fields: the former `container_id`/`image` extras existed for local Docker sandboxes and were dropped with the `--local` mode. The one exception is `rig get`, which adds `ssh_host`: the rig's alias from `~/.ssh/amika.conf`, derived client-side because it embeds a slug of the CLI's `AMIKA_API_URL`. `sandbox start`/`stop` emit an array of each target's final resource (the CLI already polls the API to completion) mixed with an `output.ItemResult` per failed target; `sandbox delete`/`snapshot delete`/`host delete` stay arrays of `output.ItemResult` since the API returns no body (`OkStatus`/204) to mirror.
