// Health of the conversation log for `amux memory status`: how big it is,
// which panes post, how many human asks got an answer, and failed sends.

import { ledgerFileSizes, readWindow } from "./ask-ledger.mjs";
import { answeredShare } from "./dream-conversation.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

/** WHAT: Measures the log's size, last day's posts, failures and answered share. WHY: Shows growth and gaps before Dream and asks depend on the log. */
export function conversationLogHealth({ path, nowMs = Date.now() } = {}) {
  const sizes = ledgerFileSizes(path);
  const day = readWindow({ path, since: nowMs - DAY_MS });
  const latestPostByPane = {};
  for (const post of day.posts) {
    if (post.agent && post.status !== "failed") latestPostByPane[`${post.agent}:${post.pane}`] = post.ts;
  }
  return {
    currentBytes: sizes.filter((file) => file.current).reduce((sum, file) => sum + file.bytes, 0),
    archives: sizes.filter((file) => !file.current).length,
    archiveBytes: sizes.filter((file) => !file.current).reduce((sum, file) => sum + file.bytes, 0),
    posts: day.posts.length,
    failed: day.posts.filter((post) => post.status === "failed").length,
    latestPostByPane,
    answered: answeredShare(day, { sinceMs: Math.max(nowMs - DAY_MS, day.coverageStartMs), nowMs }),
  };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** WHAT: Renders the log's health as one status line. WHY: Keeps memory status short; --json carries the per-pane detail. */
export function formatConversationLogHealth(health) {
  const share = health.answered.share == null ? "no settled human asks"
    : `${health.answered.answered} of ${health.answered.asked} (${(health.answered.share * 100).toFixed(1)} %)`;
  return `Conversation log: ${mb(health.currentBytes)} current + ${health.archives} archive(s) ${mb(health.archiveBytes)};`
    + ` last 24 h ${health.posts} post(s) from ${Object.keys(health.latestPostByPane).length} pane(s), ${health.failed} failed;`
    + ` human asks answered by a post: ${share}`;
}
