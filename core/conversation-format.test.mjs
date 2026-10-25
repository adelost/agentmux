import { feature, unit, expect } from "bdd-vitest";
import { formatConversationGroups } from "./conversation-view.mjs";

feature("bounded conversation reads preserve recent reply evidence", () => {
  unit("a long older input cannot hide the latest sent reply", {
    when: ["formatting the same old-input/new-reply shape as the observed400-group read", () => formatConversationGroups([
      [{ event: "ask", id: "old", ts: "2026-10-24T14:53:44Z", agent: "test", pane: 0, source: "discord", verbatim: "Older input. ".repeat(2000) }],
      [{ event: "post", id: "latest", ts: "2026-10-25T12:40:30Z", agent: "test", pane: 0, kind: "reply", status: "sent", text: "The actual recent answer.", messageId: "actual-message" }],
    ], { maxBytes: 1024 })],
    then: ["the real latest reply, timestamp and delivery identity remain visible", text => {
      expect(text).toContain("OUT reply sent 2026-10-25T12:40:30Z");
      expect(text).toContain("The actual recent answer."); expect(text).toContain("Discord=actual-message");
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024); expect(text).toContain("truncated");
    }],
  });
});
