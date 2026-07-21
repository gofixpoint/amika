#!/bin/bash
set -e

# In the Amika lifecycle this script is not run in place from .amika/scripts:
# it is uploaded and executed from elsewhere with AMIKA_AGENT_CWD set to the
# repo root, so resolve the repo from there. Fall back to a $0-relative path
# for manual runs where AMIKA_AGENT_CWD is unset.
REPO_ROOT="${AMIKA_AGENT_CWD:-$(cd "$(dirname "$0")/../.." && pwd)}"

# Run the repo setup script (configures git hooks, etc.). Amika sandboxes
# invoke this setup script but never run setup-repo.sh on their own, so do
# it here to ensure git hooks are active for commits made inside the sandbox.
"$REPO_ROOT/setup-repo.sh"

# Check if Go is already installed
if command -v go &>/dev/null; then
    echo "Go is already installed: $(go version)"
    exit 0
fi

echo "Go not found. Installing..."

GO_VERSION="1.26.1"
ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)

# Normalize architecture name
case "$ARCH" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz
sudo tar -C /usr/local -xzf /tmp/go.tar.gz
rm /tmp/go.tar.gz

# Make Go available system-wide
echo 'export PATH=$PATH:/usr/local/go/bin' | sudo tee /etc/profile.d/golang.sh > /dev/null

echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.zshrc
echo "Installed: $(go version)"
