# Amika Architecture Roadmap

This document describes the roadmap for the Amika filesystem. For user-facing docs, see [README.md](../../README.md).

## Architectural Invariants

These principles guide all design decisions.

1. **POSIX is the interface.**
   Agents interact with Amika through a filesystem. We do not require custom SDKs inside sandboxes.

2. **Access control is enforced at the filesystem layer.**
   Read-only, read-write, and overlay modes define what agents can modify.

## Architecture Overview

Amika is divided into two layers: the **Execution Plane** (where agents run) and the **Data Plane** (how data flows in and out).

```
External Sources          Data Plane                    Execution Plane
┌──────────────┐    ┌─────────────────────┐    ┌─────────────────────────┐
│ HubSpot      │    │ Connector           │    │ Mount (ro/rw/overlay)   │
│ Linear       │───>│ Inbound Filters     │───>│ Agent Sandbox           │
│ Notion       │    │ Filesystem Repo     │    │ POSIX Interface         │
│ S3 / Git     │    │ Versioning Layer    │    │                         │
│ Postgres     │<───│ Outbound Filters    │<───│ Agent Writes            │
└──────────────┘    └─────────────────────┘    └─────────────────────────┘
```

## Data Plane: Materialization & Sync

_Purpose: Manages the lifecycle of data—pulling it from sources and ensuring it stays fresh._

- 🟢 **Batch Materialization**: Scripts run once in a sandbox and capture outputs via `rsync`.
- 🟡 **Connector Framework**: Standardized interfaces for external storage (Postgres, S3, Git) and SaaS APIs (HubSpot, Linear).
- ⚪ **The Sync Engine**: Moving from one-off copies to a live reconciliation engine that tracks incremental changes and bi-directional updates.

Materialization is the process of shaping external data into a local file tree. The three modes above evolve from simple to sophisticated:

1. **Batch**: Run a command; sync the resulting directory to a destination.
2. **Sync-Based**: A live directory that incrementally mirrors a SaaS tool (e.g., your HubSpot contacts appearing as a directory of Markdown files).
3. **Dynamic (Planned)**: Virtual files generated on-demand. For example, reading `logs.txt` might trigger a real-time API call to a logging provider without the data ever sitting on disk.

## Execution Plane: Mounts & Sandboxes

_Purpose: Provides the POSIX-compliant environment where the agent operates._

- 🟢 **Local Docker Support**: Persistent sandboxes with controlled directory mounting.
- 🟢 **Multi-Mode Mounting**: Support for `ro` (read-only), `rw` (read-write), and `overlay` (copy-on-write) modes.
- ⚪ **Network-Mountable FS**: Move to a networked protocol (likely 9P or a custom gRPC-based file server) so remote sandboxes can mount Amika filesystems without being on the same host. This enables migration between local containers and cloud-hosted sandboxes (Modal, E2B, Daytona, Cloudflare, etc.).

Planned additions:

- **Per-agent mount configurations**: Different agents get different views of the same filesystem, with different permission sets.
- **Lazy loading**: Don't sync the entire file tree upfront; pull files on demand for faster sandbox boot times.

## Security & Transformation Pipeline

The filesystem acts as a security firewall between the LLM and sensitive data. The data flow through inbound and outbound filters.

-The filesystem acts as a security firewall between the LLM and sensitive data.

```
External Source
   ↓
Inbound Connector
   ↓
Inbound Filters (redact / tokenize)
   ↓
Agent Filesystem
   ↓
Agent reads and writes
   ↓
Outbound Filters (validate / approve / reject)
   ↓
Filesystem Repo
   ↓
Other external stores (object storage, SQL DB, etc.)
```

### Inbound: Redaction & Tokenization

As data moves from a source to the agent, Amika can modify it in transit:

- **PII Redaction**: Automatically scrubbing SSNs, emails, or keys.
- **Opaque Tokenization**: Replacing sensitive values with tokens. The AI operates on the token, and Amika "detokenizes" the value only when the agent writes back to the source-of-truth filesystem repository.

### Outbound: Validation & Approval

- **Audit Logs**: A full syscall-level trace of every file the agent read or wrote.
- **Staging Area**: AI writes land in a staging area in the source-of-truth repo. A human or "Supervisor Agent" must approve the changes before they are committed to the production datastore.

**Threat model.** The security layer protects against: prompt injection via file contents (inbound filters sanitize/tokenize before reaching the agent), data exfiltration via write-back (outbound filters validate what agents send to external systems), cross-agent data leakage (per-agent mount configs with isolated permission sets), and sandbox escape (enforced path boundaries with all paths forced under sandbox root).

## Versioning & Agent Traces

Optionally, you can treat the agent's workspace like a Git repository, providing historical context for every change.

- **Agent Commits**: Every edit includes metadata about which agent made the change and why.
- **Session Traces**: Linking the LLM's chat transcript directly to the file changes it produced.

## Data Views

A meta-goal for Amika is to transform any set of data sources into the right **data view** for your AI agent. Think Airbyte or Fivetran, but for shaping data into an agent's workspace rather than into a data warehouse.

### Semantic File Tree

Standard file trees organize by source or type (`/hubspot/contacts/`, `/linear/issues/`). A **semantic file tree** reorganizes files by meaning — grouping them by intent, project, or relevance rather than origin.

For example, instead of the agent navigating separate HubSpot and Linear directories, it sees:

```
/views/active-deals/
  acme-corp/
    contact-info.json       (from HubSpot)
    related-tickets/        (from Linear)
    email-history/          (from Gmail)
```

This could be implemented as a virtual overlay that projects underlying files into query-backed directory structures, generated dynamically based on metadata and relationships.

Inspiration: [Browse code by meaning](https://haskellforall.com/2026/02/browse-code-by-meaning)

This is exploratory — we're not building it yet, but it's where we think the most leverage is for agent productivity.
