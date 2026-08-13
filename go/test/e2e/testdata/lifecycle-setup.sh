#!/bin/bash

# Turn the public no-config example repository into a restart-semantic fixture.
# The first provision runs this setup hook; later `sandbox start` operations
# must rediscover the repository's config and run the start hook below without
# rerunning this setup hook.

set -Eeuo pipefail

cd "${AMIKA_AGENT_CWD:?AMIKA_AGENT_CWD must be set for repository setup}"
mkdir -p .amika/scripts

cat > .amika/config.toml <<'EOF'
[lifecycle]
start_script = ".amika/scripts/start.sh"
EOF

cat > .amika/scripts/start.sh <<'EOF'
#!/bin/bash
set -Eeuo pipefail

cd "${AMIKA_AGENT_CWD:?AMIKA_AGENT_CWD must be set for repository start}"
printf '%s\n' 'repository-start-hook-ran' >> .amika/e2e-start-runs
printf '%s\n' 'repository-start-hook-ran'
EOF

chmod 0755 .amika/scripts/start.sh
printf '%s\n' 'repository-setup-hook-ran' > .amika/e2e-setup-sentinel
