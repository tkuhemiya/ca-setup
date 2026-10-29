#!/usr/bin/env bash
# Runs at build time, before the repo's own install command. Must be idempotent.
# Cursor's default image already has Node 22+ (via nvm) and a user-writable global npm prefix.
set -euo pipefail

# Langfuse's docs say `npm install -g @langfuse/cursor-observability-plugin`, but it isn't on npm yet.
# Pinned GitHub tarball instead: it ships the built dist/, so nothing needs compiling.
LANGFUSE_PLUGIN=https://codeload.github.com/langfuse/cursor-observability-plugin/tar.gz/a36d39a7c5cf
command -v langfuse-cursor-hook >/dev/null || npm install -g "$LANGFUSE_PLUGIN"

# Register the hooks now so they're in the build snapshot before any agent starts.
# Registering them only in `start` raced the agent: the first runs after a build went untraced.
# The template holds commands only; the plugin reads the keys from the LANGFUSE_* secrets at runtime.
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
mkdir -p "$root/.cursor" "$root/.git/info"
cp "$(npm root -g)/@langfuse/cursor-observability-plugin/templates/project-hooks.json" "$root/.cursor/hooks.json"
grep -qxF '.cursor/' "$root/.git/info/exclude" 2>/dev/null || echo '.cursor/' >> "$root/.git/info/exclude"
