import { describe, it, expect, vi } from "vitest";
import { createLiveProgress, toolLinesEnabled } from "./live-progress.mjs";
const setup = () => {
  const values = {}, state = { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } };
  const discord = { send: vi.fn(async () => ({ id: "row-1" })), editMessage: vi.fn(async () => {}), deleteMessage: vi.fn(async () => {}) };
  return { state, discord, progress: createLiveProgress({ state, discord, env: {} }) };
};
const turn = (items, isComplete = false) => ({ timestamp: "2026-10-17T07:00:00Z", isComplete, items });
const tool = id => ({ id, type: "tool", content: "Read /tmp/cut.ts" });
describe("a single live progress row", () => {
  it("deduplicates steps, survives restart and deletes its own row at completion", async () => {
    const f = setup(), args = { channelId: "ch", paneKey: "test:0" };
    await f.progress.update({ ...args, turn: turn([tool("1")]) });
    const next = createLiveProgress({ state: f.state, discord: f.discord, env: {} });
    await next.update({ ...args, turn: turn([tool("1"), tool("2")]) });
    await next.finish("ch");
    expect(f.discord.send).toHaveBeenCalledTimes(1);
    expect(f.discord.editMessage).toHaveBeenCalledWith("ch", "row-1", "Arbetar · 2 steg · senast: läser cut.ts");
    expect(f.discord.deleteMessage).toHaveBeenCalledWith("ch", "row-1");
  });
  it("a failed edit does not create another post and is retried", async () => {
    const f = setup(), args = { channelId: "ch", paneKey: "test:0" };
    await f.progress.update({ ...args, turn: turn([tool("1")]) });
    f.discord.editMessage.mockRejectedValueOnce(Error("offline"));
    await expect(f.progress.update({ ...args, turn: turn([tool("2")]) })).rejects.toThrow("offline");
    await f.progress.update({ ...args, turn: turn([tool("2")]) });
    expect(f.discord.send).toHaveBeenCalledTimes(1); expect(f.discord.editMessage).toHaveBeenCalledTimes(2);
  });
  it("per-channel rollback restores the old items without a second row", async () => {
    const f = setup(), env = { AMUX_TOOL_LINES_CHANNELS: "other:0,test:0" };
    expect(toolLinesEnabled("ch", "test:0", env)).toBe(true);
    const p = createLiveProgress({ state: f.state, discord: f.discord, env });
    const original = turn([tool("1")]);
    expect(await p.update({ channelId: "ch", paneKey: "test:0", turn: original })).toEqual(original);
    expect(f.discord.send).not.toHaveBeenCalled();
  });
});

describe("a truncated live journal", () => {
  it("reuses the row when the original prompt has left the bounded tail", async () => {
    const f = setup(), args = { channelId: "ch", paneKey: "test:0" };
    await f.progress.update({ ...args, turn: turn([tool("1")]) });
    const headless = { ...turn([tool("2")]), timestamp: "2026-10-17T07:30:00Z", headless: true };
    await f.progress.reconcile("ch", [headless]); await f.progress.update({ ...args, turn: headless });
    expect(f.discord.send).toHaveBeenCalledTimes(1); expect(f.discord.deleteMessage).not.toHaveBeenCalled();
  });
});
