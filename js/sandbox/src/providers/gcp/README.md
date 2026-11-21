# GCP provider

The GCP provider runs sandboxes as [Compute Engine](https://cloud.google.com/compute)
VMs in a project you own. The org pays Google, and the VMs use the project's
quotas. The provider drives the Compute Engine REST API with a service
account key, and runs commands and file transfers over SSH, because
Compute Engine has no API for either. It uses no Google library.

## Configuration

| Variable                  | Purpose                                                  |
| ------------------------- | -------------------------------------------------------- |
| `GCP_ENABLED`             | `true` turns the provider on                             |
| `GCP_SERVICE_ACCOUNT_KEY` | A service account's JSON key, or that JSON in base64     |
| `GCP_ZONE`                | Optional zone (`us-central1-a`)                          |
| `GCP_API_URL`             | Optional API base URL (`https://compute.googleapis.com`) |

The key names the project. A `zone` field added to the key JSON wins over
`GCP_ZONE`, so a key pasted as a cloud account can pick its zone.

### What the service account needs

- `roles/compute.instanceAdmin.v1` on the project, to create, start, stop,
  and delete VMs and images.
- `roles/iam.serviceAccountUser` is not needed: VMs run with no service
  account.
- Permission to create firewall rules (`roles/compute.securityAdmin`), or a
  rule made by hand: allow `tcp:22` from `0.0.0.0/0` to target tag
  `amika-rig` in the `default` network, named `amika-allow-ssh`.

The project needs the `default` VPC network.

## How the contract maps to Compute Engine

- **Size.** An E2 custom machine type (`e2-custom-<vcpus>-<MiB>`): an even
  vCPU count from 2 to 32, and 0.5 to 8 GiB of memory per vCPU. The boot
  disk is a balanced persistent disk of at least 20 GiB.
- **Image.** `CreateSandboxProviderInput.snapshot` is a full image path
  (`projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64`), an
  image in the project (`global/images/<name>`), or an image name.
- **User and home.** `amika`, home `/home/amika`. Google's guest agent makes
  the user from the VM's `ssh-keys` metadata and gives it `sudo`. Create
  sets `enable-oslogin=FALSE` on the VM, because OS Login ignores
  `ssh-keys`.
- **SSH key.** Derived, never stored: an HMAC of the project and VM name,
  keyed with the service account's private key, seeds an ed25519 key. Only a
  holder of the service account key can derive it.
- **Host key.** The guest agent publishes the VM's host keys as guest
  attributes (`hostkeys/`). The provider reads them with the Compute API and
  refuses a server that shows any other key. Nothing is trusted on first
  use.
- **Readiness.** Create and start return once SSH runs a command.
- **Stop and start.** `stop` powers the VM off (`TERMINATED`); the disk
  stays. Compute Engine has no idle timer, so `autoStopInterval` is ignored.
- **Exec.** `bash -lc` over SSH, with stdin and streaming. A command runs at
  most 30 minutes.
- **Names.** VM and image names are 1-63 of `a-z`, `0-9`, `-`, starting with
  a letter. Other names map to a slug plus a hash (`internal/names.ts`). The
  exact name rides in the `amika-sandbox-name` metadata item.
- **Listing** reports the zone's VMs with the `amika-managed=true` label.
- **Snapshots.** A disk image of the boot disk (no memory), made with
  `forceCreate`, so a running VM keeps running. The handle is the image path.
- **Not supported:** service URLs and minted SSH access (Compute Engine has
  no port routing), auto-delete, and account sizes.

## Running the contract suite

```bash
TEST_SANDBOX_CONTRACT_PROVIDER=gcp \
TEST_SANDBOX_CONTRACT_SNAPSHOT=projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64 \
GCP_SERVICE_ACCOUNT_KEY="$(base64 -w0 key.json)" \
pnpm --filter @amika/sandbox test:integration
```
