import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendPost } from "./ask-ledger.mjs";
import { collectSearchHits } from "../cli/search.mjs";

feature("search includes exact posted conversation, not only the event ledger", () => {
  component("a phrase posted only to Discord is a source-bound lexical hit", {
    given: ["a canonical post that never appeared in memory or a provider journal", () => {
      const root = mkdtempSync(join(tmpdir(), "search-conversation-")), path = join(root, "ledger.jsonl");
      const previous = process.env.AMUX_ASK_LEDGER_PATH;
      process.env.AMUX_ASK_LEDGER_PATH = path;
      const row = appendPost({ agent: "api", pane: 2, channelId: "channel", via: "bridge", kind: "reply", messageId: "real-message",
        payload: "Hirohiko som tecknar Jojo, ett exakt åäö-citat.", ts: Date.now() - 60000 }, { path });
      return { root, path, previous, row };
    }],
    when: ["searching the actual CLI collector without semantic or journal roots", fx => collectSearchHits("Hirohiko som tecknar Jojo", [], fx.root, { raw: true, lexical: true })],
    then: ["the complete canonical row is identified by its stable id and real timestamp", (result, fx) => {
      expect(result.top).toHaveLength(1);
      expect(result.top[0]).toMatchObject({ conversationId: fx.row.id, timestamp: fx.row.ts, messageId: "real-message" });
      expect(result.top[0].snippet).toContain("Hirohiko");
    }],
    cleanup: fx => {
      if (fx.previous === undefined) delete process.env.AMUX_ASK_LEDGER_PATH; else process.env.AMUX_ASK_LEDGER_PATH = fx.previous;
      rmSync(fx.root, { recursive: true, force: true });
    },
  });
});
