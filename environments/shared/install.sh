#!/usr/bin/env bash
# Runs at build time, after sync.mjs has copied the exporter to ~/.agent-trace/ and before the repo's own
# install command. Must be idempotent.
set -euo pipefail

# Register the stop hook now so it's in the build snapshot before any agent starts.
# Registering it only in `start` raced the agent: the first runs after a build went untraced.
# The hook exports the run's full trace (prompt, thinking, messages, tool results, tokens, cost) from Cursor's
# API. Cloud agents load project hooks from this file; a Cursor plugin's hooks don't run there (the plugin
# route was tested and never fired). The file only exists in the cloud build snapshot, and .git/info/exclude
# keeps it out of commits, so local checkouts never get it.
# The path is written in at build time, so the build and agent machines need the same home folder.
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
mkdir -p "$root/.cursor" "$root/.git/info"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const hooks = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, hooks: {} };
  const command = `node ${process.env.HOME}/.agent-trace/stop-hook.mjs`;
  hooks.hooks.stop = (hooks.hooks.stop ?? []).filter((hook) => hook.command !== command);
  hooks.hooks.stop.push({ command, timeout: 10 });
  fs.writeFileSync(file, JSON.stringify(hooks, null, 2) + "\n");
' "$root/.cursor/hooks.json"

grep -qxF '.cursor/' "$root/.git/info/exclude" 2>/dev/null || echo '.cursor/' >> "$root/.git/info/exclude"
