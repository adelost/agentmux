import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAskLedger, appendPost } from "./ask-ledger.mjs";
import { conversationLogHealth, formatConversationLogHealth } from "./conversation-log-health.mjs";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const at = (hoursAgo) => NOW - hoursAgo * 3_600_000;

feature("conversation log health in memory status", () => {
  component("status shows size, posting panes, failed sends and answered asks", {
    given: ["a day with two human asks, one answered, and one failed send", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-log-health-"));
      const path = join(root, "ask-ledger.jsonl");
      const now = () => NOW;
      appendPost({ ts: at(6), agent: "lsrc", pane: 0, channelId: "c-0", via: "bridge", kind: "notice", payload: "bryggan startad" }, { path, now });
      appendAskLedger({ ts: at(5), agent: "lsrc", pane: 0, source: "discord", verbatim: "fixa felet" }, { path, now });
      appendPost({ ts: at(4.9), agent: "lsrc", pane: 0, channelId: "c-0", via: "bridge", kind: "reply", payload: "SUMMARY: fixat" }, { path, now });
      appendAskLedger({ ts: at(3), agent: "lsrc", pane: 1, source: "pane-hook", verbatim: "och nästa" }, { path, now });
      appendPost({ ts: at(2), agent: "lsrc", pane: 1, channelId: "c-1", via: "bridge", kind: "reply", payload: "SUMMARY: nej",
        status: "failed", error: "50013: Missing Permissions" }, { path, now });
      return { root, path };
    }],
    when: ["reading health", ({ path }) => {
      const health = conversationLogHealth({ path, nowMs: NOW });
      return { health, line: formatConversationLogHealth(health) };
    }],
    then: ["one of two asks answered, one failed post, one posting pane", ({ health, line }, { root }) => {
      try {
        expect(health).toMatchObject({ archives: 0, posts: 3, failed: 1,
          latestPostByPane: { "lsrc:0": new Date(at(4.9)).toISOString() }, answered: { asked: 2, answered: 1 } });
        expect(health.currentBytes).toBeGreaterThan(0);
        expect(line).toMatch(/^Conversation log: 0\.0 MB current \+ 0 archive\(s\) 0\.0 MB; last 24 h 3 post\(s\) from 1 pane\(s\), 1 failed; human asks answered by a post: 1 of 2 \(50\.0 %\)$/u);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });
});
