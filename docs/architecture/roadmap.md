# Amika Architecture Roadmap

Amika is a filesystem for AI agents — it pulls data from your tools, shapes it into files, and mounts it into agent sandboxes with fine-grained access control.

This document describes where Amika is today, what we're building next, and the long-term architecture we're working toward. For user-facing docs, see [README.md](../../README.md).

## Architectural Invariants

These principles guide all design decisions.

1. **POSIX is the interface.**
   Agents interact with Amika through a filesystem. We do not require custom SDKs inside sandboxes.

2. **Access control is enforced at the filesystem layer.**
   Read-only, read-write, and overlay modes define what agents can modify.

## Core Architectural Planes

To scale from a local CLI to a cloud-native data plane, Amika is divided into two distinct layers: the **Execution Plane** and the **Data Plane**.

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

### The Execution Plane (Sandbox & Mount)

*Purpose: Provides the POSIX-compliant environment where the agent operates.*

* 🟢 **Local Docker Support**: Persistent sandboxes with controlled directory mounting.
* 🟢 **Multi-Mode Mounting**: Support for `ro` (read-only), `rw` (read-write), and `overlay` (copy-on-write) modes.
* 🟡 **Linux and MacOS Support**: We support `macFUSE` and `fuse3` for Mac OS and Linux compatibility.
* ⚪ **Network-Mountable FS**: You should be able to migrate your filesystem between local containers and any cloud-hosted remote sandbox (Modal, E2B, Daytona, Cloudflare, etc.)

### The Data Plane (Materialization & Sync)

*Purpose: Manages the lifecycle of data—pulling it from sources and ensuring it stays fresh.*

* 🟢 **Batch Materialization**: Scripts run once in a sandbox and capture outputs via `rsync`.
* 🟡 **Connector Framework**: Standardized interfaces for external storage (Postgres, S3, Git) and SaaS APIs (HubSpot, Linear).
* ⚪ **The Sync Engine**: Moving from one-off copies to a live reconciliation engine that tracks incremental changes and bi-directional updates.

## Filesystem Materialization

Materialization is the process of shaping external data into a local file tree. We support three evolving modes:

1. **Batch Materialization (Current)**: Run a command; sync the resulting directory to a destination.
2. **Sync-Based Materialization (Active)**: A live directory that incrementally mirrors a SaaS tool (e.g., your HubSpot contacts appearing as a directory of Markdown files).
3. **Dynamic Materialization (Planned)**: Virtual files generated on-demand. For example, reading `logs.txt` might trigger a real-time API call to a logging provider without the data ever sitting on disk.

## Execution Plane: Mounts & Sandboxes

### Cross-Platform Support

Amika currently requires macOS with macFUSE/bindfs. To support agents running in cloud environments (Modal, E2B, Daytona, Lambda), we need:

- **Linux support**: Implement `fuse3`-based mounting for standard Linux kernels
- **Network-mountable filesystem**: Move from local FUSE to a networked protocol (likely 9P or a custom gRPC-based file server) so remote sandboxes can mount Amika filesystems without being on the same host
- **Remote sandbox mounting**: First-class support for mounting into ephemeral cloud sandboxes

### Mount Modes

The current ro/rw/overlay modes stay. We're adding:

- **Per-agent mount configurations**: Different agents get different views of the same filesystem, with different permission sets
- **Lazy loading**: Don't sync the entire file tree upfront; pull files on demand for faster sandbox boot times

## Security & Transformation Pipeline

The filesystem acts as a security firewall between the LLM and sensitive data.

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

* **PII Redaction**: Automatically scrubbing SSNs, emails, or keys.
* **Opaque Tokenization**: Replacing sensitive values with tokens. The AI operates on the token, and Amika "detokenizes" the value only when the agent writes back to the source-of-truth filesystem repository.

### Outbound: Validation & Approval

* **Audit Logs**: A full syscall-level trace of every file the agent read or wrote.
* **Staging Area**: AI writes land in a staging area in the source-of-truth repo. A human or "Supervisor Agent" must approve the changes before they are committed to the production datastore.

### Threat Model

The security layer is designed to protect against:

- **Prompt injection via file contents**: Inbound filters can sanitize or tokenize content before it reaches the agent
- **Data exfiltration via write-back**: Outbound filters validate what the agent is trying to send to external systems
- **Cross-agent data leakage**: Per-agent mount configs with isolated permission sets
- **Sandbox escape**: Enforced path boundaries (all paths forced under sandbox root)

### Audit Logs

All agent reads and writes to the filesystem can be tracked, producing a full audit trail of what the agent accessed and modified.

## Versioning & Agent Traces

Optionally, you can treat the agent's workspace like a Git repository, providing historical context for every change.

* **Agent Commits**: Every edit includes metadata about which agent made the change and why.
* **Session Traces**: Linking the LLM's chat transcript directly to the file changes it produced.

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
