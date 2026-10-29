# Ambulink-Main: npm workspaces + turbo monorepo.
# Contract for every repo Dockerfile: Node 22+ with npm, git, and a non-root user with
# passwordless sudo, ending as that user. sync.mjs appends the Langfuse layer after it.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg sudo build-essential \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g npm@11.8.0

RUN useradd -m -s /bin/bash ubuntu \
 && echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu
USER ubuntu
