# Rig lifecycle and status

The rig API reports two independent fields: `status` describes the VM's power
state, and `setup_status` describes the most recent create or start setup run.
A running VM can still be setting up or have a setup failure.

| `status`       | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `creating`     | The VM is being created.                                        |
| `starting`     | A stopped or suspended VM is starting.                          |
| `running`      | The VM is powered on. Check `setup_status` before using agents. |
| `stopping`     | The VM is turning off; its memory state will be discarded.      |
| `stopped`      | The VM is off; disk persists, but memory state was discarded.   |
| `suspending`   | The VM is pausing while retaining memory state.                 |
| `suspended`    | The VM is paused with its memory state retained.                |
| `snapshotting` | A snapshot is being captured.                                   |
| `failed`       | The VM is gone or unusable.                                     |
| `unknown`      | The provider cannot identify the VM's current state.            |

`stopping`/`stopped` and `suspending`/`suspended` describe what happens to the
VM, regardless of whether Amika or the provider initiated the transition.
`amika rig stop` turns the VM off. A provider's idle policy may instead suspend
it; `amika rig start` can bring either settled state back up. Freestyle idle
suspension is disabled on create and start; Freestyle rigs then have no automatic
idle stop. Existing running Freestyle rigs keep their previous idle timer until
their next start.

| `setup_status`     | Meaning                                      |
| ------------------ | -------------------------------------------- |
| `setup-running`    | Clone and setup are still in progress.       |
| `ok`               | The latest setup run completed successfully. |
| `git-failed`       | The primary repository clone failed.         |
| `setup-failed`     | The user's setup or start script failed.     |
| `sys-setup-failed` | Amika's system setup failed.                 |
| `null`             | No setup outcome has been recorded yet.      |

An otherwise healthy rig with a setup failure remains `running`, with the
failure in `setup_status`. A successful start normally replaces an earlier
failure; `git-failed` persists because start does not reclone the primary
repository. While `setup-running`, agent operations must wait, and stop and
snapshot are refused. Delete remains available to abort a stuck setup.

E2B reports both kinds of pause as `paused`. Amika pauses E2B rigs without
memory and reports them as `stopped`; memory-preserving pauses initiated
outside Amika cannot currently be distinguished through that provider API.

The legacy `state` API field mixes stored orchestration states and raw provider
states. New clients should use `status` and `setup_status`.
