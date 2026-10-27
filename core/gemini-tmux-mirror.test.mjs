import { component, expect, feature } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGeminiTmuxMirror } from "./gemini-tmux-mirror.mjs";

feature("minimal Gemini screen reply projection", () => {
  component("a completed screen reply posts once, including across a watcher restart", {
    given: ["agy prompt history and a screen-only reply boundary", () => {
      const home = mkdtempSync(join(tmpdir(), "amux-agy-mirror-"));
      const dir = "/tmp/repo";
      mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
      writeFileSync(join(home, ".gemini", "antigravity-cli", "history.jsonl"), [
        { display: "other pane", timestamp: 2, workspace: "/tmp/other" },
        { display: "hello", timestamp: 1, workspace: dir },
      ].map(JSON.stringify).join("\n") + "\n");
      const values = new Map(), posts = [];
      const state = { get: (key, fallback) => values.get(key) ?? fallback, set: (key, value) => values.set(key, value) };
      let busy = true;
      const options = { home, state, agent: { isBusy: async () => busy,
        getResponseStreamWithRaw: async () => ({ items: [{ type: "text", content: "SCREEN ANSWER" }], source: "tmux" }) },
      post: async value => { posts.push(value); return { ok: true }; } };
      return { home, options, posts, request: { name: "demo", idx: 0, channelId: "channel", dir }, idle: () => { busy = false; } };
    }], when: ["polling during work, after completion and after a bridge restart", async ctx => {
      const first = createGeminiTmuxMirror(ctx.options);
      await first.poll(ctx.request); ctx.idle(); await first.poll(ctx.request); await first.poll(ctx.request);
      await createGeminiTmuxMirror(ctx.options).poll(ctx.request);
      return ctx.posts;
    }], then: ["only the completed tmux answer for this pane's prompt was sent", posts => {
      expect(posts).toHaveLength(1); expect(posts[0].turn.userPrompt).toBe("hello");
      expect(posts[0].turn.items).toEqual([{ type: "text", content: "SCREEN ANSWER" }]);
    }], cleanup: ctx => rmSync(ctx.home, { recursive: true, force: true }),
  });
});
