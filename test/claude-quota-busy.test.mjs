import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBusyFromJsonl } from "../core/jsonl-reader.mjs";
import { activeClaudeLimitReceipt } from "../core/claude-quota-recovery.mjs";
import { claudeProjectDir } from "../core/claude-paths.mjs";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const home = process.env.HOME;
const roots = [];
afterEach(() => {
  process.env.HOME = home;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Sanitized claw:2 journal shape, 2026-10-12 09:07:44Z to 09:13:06Z.
const limit = {
  type: "assistant", uuid: "limit-event", sessionId,
  timestamp: "2026-10-12T09:07:44.015Z",
  isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429,
  message: { model: "<synthetic>", stop_reason: "stop_sequence", content: [{
    type: "text",
    text: "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets Oct 14, 2am (Europe/Stockholm)",
  }] },
};
const notification = {
  type: "user", uuid: "task-event", sessionId,
  timestamp: "2026-10-12T09:13:06.924Z",
  origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system",
  message: { content: "<task-notification>\n<task-id>background-task</task-id>\n<status>failed</status>\n<summary>Agent terminated early due to an API error: HTTP 429 monthly spend limit</summary>\n</task-notification>" },
};

function observe(events) {
  const root = mkdtempSync(join(tmpdir(), "amux-quota-busy-"));
  roots.push(root);
  process.env.HOME = root;
  const paneDir = join(root, "repo", ".agents", "2");
  const project = claudeProjectDir(paneDir);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sessionId}.jsonl`), events.map(e => JSON.stringify(e)).join("\n") + "\n");
  return { busy: isBusyFromJsonl(paneDir), receipt: activeClaudeLimitReceipt(paneDir) };
}

describe("quota-terminated Claude turn with trailing background notifications", () => {
  it("is idle and retains its exact-session quota receipt", () => {
    // Given an exact stop then queue bookkeeping and a failed background notification.
    const result = observe([limit, { type: "queue-operation", sessionId }, notification]);
    // When reading through the real filesystem readers, then neither blocks forever.
    expect(result.busy).toBe(false);
    expect(result.receipt).toMatchObject({ sessionId, limitEventId: "limit-event" });
  });

  it.each([
    [],
    [{ ...limit, sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    [{ ...limit, timestamp: "2026-10-12T09:14:00Z" }],
  ])("cannot infer idle from a notification without a preceding same-session receipt", (...prefix) => {
    // Given absent, foreign-session, or later stop evidence, then retain the busy guard.
    expect(observe([...prefix, notification]).busy).toBe(true);
  });

  it.each([
    { type: "user", sessionId, timestamp: "2026-10-12T09:14:00Z", message: { content: "Continue my actual work" } },
    { type: "assistant", sessionId, message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "new-work", name: "Bash" }] } },
    { type: "user", sessionId, message: { content: [{ type: "tool_result", tool_use_id: "new-work", content: "result" }] } },
  ])("does not let a stop supersede later real work", later => {
    // Given new work after the notification, then the old quota receipt is inactive.
    const result = observe([limit, notification, later]);
    expect(result.busy).toBe(true);
    expect(result.receipt).toBeNull();
  });

  it("does not ignore text appended outside a notification wrapper", () => {
    // Given a notification plus an actual new question, then no idle authority survives.
    const mixed = { ...notification, message: { content: notification.message.content + "\nNow implement something else" } };
    expect(observe([limit, mixed]).busy).toBe(true);
  });

  it("does not trust a human quoting an engine notification", () => {
    // Given the same XML authored by a human, then it remains a new real turn.
    expect(observe([limit, { ...notification, origin: undefined, promptSource: undefined }]).busy).toBe(true);
  });

  it.each([
    { ...limit, error: undefined },
    { ...limit, message: { ...limit.message, model: "claude-opus" } },
    { ...limit, message: { ...limit.message, stop_reason: "tool_use" } },
  ])("requires an actual terminal synthetic rate-limit event, not model prose", stop => {
    // Given quota-looking prose without a terminal engine error, then it cannot authorize idle.
    expect(observe([stop, notification]).busy).toBe(true);
  });
});
