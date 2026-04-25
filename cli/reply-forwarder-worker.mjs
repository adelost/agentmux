#!/usr/bin/env node
// Detached child that forwards a pane's reply to a Discord channel after
// `amux send` mirrored its brief there. Runs out-of-process so the CLI
// exits immediately while the worker waits for the agent to respond.
//
// Inputs (env JSON in REPLY_FWD_OPTS):
//   channelId     — Discord channel to post to
//   paneDir       — pane cwd (used to locate jsonl)
//   briefSnippet  — first ~80 chars of the brief, used to find OUR turn
//   sentAtMs      — wall-clock when brief was sent
//   timeoutMs     — give-up after this long (default 120s)
//   pollMs        — between jsonl reads (default 3s)
//
// Behavior: polls jsonl for a turn whose userPrompt contains briefSnippet
// AND has at least one assistant text item. When found, posts via the
// OpenClaw gateway. Skips boilerplate. Errors are logged to stderr (which
// is /dev/null'd by the parent's spawn anyway).

import { extractMatchingReply, isBoilerplateReply } from "../core/reply-forwarder.mjs";
import { sendToChannelId } from "./send-notify.mjs";

const opts = JSON.parse(process.env.REPLY_FWD_OPTS || "{}");
const {
  channelId,
  paneDir,
  briefSnippet,
  sentAtMs,
  timeoutMs = 120_000,
  pollMs = 3_000,
} = opts;

if (!channelId || !paneDir || !briefSnippet || !sentAtMs) {
  process.stderr.write(`reply-fwd-worker: missing required opts\n`);
  process.exit(1);
}

const matcher = (userPromptText) => userPromptText.includes(briefSnippet);
const deadline = sentAtMs + timeoutMs;

(async () => {
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const reply = extractMatchingReply(paneDir, sentAtMs, matcher);
    if (!reply) continue;
    if (isBoilerplateReply(reply)) {
      // Brief turn exists with boilerplate-only reply — done, no post.
      process.exit(0);
    }
    const safe = reply.length > 1900 ? reply.slice(0, 1900) + "\n…[truncated]" : reply;
    try {
      await sendToChannelId(channelId, safe);
    } catch (err) {
      process.stderr.write(`reply-fwd-worker send failed: ${err.message}\n`);
    }
    process.exit(0);
  }
  // Timed out — no reply ever materialized (silent absorb, or pane busy
  // with something else).
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`reply-fwd-worker crashed: ${err.message}\n`);
  process.exit(1);
});
