import { describe, it, expect, vi } from "vitest";
import { createLiveProgress, toolLinesEnabled } from "./live-progress.mjs";
import { describeToolCall } from "../core/tool-display.mjs";
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
    expect(f.discord.editMessage).toHaveBeenCalledWith("ch", "row-1", "Working · 2 steps · last: reading cut.ts");
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

// Row 100: the files a turn changed ride on the footer posted after its answer. Steps come from the real producer so the labels match what the watchers feed in.
const step = (id, name, input) => ({ id, type: "tool", ...describeToolCall(name, input) });
const edit = (id, path) => step(id, "Edit", { file_path: path });
const args = { channelId: "ch", paneKey: "test:0" };

describe("the files a turn changed, for the footer after its answer", () => {
  it("names the base names of its Edit and Write steps once each, the last steps of the turn included, and hands them over once", async () => {
    const f = setup(), steps = [tool("1"), edit("2", "/repo/channels/live-progress.mjs"), step("3", "Write", { file_path: "/repo/docs/TASKS.md" })];
    await f.progress.update({ ...args, turn: turn(steps) });
    await f.progress.update({ ...args, turn: turn([...steps, edit("4", "/other/live-progress.mjs"), edit("5", "/repo/docs/TASKS.md"), edit("6", "/repo/cut.ts")], true) });
    expect(f.progress.takeChanged("ch")).toBe("live-progress.mjs, TASKS.md, cut.ts");
    expect(f.progress.takeChanged("ch")).toBe("");
    expect(f.discord.deleteMessage).toHaveBeenCalledWith("ch", "row-1");
  });
  it("names the files of one multi-file patch and counts the ones its label leaves out", async () => {
    const f = setup(), patch = step("2", "apply_patch", { patchPaths: "abcdefg".split("").map(name => `/repo/${name}.mjs`) });
    await f.progress.update({ ...args, turn: turn([tool("1"), patch], true) });
    expect(f.progress.takeChanged("ch")).toBe("a.mjs, b.mjs, c.mjs, d.mjs, e.mjs +2");
  });
  it("cuts a long list at about 100 characters and counts the rest as +K", async () => {
    const f = setup(), names = Array.from({ length: 12 }, (_, i) => `file-number-${i + 1}.mjs`);
    await f.progress.update({ ...args, turn: turn(names.map((name, i) => edit(String(i), `/repo/${name}`)), true) });
    const listed = f.progress.takeChanged("ch").match(/^(.*?)(?: \+(\d+))?$/u);
    expect(listed[1].length).toBeLessThanOrEqual(100);
    expect(listed[1].split(", ").length + Number(listed[2])).toBe(12);
    expect(listed[1].startsWith("file-number-1.mjs, file-number-2.mjs")).toBe(true);
  });
  it("is empty for a turn that changed no file, even one that edited through the shell", async () => {
    const f = setup();
    await f.progress.update({ ...args, turn: turn([tool("1"), step("2", "Bash", { command: "sed -i s/a/b/ f.txt" })], true) });
    expect(f.progress.takeChanged("ch")).toBe("");
  });
  it("still has the files when the work row was already finished before the final reply arrives", async () => {
    const f = setup();
    await f.progress.update({ ...args, turn: turn([edit("1", "/repo/a.mjs")]) });
    await f.progress.reconcile("ch", [{ ...turn([]), timestamp: "2026-10-17T09:00:00Z", isComplete: true }]);
    await f.progress.update({ ...args, turn: turn([edit("1", "/repo/a.mjs")], true) });
    expect(f.discord.deleteMessage).toHaveBeenCalledWith("ch", "row-1");
    expect(f.progress.takeChanged("ch")).toBe("a.mjs");
  });
  it("lists a file again when a later turn changes it again", async () => {
    const f = setup(), later = { timestamp: "2026-10-17T08:00:00Z" };
    await f.progress.update({ ...args, turn: turn([edit("1", "/repo/a.mjs")], true) });
    expect(f.progress.takeChanged("ch")).toBe("a.mjs");
    await f.progress.update({ ...args, turn: { ...turn([edit("1", "/repo/a.mjs")], true), ...later } });
    expect(f.progress.takeChanged("ch")).toBe("a.mjs");
  });
  it("lists nothing while the old tool rows are on", async () => {
    const f = setup(), legacy = createLiveProgress({ state: f.state, discord: f.discord, env: { AMUX_TOOL_LINES_CHANNELS: "*" } });
    await legacy.update({ ...args, turn: turn([edit("1", "/repo/a.mjs")], true) });
    expect(legacy.takeChanged("ch")).toBe("");
  });
});
