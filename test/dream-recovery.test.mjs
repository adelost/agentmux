import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { recoverDreamRun } from "../core/dream-recovery.mjs";
import { writeDreamOwnerInput } from "../core/dream-owner.mjs";
import { defaultDreamReceiptPath, readDreamReceipts } from "../core/dream-eligibility.mjs";
import { commitDreamProduct } from "../cli/dream.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const roots = [], oldHome = process.env.HOME;
afterEach(() => { process.env.HOME = oldHome; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dream-recovery-"));
  roots.push(root); process.env.HOME = root;
  const workspace = join(root, "workspace"), dateKey = "2026-09-08";
  const memPath = join(workspace, "memory", `${dateKey}.md`);
  mkdirSync(join(workspace, "memory"), { recursive: true });
  const memoryBefore = `# ${dateKey}\n\nManual note, preserve exactly.\n`;
  writeFileSync(memPath, memoryBefore);
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, JSON.stringify({ dream: { agent: "example", pane: 0 },
    example: { dir: workspace, panes: [{ engine: "codex" }] } }));
  const quality = { sessionId: "exact-session", model: "gpt-6-astra", effort: "xhigh" };
  const document = { schemaVersion: 1, dateKey, createdAt: "2026-09-08T00:00:00Z",
    owner: { agent: "example", pane: 0, engine: "codex" }, compact: { ...quality, boundary: true },
    payload: { panes: [
      { pane: "source:2", turns: [{ user: "Fix the current bug", at: "2026-09-07T20:00:00Z" }] },
      { pane: "source:3", turns: [{ user: "/compact Keep under 80000 tokens", at: "2026-09-07T21:00:00Z" }] },
    ] }, omitted: [], unreadable: [],
    ...(!legacy && { workspace, memoryBeforeSha256: hash(memoryBefore) }) };
  const input = writeDreamOwnerInput(document);
  const output = `> Kuraterad av example:0 efter verifierad kompaktering · run \`${input.runId}\` · source \`${input.sha256}\`.\n- Verified work.\n`;
  writeFileSync(input.outputPath, output);
  const ctx = { configPath, agent: {
    isBusy: vi.fn(async () => false),
    getResponseStreamWithRaw: vi.fn(async (_a, _p, prompt) => {
      expect(prompt).toContain(input.path); expect(prompt).toContain(input.sha256);
      return { source: "codex-jsonl", items: [
        { type: "text", content: "Working commentary" },
        { type: "text", content: `DREAM_OK ${dateKey} ${input.runId}` },
      ] };
    }),
    ensureReady: vi.fn(() => { throw new Error("must not start a pane"); }),
    send: vi.fn(() => { throw new Error("must not prompt a model"); }),
  } };
  const flags = { recover: input.path, "source-sha256": input.sha256, workspace };
  const commit = vi.fn(commitDreamProduct), getQuality = vi.fn(async () => quality);
  return { root, memPath, memoryBefore, input, output, flags, ctx, quality, commit, getQuality,
    run: extra => recoverDreamRun(ctx, { ...flags, ...extra }, { commit, getQuality }) };
}

describe("no-model Dream completion", () => {
  it("previews without writes, then commits the same product before only real-work cursors", async () => {
    const fx = fixture();
    expect(await fx.run({ dry: true })).toMatchObject({ dryRun: true, included: 2, receipts: 1 });
    expect(fx.commit).not.toHaveBeenCalled();
    expect(readFileSync(fx.memPath, "utf8")).toBe(fx.memoryBefore);
    expect(await fx.run()).toMatchObject({ recovered: true, included: 2, receipts: 1 });
    expect(readFileSync(fx.memPath, "utf8")).toContain(fx.memoryBefore.trim());
    expect(readFileSync(fx.memPath, "utf8")).toContain(fx.output.trim());
    expect(Object.keys(readDreamReceipts().panes)).toEqual(["source:2"]);
    expect(hash(readFileSync(fx.input.path))).toBe(fx.input.sha256);
    expect(readFileSync(fx.input.outputPath, "utf8")).toBe(fx.output);
    expect(fx.ctx.agent.ensureReady).not.toHaveBeenCalled(); expect(fx.ctx.agent.send).not.toHaveBeenCalled();
  });
  it("rejects a different source, changed daily memory and an old packet without its original preimage", async () => {
    const fx = fixture({ legacy: true });
    await expect(fx.run({ "source-sha256": "0".repeat(64) })).rejects.toThrow("source-hash-mismatch");
    await expect(fx.run()).rejects.toThrow("pre-run-memory-hash-required");
    writeFileSync(fx.memPath, fx.memoryBefore + "New human note\n");
    await expect(fx.run({ "memory-sha256": hash(fx.memoryBefore) })).rejects.toThrow("memory-changed");
    expect(fx.commit).not.toHaveBeenCalled();
  });
  it("rejects a session change during verification without advancing cursors", async () => {
    const fx = fixture();
    fx.getQuality.mockResolvedValueOnce(fx.quality).mockResolvedValueOnce({ ...fx.quality, sessionId: "replacement" });
    await expect(fx.run()).rejects.toThrow("session-quality-mismatch");
    expect(readFileSync(fx.memPath, "utf8")).toBe(fx.memoryBefore);
    expect(readDreamReceipts().panes).toEqual({});
  });
  it("does not roll back a newer activity receipt", async () => {
    const fx = fixture();
    writeFileSync(defaultDreamReceiptPath(), JSON.stringify({ schemaVersion: 1, panes: {
      "source:2": { activityCursor: "2026-09-08T01:00:00Z", dreamedAt: "2026-09-08T02:00:00Z" },
    } }));
    await expect(fx.run()).rejects.toThrow("newer-receipt-exists");
    expect(fx.commit).not.toHaveBeenCalled();
  });
});
