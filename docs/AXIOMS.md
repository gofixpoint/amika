<p align="center">
  <h1 align="center"><strong>Axioms</strong></h1>
  <p align="center"><strong>Why we need a new operating system and how it should work</strong></p>
</p>

1. **Agents on computers will outnumber humans on computers.**

   Jevons Paradox says that as AI gets smarter, the cost of knowledge work decreases, and thus the demand for knowledge work increases. Most knowledge work is done on a computer, so there will be more agents doing more work on computers than there are humans doing work on computers.

2. **Agents need an operating system, not a framework.**

   A framework is for writing programs, but an agent can use a computer like a human does. Humans don't interact directly with a framework; they use the OS. Agents need an OS designed for them (and they can use frameworks inside that OS if they choose).

3. **Agent compute is heterogeneous.**

   There will be many different types of agents doing different tasks. These tasks need different work stations, so we need different types of hardware for both inference (GPUs) and execution (CPUs). This means there isn't one size-fits-all sandbox provider.

4. **The bundled micro-VM is the new type of program.**

   The future of a computer "program" is a bundle of: (a) micro VM, (b) AI agent, (c) software bundled in the VM. This means running a VM per "program" and interweaving how the AI, VM, and software interact. For example, the agent must be able to use (and modify) the software on the micro VM.

5. **New software is recursive and self-evolving.**

   A corollary to axiom 04. If an agent has access to software and source code, it can modify the software as it runs. This makes the bundled "program" dynamic, evolving, whatever you prefer to call it.

6. **The environment is the interface.**

   Agents do not act through narrow, hand-written tool schemas alone. They act by living inside a real computer with a filesystem, a shell, and a network. Give an agent a genuine environment and it can use the same tools people use, instead of a lossy proxy of them. The closer the environment is to the real thing, the more capable the agent becomes.

7. **Most agent workflows should look like git workflows.**

   Give an agent context, let it do work on a computer, and have it emit a versioned state change (like a git commit). You review it and read the agent's reasoning; CI can auto-process it; and when you approve, the agent takes the action. For example: an agent drafts a bunch of email messages. After you approve the "diff", they get sent.

8. **Isolation is a first-class primitive.**

   Agents make mistakes, and some of those mistakes are destructive. The blast radius of any single agent should be bounded by construction, not by hope. Fresh, disposable, isolated compute per task means a failure is contained to that task, and it means you can run a thousand experiments in parallel without them stepping on each other. The network is the interface to the outside world, and controlling it is where you enforce rules, gate data exfiltration, and decide what an agent is allowed to reach.

9. **Computers must be shareable between agents and humans.**

   Agents should be able to work on their own, but humans should also be able to take over when necessary. The same way you can let your coworker use your computer to show you something or tweak your work, a human must be able to take over the agent's workflow and computer.

10. **The UNIX Philosophy and Worse Is Better will win.**

    The [UNIX Philosophy](https://en.wikipedia.org/wiki/Unix_philosophy) and [Worse Is Better](https://en.wikipedia.org/wiki/Worse_is_better) share a core insight: simple and composable beats "technically better." Do the simplest thing that works, and make sure your pieces fit together through a universal interface.
