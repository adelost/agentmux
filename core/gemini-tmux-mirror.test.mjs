import { component, expect, feature } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGeminiTmuxMirror } from "./gemini-tmux-mirror.mjs";

feature("minimal Gemini screen reply projection", () => {
  component("a completed screen reply posts once, including across a watcher restart", {
    given: ["an intake journal and a screen-only reply boundary", () => {
      const home = mkdtempSync(join(tmpdir(), "amux-gemini-mirror-"));
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const chats = join(home, ".gemini", "tmp", "fixture", "chats"); mkdirSync(chats, { recursive: true });
      writeFileSync(join(chats, "session-2026-10-27T19-00-11111111.jsonl"), [
        { sessionId, kind: "main" }, { id: "user-1", type: "user", content: [{ text: "hello" }], timestamp: "2026-10-27T19:00:00Z" },
        { type: "gemini", content: "THIS JOURNAL ANSWER MUST NOT BE USED" },
      ].map(JSON.stringify).join("\n") + "\n");
      const values = new Map(), posts = [];
      const state = { get: (key, fallback) => values.get(key) ?? fallback, set: (key, value) => values.set(key, value) };
      let busy = true;
      const options = { home, state, agent: { isBusy: async () => busy,
        getResponseStreamWithRaw: async () => ({ items: [{ type: "text", content: "SCREEN ANSWER" }], source: "tmux" }) },
      post: async value => { posts.push(value); return { ok: true }; } };
      return { home, options, posts, request: { name: "demo", idx: 0, channelId: "channel", sessionId }, idle: () => { busy = false; } };
    }], when: ["polling during work, after completion and after a bridge restart", async ctx => {
      const first = createGeminiTmuxMirror(ctx.options);
      await first.poll(ctx.request); ctx.idle(); await first.poll(ctx.request); await first.poll(ctx.request);
      await createGeminiTmuxMirror(ctx.options).poll(ctx.request);
      return ctx.posts;
    }], then: ["only the completed tmux answer was sent", posts => {
      expect(posts).toHaveLength(1); expect(posts[0].turn.items).toEqual([{ type: "text", content: "SCREEN ANSWER" }]);
    }], cleanup: ctx => rmSync(ctx.home, { recursive: true, force: true }),
  });
});
