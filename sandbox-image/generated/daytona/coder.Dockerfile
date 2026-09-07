# syntax=docker/dockerfile:1

ARG UBUNTU_TAG=24.04
FROM ubuntu:${UBUNTU_TAG}

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

ARG GIT_VERSION=2.55.0
COPY sandbox-image/steps/10-os-packages.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

COPY sandbox-image/assets/stable /opt/amika-build/step-assets
COPY sandbox-image/steps/20-static-config.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh /opt/amika-build/step-assets \
    && rm -rf /opt/amika-build

ARG NODE_VERSION=24.20.0
ARG GH_VERSION=2.98.0
COPY sandbox-image/steps/30-node-gh.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

ARG PNPM_VERSION=12.1.0
ARG TYPESCRIPT_VERSION=7.0.2
ARG TSX_VERSION=4.23.13
COPY sandbox-image/steps/40-npm-toolchain.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

COPY sandbox-image/steps/50-runtime-user.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

COPY sandbox-image/assets/providers/daytona /opt/amika-build/step-assets
COPY sandbox-image/steps/55-daytona-vm-user.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh /opt/amika-build/step-assets \
    && rm -rf /opt/amika-build

COPY sandbox-image/assets/stable /opt/amika-build/step-assets
COPY sandbox-image/steps/60-dotfiles.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh /opt/amika-build/step-assets \
    && rm -rf /opt/amika-build

COPY sandbox-image/assets/hooks /opt/amika-build/step-assets
COPY sandbox-image/steps/70-hook-assets.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh /opt/amika-build/step-assets \
    && rm -rf /opt/amika-build

ARG CLAUDE_CODE_VERSION=2.1.252
ARG CODEX_VERSION=0.151.0
ARG OPENCODE_VERSION=1.18.25
ARG PI_VERSION=0.84.4
COPY sandbox-image/steps/80-agent-clis.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

ARG PI_WEB_VERSION=0.8.11
COPY sandbox-image/steps/82-pi-web.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

ARG AMIKA_VERSION=0.18.0
ARG AMIKALOG_VERSION=0.2.0
ARG AMIKAD_VERSION=0.1.0
COPY sandbox-image/steps/85-amika-clis.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

COPY sandbox-image/steps/94-setuid-manifest.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

COPY sandbox-image/manifest.toml /usr/lib/amika-image/manifest.toml
COPY sandbox-image/versions.env /usr/lib/amika-image/versions.env
COPY sandbox-image/verify /usr/lib/amika-image/verify
COPY sandbox-image/steps/95-verify.sh /opt/amika-build/step.sh
RUN AMIKA_IMAGE_PROVIDER=daytona AMIKA_PRESET=coder /opt/amika-build/step.sh \
    && rm -rf /opt/amika-build

USER amika
ENV HOME=/home/amika
WORKDIR /home/amika
