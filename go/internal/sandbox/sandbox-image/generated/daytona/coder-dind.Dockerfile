# syntax=docker/dockerfile:1

ARG UBUNTU_TAG=24.04
FROM ubuntu:${UBUNTU_TAG}

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

ARG GIT_VERSION=2.43.0
COPY sandbox-image/steps/10-os-packages.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

COPY sandbox-image/assets/stable /opt/amika-build/step-assets
COPY sandbox-image/steps/20-static-config.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh /opt/amika-build/step-assets \
    && rm -rf /opt/amika-build

ARG NODE_VERSION=22.19.0
ARG GH_VERSION=2.76.2
COPY sandbox-image/steps/30-node-gh.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

ARG PNPM_VERSION=10.15.1
ARG TYPESCRIPT_VERSION=5.9.2
ARG TSX_VERSION=4.20.3
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

ARG CLAUDE_CODE_VERSION=2.1.224
ARG CODEX_VERSION=0.147.0
ARG OPENCODE_VERSION=1.18.4
ARG PI_VERSION=0.84.1
COPY sandbox-image/steps/80-agent-clis.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

ARG PI_WEB_VERSION=0.8.9
COPY sandbox-image/steps/82-pi-web.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

ARG AMIKA_VERSION=0.15.0
ARG AMIKALOG_VERSION=0.2.0
ARG AMIKAD_VERSION=0.1.0
COPY sandbox-image/steps/85-amika-clis.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

ARG DOCKER_VERSION=28.3.3
ARG BUILDX_VERSION=0.25.0
COPY sandbox-image/steps/90-dind.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

COPY sandbox-image/steps/94-setuid-manifest.sh /opt/amika-build/step.sh
RUN /opt/amika-build/step.sh && rm -rf /opt/amika-build

COPY sandbox-image/manifest.toml /usr/lib/amika-image/manifest.toml
COPY sandbox-image/versions.env /usr/lib/amika-image/versions.env
COPY sandbox-image/verify /usr/lib/amika-image/verify
COPY sandbox-image/steps/95-verify.sh /opt/amika-build/step.sh
RUN AMIKA_IMAGE_PROVIDER=daytona AMIKA_PRESET=coder-dind /opt/amika-build/step.sh \
    && rm -rf /opt/amika-build

USER amika
ENV HOME=/home/amika
WORKDIR /home/amika
