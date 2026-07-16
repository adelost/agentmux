#!/usr/bin/env node

import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(`${JSON.stringify({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    subscriptionType: "max",
  })}\n`);
  process.exit(0);
}
if (args[0] === "--version") {
  process.stdout.write("0.0.0-fake (Claude Code)\n");
  process.exit(0);
}

const resumeIndex = args.indexOf("--resume");
const sessionId = resumeIndex >= 0
  ? args[resumeIndex + 1]
  : args[args.indexOf("--name") + 1]?.includes("persistent")
    ? "11111111-1111-4111-8111-111111111111"
    : "22222222-2222-4222-8222-222222222222";
let pendingInterrupt = false;

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const usageFor = (marker) => marker.startsWith("BOOT_")
  ? { input_tokens: 10, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 0, output_tokens: 4 }
  : { input_tokens: 10, cache_creation_input_tokens: 10, cache_read_input_tokens: 1_000, output_tokens: 4 };

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    emit({
      type: "control_response",
      response: { subtype: "success", request_id: message.request_id, response: { still_queued: [] } },
    });
    if (pendingInterrupt) {
      pendingInterrupt = false;
      emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: sessionId,
      });
    }
    return;
  }

  const prompt = String(message.message?.content ?? "");
  emit({ type: "system", subtype: "init", session_id: sessionId });
  if (prompt.includes("sleep 20")) {
    pendingInterrupt = true;
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        model: "claude-haiku-fake",
        content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "sleep 20" } }],
      },
    });
    return;
  }

  const marker = prompt.match(/Reply exactly:\s*([A-Za-z0-9_]+)/)?.[1] ?? "UNKNOWN";
  emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: marker,
    usage: usageFor(marker),
    modelUsage: {
      "claude-haiku-fake": {
        inputTokens: 10,
        outputTokens: 4,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 1_000,
        contextWindow: 200_000,
      },
    },
  });
});
