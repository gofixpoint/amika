# Self-hosting Amika

Most of our efforts have gone into Amika's cloud product. That said, you can still self-host, and we are improving the Amika open source to have [a better self-hosted option](https://link.excalidraw.com/l/7iUc0S5ODSX/A9VRJ8WH3Jl).


Self-hosting currently supports a "local-only" mode that spins up Docker containers as Amika sandboxes. It handles loading your git repo and agent credentials into the container.

```
┌────────────────────┐
│   Your Host        │
│                    │     ┌──────────────────────────────────┐
│  Git repo ───────────>   │  Docker Sandbox                  │
│                    │     │                                  │
│  Credentials ────────>   │  /home/amika/workspace/{repo}    │
│  (auto-discovered) │     │  Agent CLIs ready (claude, codex)│
│                    │     │  Dev tools (git, node, python)   │
│  Setup script ───────>   │  setup.sh runs on start          │
│                    │     │                                  │
│  Port 8080 <──────────   │  --port 8080:8080                │
│  (live preview)    │     │                                  │
└────────────────────┘     └──────────────────────────────────┘
```

To run local sandboxes, include the `--local` flag whenever you run an `amika` command.

```
amika sandbox create --local --name local-sandbox
amika sandbox ls --local
amika sandbox connect --local local-sandbox
amika sandbox rm --local local-sandbox
```


## Upcoming improvements

We're improving the self-hosted story of Amika in two ways:

1. you can use any machine as a sandbox provider, and register them our Amika cloud control-plane so you can connect to them over the internet (with authentication of course!)
   1. in this way, we're kind of like Tailscale combined with a Virtual Machine Monitor (VMM)
2. when we open source the `amika-gateway`, you can run a fully self-hosted version of Amika
   1. wherever you run the `amika-gateway` server, if you can connect to its port or socket, you can create sandboxes and connect to them
   2. the self-hosted `amika-gateway` is designed for single-player, so it doesn't support identity and access management for multiple users creating and connecting to sandboxes
