# API versions and authentication

How hostd versions its HTTP API, and the credential every route requires.

## API versions

hostd and the control plane upgrade independently, so hostd's API is
versioned. `/v0beta1/rigs` is the current API: the machine routes (create,
get, delete, start, stop, exec, files, services), the service routes and
the preview routes.
`GET /health` lists the versions served and the features a control plane may
rely on (`{ "status": "ok", "apis": ["v0beta1"], "features":
["service-tokens", "service-access", "snapshots"] }`). `snapshots` appears only on a daemon
that can take them (see [Snapshots](snapshots.md)). `service-access` says a
service may be created with `auth` and `preserve_host`, and a rig with its
`owner` (see [Access modes](service-routes.md#access-modes-and-the-host-header-at-a-name)); a daemon without it refuses a body that sets one. `/api/v1/machines` serves the same machine routes, without
service routes, for control planes on providers from before `v0beta1`; remove
it once none are deployed. Change a version's contract only in a new version.

## Authentication

Every route, including `/health` and unknown paths, requires the secret key:
in `X-Amika-Hostd-Key` (or a service token in `X-Amika-Authorization`) on
service routes, or as a browser session on preview routes and on a path
outside hostd's own that the preview cookie names (see
[Service routes](service-routes.md)), otherwise as
`Authorization: Bearer <secret key>` (the scheme the Amika CLI uses for API
credentials). `src/internal/auth.ts` reads it the same way as amika-mono's
worker auth (`checkWorkerAuth`): strip a leading `Bearer` scheme, trim, compare
in constant time, and answer a mismatch with a plain `401`. It runs before the body
limit, so unauthenticated callers cannot make the daemon buffer a body. The
caller's credential is never forwarded to the Smol runtime. The
`@amika/sandbox` `amika-hostd` provider sends the key from
`AMIKA_HOSTD_SECRET_KEY`. Both sides require at least 32 printable ASCII
characters with no spaces: HTTP clients trim header values, so a padded key
could never match.
