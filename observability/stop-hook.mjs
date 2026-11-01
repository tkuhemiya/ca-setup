#!/usr/bin/env node
// Cursor `stop` hook for Cloud Agents. The payload names the run (`conversation_id` is the agent id,
// `generation_id` the run id) and its model, so this starts `export.mjs --run` for exactly that run in
// its own session and returns at once. The machine stays up at least 10 minutes after `stop` (probed
// 2026-10-30), and the export needs about a minute for usage to settle.
//
// Needs CURSOR_TOKEN and the Langfuse keys as runtime secrets, plus LANGFUSE_BASE_URL. Never blocks the
// agent: any failure is logged to export.log next to this file and the hook still answers.

import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const DIR = new URL("./", import.meta.url).pathname;
const log = (line) => appendFileSync(`${DIR}export.log`, `${new Date().toISOString()} ${line}\n`);

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input || "{}");
  const agentId = payload.conversation_id;
  const runId = payload.generation_id;
  if (payload.hook_event_name === "stop" && agentId?.startsWith("bc-") && runId) {
    // Hooks may not inherit the runtime secrets, so `start` also saves them next to this file.
    const saved = existsSync(`${DIR}env.json`) ? JSON.parse(readFileSync(`${DIR}env.json`, "utf8")) : {};
    const env = { ...saved, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
    const out = openSync(`${DIR}export.log`, "a");
    const args = [`${DIR}export.mjs`, "--run", `${agentId}:${runId}`, "--model", payload.model ?? "unknown"];
    if (env.AGENT_TRACE_ENVIRONMENT) args.push("--environment", env.AGENT_TRACE_ENVIRONMENT);
    // setsid puts the export in its own session, so ending the hook's process group doesn't stop it.
    spawn("setsid", [process.execPath, ...args], { detached: true, env, stdio: ["ignore", out, out] })
      .on("error", (error) => log(`spawn failed: ${error.message}`))
      .unref();
    log(`started export of ${agentId}:${runId}`);
  }
} catch (error) {
  log(`hook failed: ${error.message}`);
}
process.stdout.write("{}\n");
