#!/usr/bin/env bash
# Runs on every Cloud Agent boot (the environment `start` command), when runtime secrets exist.
# Saves the keys for the stop hook. Never fatal.
set -uo pipefail

# The stop hook may not inherit the runtime secrets, so it reads this file as a fallback.
mkdir -p "$HOME/.agent-trace"
node -e '
  const fs = require("fs");
  const keys = ["CURSOR_TOKEN", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL", "AGENT_TRACE_ENVIRONMENT"];
  const env = Object.fromEntries(keys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  fs.writeFileSync(process.env.HOME + "/.agent-trace/env.json", JSON.stringify(env), { mode: 0o600 });
' || echo "agent trace env not saved; stop hook will use the hook's own environment" >&2
exit 0
