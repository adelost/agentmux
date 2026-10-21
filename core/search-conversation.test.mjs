import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendPost } from "./ask-ledger.mjs";
import { collectSearchHits } from "../cli/search.mjs";
import { conversationHit, rankConversationHits } from "./search-conversation.mjs";
import { formatHits } from "./search.mjs";

feature("original words and posted answers lead search", () => {
  unit("his older words and a real reply lead a newer tool mirror, with explicit authors", {
    when: ["ranking and displaying three canonical rows with the same query", () => {
      const nowMs = Date.parse("2026-10-21T12:00:00Z");
      const rows = [
        { id: "tool", event: "post", kind: "reply", text: "`Run datum`", ts: "2026-10-21T11:59:00Z" },
        { id: "answer", event: "post", kind: "reply", text: "Datum är den 21 oktober.", ts: "2026-10-21T11:00:00Z" },
        { id: "human", event: "ask", source: "discord", verbatim: "Vilket datum gäller?", ts: "2026-10-20T11:00:00Z" },
      ].map(row => ({ ...row, agent: "ai", pane: 3, ledgerPath: "/log/ask-ledger.jsonl" }));
      const hits = rankConversationHits(rows.map(row => conversationHit(row, { words: ["datum"], query: "datum", nowMs })), 12);
      return { hits, text: formatHits(hits) };
    }],
    then: ["original sources lead without deleting the tool post", ({ hits, text }) => {
      expect(hits.map(hit => hit.conversationId)).toEqual(["human", "answer", "tool"]);
      expect(text).toContain("han");
      expect(text).toContain("ai:3 svarade");
    }],
  });
});

feature("search includes exact posted conversation, not only the event ledger", () => {
  for (const raw of [true, false]) component(`a phrase posted only to Discord is source-bound without neural readers, raw=${raw}`, {
    given: ["a canonical post that never appeared in memory or a provider journal", () => {
      const root = mkdtempSync(join(tmpdir(), "search-conversation-")), path = join(root, "ledger.jsonl");
      const previous = process.env.AMUX_ASK_LEDGER_PATH;
      process.env.AMUX_ASK_LEDGER_PATH = path;
      const row = appendPost({ agent: "api", pane: 2, channelId: "channel", via: "bridge", kind: "reply", messageId: "real-message",
        payload: "Hirohiko som tecknar Jojo, ett exakt åäö-citat.", ts: Date.now() - 60000 }, { path });
      return { root, path, previous, row };
    }],
    // A cold answer leaves the log out unless it is asked for by name (docs/DESIGN-search-daemon.md, chapter 6), so the
    // phrase is searched with --source conversation, which is also how the log is documented to be searched alone.
    when: ["searching the actual CLI collector without note or journal roots", fx => collectSearchHits("Hirohiko som tecknar Jojo", [], fx.root, { raw, lexical: true, source: "conversation" }, {
      semantic: { passages: () => { throw Error("No note roots, no neural or passage reader needed"); } },
    })],
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
