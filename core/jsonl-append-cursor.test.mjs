import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature, unit } from "bdd-vitest";
import {
  captureJsonlAppendCursor,
  hasJsonlEventAfterCursor,
} from "./jsonl-append-cursor.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentmux-jsonl-cursor-"));
  const file = join(root, "session.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "before" })}\n`);
  return { root, file, cursor: captureJsonlAppendCursor("test", [file]) };
}

feature("streaming JSONL append cursor", () => {
  unit("skips an oversized irrelevant record and finds a later receipt", {
    given: ["a cursor followed by one bounded-oversize line", () => fixture()],
    when: ["scanning in tiny chunks", (ctx) => {
      appendFileSync(ctx.file, `${JSON.stringify({ type: "tool", blob: "x".repeat(512) })}\n`);
      appendFileSync(ctx.file, `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "needle" } })}\n`);
      return hasJsonlEventAfterCursor([ctx.file], ctx.cursor,
        (event) => event?.payload?.message === "needle",
        { chunkBytes: 31, maxEventBytes: 128 });
    }],
    then: ["the later event is found without parsing the large line", (found, ctx) => {
      expect(found).toBe(true);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("a receipt beyond the historical 8 MiB ceiling remains visible", {
    given: ["a real-size image/tool line after the cursor", () => fixture()],
    when: ["finding the prompt appended after that line", (ctx) => {
      appendFileSync(ctx.file, `${JSON.stringify({ type: "response_item", blob: "x".repeat(8 * 1024 * 1024 + 64 * 1024) })}\n`);
      appendFileSync(ctx.file, `${JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "delivered after image" },
      })}\n`);
      return hasJsonlEventAfterCursor([ctx.file], ctx.cursor,
        (event) => event?.payload?.message === "delivered after image");
    }],
    then: ["the exact receipt is found", (found, ctx) => {
      expect(found).toBe(true);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
});
