# Amika open source plan

# **Open source overview**

We’re open sourcing the parts of our codebase that let developers control individual sandboxed agents, acting as the messaging and filesystem layer for the agent and the sandbox it lives on.

This means you can spin up a sandbox, put any agent on it, and then use Amika’s open source parts to:

1. message the agent over SSE or websockets  
2. manage the files synced to/from the sandbox

Beyond that, we are working on parts for:

1. a network proxy that helps with agent security and request/response authorization  
2. a secrets vault so you can let your sandboxed agent use APIs without it directly seeing secrets

The idea is that you can use the open source on any sandbox provider, or you can use it with Amika’s hosted product, which handles all the tricky parts of scaling and provisioning these sandboxes, and provides extra features for managing hundreds of agents, their filesystems, and security.

# **Components**

**Open source components:**

1. `amika` CLI: client-side CLI to:  
   1. in direct mode: interact directly with a sandboxed agent via the `amikad`  
   2. in scalable mode: interact with the closed-source Amika Control Plane  
2. `amikad` daemon: runs ons a sandbox to help:  
   1. provision and control the sandbox lifecycle  
   2. message agents on the sandbox  
   3. copy the right files to/from the sandbox  
   4. proxy network requests for agent security and authorization  
   5. keep secrets safe in a vault away from the agents  
3. `amikactl` CLI: exists on a sandbox and lets the agent communicate with `amikad` to self-control its sandbox  
   1. access secrets  
   2. pull files from remote file repo  
   3. spawn new sandboxes  
   4. etc…

**Closed source components:**

1. Amika Control Plane  
   1. API to provision hundreds to thousands of sandboxes and manage the agents across those sandboxes  
   2. Enable multiplayer sandbox mode and team-shared sandboxes  
   3. Index and store agent sessions so you can refer back to them and search over them  
   4. Centralize configuration of agent skills, tools, and MCP servers  
   5. Store centralized file repo that you can mount onto various sandboxes  
2. Amika Web UI  
   1. Pretty simple, it’s the web UI to interact with the control plane and sandboxed cloud agents

# 

# **Architecture**

Amika OSS diagrams: [https://link.excalidraw.com/l/7iUc0S5ODSX/8Eeboz1Tg38](https://link.excalidraw.com/l/7iUc0S5ODSX/8Eeboz1Tg38)

![single sandbox with direct sandbox control][single-sbox]

![multiple sandboxes with control plane][multi-sbox]

# 

# **Main capabilities of `amikad` daemon**

1. Agent Messaging Layer  
2. Sandbox Filesystem Layer  
3. Network Proxy  
4. Secrets Vault

## **Agent Messaging Layer**

***open source***

HTTP APIs to message any agent on a sandbox. Can message Claude Code, Codex, OpenCode, Pi, and custom agents via the [Agent Communication Protocol](https://agentcommunicationprotocol.dev/introduction/welcome).

Also supports:

1. streaming messages from the agent back to the client  
2. session management  
3. hooks for piping agent chat sessions to your own datastore or to the Amika Control Plane

## **Sandbox Filesystem Layer**

***open source**: the tech for syncing data from a host to a sandbox, and for copying data out of the sandbox to a destination*

***closed source** (for now at least): the Filesystem Volume backend infra and live file syncing tech.*

Mount persistent file volumes to sandboxes and version and control the files. The main goal is that you can mount parts of a Filesystem Volume to a sandbox, and then when the sandbox terminates the files persist.

### **File Materialization**

Amika has a “file materialization” flow that makes use of mountable filesystems and our sandboxing infra. You can:

1. spin up a sandbox  
2. inject it with files and directories  
3. run scripts inside the sandbox to pull more data or mutate data inside the sandbox  
4. output the resulting filesystem into a persistent Filesystem Volume or into another sandbox

This is useful, for example, to suck up data from enterprise systems-of-record, do any transformations you need to make that data “agent-ready” and then give it to a sandboxed agent to do work on the data.

### **Versioning and syncing**

Files can be mounted as either:

1. read-write mode: on the sandbox, all changes are synced back to the Filesystem Volume  
2. read-only mode: on the sandbox, you cannot edit the files and they are not synced back to the Volume  
3. read-write-copy: on the sandbox, you can read and write the files; Any writes are synced back to the volume as a separate filesystem tree, preserving the original file versions on the Volume

When coordinating the files via the `amikad` daemon, the plan is for the file-system to have transparent git-like capabilities for versioning files and allowing the agent to make “commit messages” describing why the files changed.

Can sync filesystem back to S3-compatible storage bucket, while avoiding naive problems with FUSE-based filesystems, which often lack full POSIX semantics. For example, you cannot git-clone with most FUSE-based systems because they don’t support symlinks, which are needed in git.

We’re also working on bidirectional file syncing, so if you have a materialization process that updates files in a Filesystem Volume, those file contents can be synced down into a sandbox’s filesystem, and vice-versa.

## **Network proxy**

*This system is in early design. Open source status TBD.*

**Goals for agent control:**

1. You can run arbitrary scripts to process inbound/outbound network requests and responses. These scripts are airgapped from the sandboxed agent’s control.  
2. You can set authorization rules at the network layer, to give total airgapped control over how the agent interacts with external systems  
3. You can mutate inbound/outbound network requests to control the types of requests the agent can make, to strip sensitive data, etc.  
4. You can totally airgap the the sandboxed agents from seeing sensitive data or secrets, injecting them and stripping them at the network layer.

**Goals for exposing services and ports running on a sandbox:**

1. You can control what ports/services are exposed from a sandbox  
2. You can control whether they are exposed publicly, or behind auth for your team only

## **Secrets Vault**

This system is in early design. Open source status TBD.

Stores secrets for a sandbox. You can either:

1. Totally isolate the secrets vault from the agent, and instead let the agent see “tokenized” versions of the secrets. Then, the network proxy layer is responsible for intercepting inbound/outbound network requests and turning tokenized secrets into the true secret values.  
   1. This is basically how credit card payments work on computers  
2. Give the agent access to the vault, optionally behind hooks that pause for human approval.  
   1. Safer than putting credentials in environment variables or directly on the filesystem

[single-sbox]: ./docs/assets/single-sbox-arch.svg

[multi-sbox]: ./docs/assets/multi-sbox-arch.svg
