#!/usr/bin/env bash
# Runs on every Cloud Agent boot (the environment `start` command), when runtime secrets exist.
# Registers the Langfuse hooks in this checkout only, and hides them from git. Never fatal.
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root" || exit 0

# Reads LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL from the environment.
langfuse-cursor-hook setup --project . --hooks || echo "langfuse setup failed; agent runs untraced" >&2

# Local-only ignore
mkdir -p .git/info
grep -qxF '.cursor/' .git/info/exclude 2>/dev/null || echo '.cursor/' >> .git/info/exclude
exit 0
