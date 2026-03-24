# Locally, this image is called "amika/dind"

ARG BASE_IMAGE=amika/base:latest
FROM ${BASE_IMAGE}

USER root

# Install Docker CE (https://docs.docker.com/engine/install/ubuntu/).
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
       -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
       $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y \
       docker-ce \
       docker-ce-cli \
       containerd.io \
       docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

# Let the amika user run Docker commands without sudo.
RUN usermod -aG docker amika

# Marker file so pre-setup.sh knows to start dockerd.
RUN mkdir -p /usr/local/etc/amika && touch /usr/local/etc/amika/dind-enabled

USER amika
