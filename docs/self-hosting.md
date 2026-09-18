# Self-hosting Amika

Most of our efforts have gone into Amika's cloud product. That said, you can still self-host, and we are improving the Amika open source to have [a better self-hosted option](https://link.excalidraw.com/l/7iUc0S5ODSX/A9VRJ8WH3Jl).


The `amika` CLI no longer creates Rigs on your own machine. The `--local` mode,
which ran each Rig as a Docker container on the host, has been removed, so every
`amika` command now talks to the Amika control plane.

There is currently no supported local CLI path. Rig commands use the hosted
Amika control plane.

## Upcoming improvements

We're improving the self-hosted story of Amika in two ways:

1. you can use any machine as a Rig provider, and register them our Amika cloud control-plane so you can connect to them over the internet (with authentication of course!)
   1. in this way, we're kind of like Tailscale combined with a Virtual Machine Monitor (VMM)
2. when we open source the `amika-gateway`, you can run a fully self-hosted version of Amika
   1. wherever you run the `amika-gateway` server, if you can connect to its port or socket, you can create Rigs and connect to them
   2. the self-hosted `amika-gateway` is designed for single-player, so it doesn't support identity and access management for multiple users creating and connecting to Rigs
