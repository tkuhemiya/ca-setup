#!/usr/bin/env bash
# Runs at build time, before the repo's own install command. Must be idempotent.
# Cursor's default image already has Node 22+ (via nvm) and a user-writable global npm prefix.
set -euo pipefail

# Langfuse's docs say `npm install -g @langfuse/cursor-observability-plugin`, but it isn't on npm yet.
# Pinned GitHub tarball instead: it ships the built dist/, so nothing needs compiling.
LANGFUSE_PLUGIN=https://codeload.github.com/langfuse/cursor-observability-plugin/tar.gz/a36d39a7c5cf
command -v langfuse-cursor-hook >/dev/null || npm install -g "$LANGFUSE_PLUGIN"
