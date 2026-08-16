# syntax=docker/dockerfile:1

ARG UBUNTU_TAG=24.04
FROM ubuntu:${UBUNTU_TAG}

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

ARG GIT_VERSION=2.43.0
COPY sandbox-image/steps/10-os-packages.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh && rm -rf /tmp/amika-step.sh

COPY sandbox-image/assets/stable /tmp/amika-step-assets
COPY sandbox-image/steps/20-static-config.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh /tmp/amika-step-assets \
    && rm -rf /tmp/amika-step.sh /tmp/amika-step-assets

ARG NODE_VERSION=22.19.0
ARG GH_VERSION=2.76.2
COPY sandbox-image/steps/30-node-gh.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh && rm -rf /tmp/amika-step.sh

ARG PNPM_VERSION=10.15.1
ARG TYPESCRIPT_VERSION=5.9.2
ARG TSX_VERSION=4.20.3
COPY sandbox-image/steps/40-npm-toolchain.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh && rm -rf /tmp/amika-step.sh

COPY sandbox-image/steps/50-runtime-user.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh && rm -rf /tmp/amika-step.sh

COPY sandbox-image/assets/stable /tmp/amika-step-assets
COPY sandbox-image/steps/60-dotfiles.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh /tmp/amika-step-assets \
    && rm -rf /tmp/amika-step.sh /tmp/amika-step-assets

COPY sandbox-image/assets/hooks /tmp/amika-step-assets
COPY sandbox-image/steps/70-hook-assets.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh /tmp/amika-step-assets \
    && rm -rf /tmp/amika-step.sh /tmp/amika-step-assets

ARG CLAUDE_CODE_VERSION=2.1.224
ARG CODEX_VERSION=0.147.0
ARG OPENCODE_VERSION=1.18.4
ARG PI_VERSION=0.84.1
COPY sandbox-image/steps/80-agent-clis.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh && rm -rf /tmp/amika-step.sh

ARG AMIKA_VERSION=0.14.1
ARG AMIKALOG_VERSION=0.2.0
ARG AMIKAD_VERSION=0.1.0
COPY sandbox-image/steps/85-amika-clis.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh && rm -rf /tmp/amika-step.sh

COPY sandbox-image/steps/94-setuid-manifest.sh /tmp/amika-step.sh
RUN /tmp/amika-step.sh && rm -rf /tmp/amika-step.sh

COPY sandbox-image/manifest.toml /usr/lib/amika-image/manifest.toml
COPY sandbox-image/versions.env /usr/lib/amika-image/versions.env
COPY sandbox-image/verify /usr/lib/amika-image/verify
COPY sandbox-image/steps/95-verify.sh /tmp/amika-step.sh
RUN AMIKA_PRESET=coder /tmp/amika-step.sh && rm -rf /tmp/amika-step.sh

USER amika
ENV HOME=/home/amika
WORKDIR /home/amika
