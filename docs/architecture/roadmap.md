# Architecture Roadmap

## File syncing layer

At the core, we want Amika to:

1. get your agent the right files quickly
2. not fill your agent's computer or sandbox with extra files it doesn't need
3. ensure fast boot times for your sandbox and the files on it
4. synchronize data from your agent sandboxes to other datastores (S3, SQL DBs, etc.)

Things we're building:

- Caching layer
- connectors to other storage layers: syncing filesystem data to/from backend SQL DB or object store

### Data storage connectors

- Postgres
- Git
- S3

## Filesystem materialization

Filesystem materialization is the processing of dynamically generating files from external data. Two methods:

1. **dynamic materialization**: the contents of an individual file are dynamic, and come from an external system (for example, a file that shows recent error logs from Datadog)
2. **sync-based materialization**: a file tree is dynamically generated and synced to your agent's filesystem (for example, all your Hubspot contacts as directories, filled with email communication and contact metadata)


We're implementing sync-based materialization right now. Sync-based materialization works like so:

1. Run arbitrary scripts or commands in a sandbox. Any files your script writes to the sandbox's "output directory" are synced to your filesystem repo
2. You can mount your filesystem repo into any AI agent sandbox or computer where you agent is running

## Security and Access Controls

### POSIX file permisisons

When you mount a filesystem onto your agent's computer or sandbox, you control which files are read-only or read-write. You can set these permissions per agent, in case you have multiple agents.

### File filtering

To protect against prompt injection or ensure sensitive data doesn't reach your agent, you can add file filters that modify the file as it's synced to the agent's filesystem. For example, you could redact SSNs from a spreadsheet. When you run these filters, you can insert opaque tokens so that the AI still has an identifier for that piece of information, but doesn't see the actual contents. Then when files are synced back out, we fill back in the tokenized value. This is similar to how credit card processing works on sites.

We're also working on outbound filters, which check data the AI agent writes to the files and can approve/reject these changes. But we haven't figured out the UX here yet.

### Audit logs

Optionally, we can track all the reads and writes the AI made to the filesystem.


## File versioning and agent traces

We want our filesystem to have the same benefits of using git:

1. keep old versions of files
2. see the changes the AI made
3. include "commit messages" and author metadata: which agent edited the file, and why

For a set of file edits, the agent can include a "commit message" describing
their change. You can also attach the whole agent chat session as extra context
metadata about why the files changed.


## Different data views

One meta-goal is for Amika to be able to transform any set of data sources into the appropriate "data view" for your AI. Think of it kind of like Airbyte or Fivetran, but more for shaping the data available in your AI agent's workspace.

### Semantic file tree

[inspriation](https://haskellforall.com/2026/02/browse-code-by-meaning)

## Data connections

We're building data connectors to other sources:

1. Turning websites into files
2. Turning MCP reads into local files for better LLM context efficiency
3. Connecting SaaS tools and turning their data into a filesystem
