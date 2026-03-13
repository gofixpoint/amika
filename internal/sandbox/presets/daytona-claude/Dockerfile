# Locally, this image is called "amika/daytona-claude"

ARG CLAUDE_IMAGE=amika/claude:latest
FROM ${CLAUDE_IMAGE}

# In Daytona we do not manage container/sandbox lifecycle via Docker ENTRYPOINT.
# That lifecycle is orchestrated by our external control plane, so the image
# must not run Amika setup hooks from the Docker entrypoint.
ENTRYPOINT []
