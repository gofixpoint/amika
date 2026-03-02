# Sandbox Configuration

## Setup Scripts

The `--setup-script` flag lets you mount a local script into the container at `/opt/setup.sh`. The script runs automatically when the container starts, before the main command (CMD).

### Usage

```bash
# sandbox create
amika sandbox create --setup-script ./my-setup.sh

# materialize
amika materialize --setup-script ./my-setup.sh --cmd "echo done" --destdir /tmp/out
```

### Writing a setup script

Your script just needs to do its setup work and exit 0. You do **not** need to chain into the next command — the container's ENTRYPOINT handles that automatically.

```bash
#!/bin/bash
set -e

apt-get update && apt-get install -y ripgrep
pip install numpy
```

The script is mounted read-only, so it cannot be modified from inside the container.

### How it works

Preset images (coder, claude) bake a no-op `/opt/setup.sh` into the image and declare an ENTRYPOINT that runs it before execing into CMD:

```dockerfile
RUN printf '#!/bin/bash\nexit 0\n' > /opt/setup.sh \
    && chmod +x /opt/setup.sh
ENTRYPOINT ["/bin/bash", "-c", "/opt/setup.sh && exec \"$@\"", "--"]
```

When you pass `--setup-script`, your script is bind-mounted over the no-op, so the ENTRYPOINT runs your script instead.

### Notes

- The script must be executable (`chmod +x`).
- If the script exits with a non-zero status, the container's main command will not run.
- Preset images are cached locally. If you have an existing preset image from before this feature was added, you need to rebuild it by removing the old image first: `docker rmi amika/coder:latest`.
