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

function fixture({ legacy = false, memoryFormat, effects = true } = {}) {
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
  const document = { schemaVersion: 1, memoryFormat, dateKey, createdAt: "2026-09-08T00:00:00Z",
    owner: { agent: "example", pane: 0, engine: "codex" }, compact: { ...quality, boundary: true },
    payload: { panes: [
      { pane: "source:2", turns: [{ user: "Fix the current bug", at: "2026-09-07T20:00:00Z" }] },
      { pane: "source:3", turns: [{ user: "/compact Keep under 80000 tokens", at: "2026-09-07T21:00:00Z" }] },
    ] }, omitted: [], unreadable: [],
    ...(!legacy && { workspace, memoryBeforeSha256: hash(memoryBefore), ...(effects && { memoryGuard: { effects: true, paneDirs: [join(workspace, ".agents", "0")] } }) }) };
  const input = writeDreamOwnerInput(document);
  const output = `> Kuraterad av example:0 efter verifierad kompaktering · run \`${input.runId}\` · source \`${input.sha256}\`.\n- Verified work.\n`;
  writeFileSync(input.outputPath, output);
  const ctx = { configPath, agent: {
    isBusy: vi.fn(async () => false),
    getResponseStreamWithRaw: vi.fn(async (_a, _p, prompt) => {
      expect(prompt).toContain(input.path); expect(prompt).toContain(input.sha256);
      if (memoryFormat === 2) expect(prompt).toContain("Följ även dagsfilernas relevanta Dream-länkar");
      else expect(prompt).not.toContain("Följ även dagsfilernas relevanta Dream-länkar");
      return { source: "codex-jsonl", items: [
        { type: "text", content: "Working commentary" },
        { type: "text", content: `DREAM_OK ${dateKey} ${input.runId}` },
      ] };
    }),
    ensureReady: vi.fn(() => { throw new Error("must not start a pane"); }),
    send: vi.fn(() => { throw new Error("must not prompt a model"); }),
  } };
  const flags = { recover: input.path, "source-sha256": input.sha256, workspace };
  const commit = vi.fn(commitDreamProduct), getProof = vi.fn(async () => ({ sessionId: quality.sessionId, ownerTexts: [] }));
  return { root, memPath, memoryBefore, input, output, flags, ctx, quality, commit, getProof,
    run: extra => recoverDreamRun(ctx, { ...flags, ...extra }, { commit, getProof }) };
}

describe("no-model Dream completion", () => {
  it("imports an explicitly selected old result as visibly unattested history without changing original failures or cursors", async () => {
    const fx = fixture({ effects: false });
    const original = `${fx.memoryBefore}<!-- amux-dream-failed:2026-09-08 04:00 original-failure -->\n`;
    writeFileSync(fx.memPath, original);
    fx.getProof.mockResolvedValue({ sessionId: fx.quality.sessionId, ownerTexts: [], terminal: { at: "2026-09-08T02:05:00Z", line: 10 } });
    expect(await fx.run({ "import-historical": true, dry: true })).toMatchObject({ dryRun: true, originalEffects: "unattested" });
    expect(readFileSync(fx.memPath, "utf8")).toBe(original);
    const result = await fx.run({ "import-historical": true });
    expect(result).toMatchObject({ historicalImported: true, originalStatusPreserved: true, receiptsAdvanced: false });
    const day = readFileSync(fx.memPath, "utf8"), audit = readFileSync(result.audit, "utf8");
    expect(day.startsWith(original)).toBe(true);
    expect(day).toContain("effektattest saknas"); expect(day).not.toContain("amux-dream-summary:");
    expect(readFileSync(result.artifact, "utf8")).toContain("Verified work.");
    expect(JSON.parse(audit)).toMatchObject({ originalEffects: "unattested", phase: "committed", receiptsAdvanced: false });
    expect(await fx.run({ "import-historical": true })).toMatchObject({ alreadyImported: true });
    expect(readFileSync(fx.memPath, "utf8")).toBe(day); expect(readFileSync(result.audit, "utf8")).toBe(audit);
    expect(readDreamReceipts().panes).toEqual({}); expect(fx.commit).not.toHaveBeenCalled();
    expect(fx.ctx.agent.send).not.toHaveBeenCalled(); expect(fx.ctx.agent.ensureReady).not.toHaveBeenCalled();
    writeFileSync(fx.memPath, original);
    await expect(fx.run({ "import-historical": true })).rejects.toThrow("reference-removed");
  });

  it("refuses changes during historical qualification instead of converting them into old effect proof", async () => {
    const fx = fixture({ effects: false });
    fx.getProof.mockImplementation(async () => {
      writeFileSync(fx.memPath, fx.memoryBefore + "Concurrent memory change.\n");
      return { sessionId: fx.quality.sessionId, terminal: { at: "2026-09-08T02:05:00Z" } };
    });
    await expect(fx.run({ "import-historical": true })).rejects.toThrow("dream-historical-memory-changed");
    expect(fx.commit).not.toHaveBeenCalled(); expect(readDreamReceipts().panes).toEqual({});
  });
  it("does not manufacture a missing historical effect snapshot for an old result", async () => {
    const fx = fixture({ effects: false });
    await expect(fx.run({ dry: true })).rejects.toThrow("dream-memory-effects-unattested");
    expect(fx.commit).not.toHaveBeenCalled();
    expect(readFileSync(fx.memPath, "utf8")).toBe(fx.memoryBefore);
    expect(fx.ctx.agent.send).not.toHaveBeenCalled();
  });
  it("refuses an uncommitted memory effect instead of accepting a concurrent writer", async () => {
    const fx = fixture({ memoryFormat: 2 });
    const changed = fx.memoryBefore + "A newer note.\n";
    writeFileSync(fx.memPath, changed);
    await expect(fx.run({ dry: true })).rejects.toThrow("dream-curator-touched-memory");
    expect(readFileSync(fx.memPath, "utf8")).toBe(changed);
    expect(fx.commit).not.toHaveBeenCalled();
  });
  it("finishes after the daily write, preserving later notes without contacting the curator again", async () => {
    const fx = fixture({ memoryFormat: 2 });
    fx.commit.mockImplementation(options => commitDreamProduct({ ...options,
      recordReceipts: () => { throw new Error("simulated-controller-crash"); } }));
    await expect(fx.run()).rejects.toThrow("simulated-controller-crash");
    const afterBlock = readFileSync(fx.memPath, "utf8");
    expect(afterBlock).toContain(`dream/2026-09-08-${fx.input.runId}.md`);
    expect(readDreamReceipts().panes).toEqual({});
    writeFileSync(fx.memPath, afterBlock + "\nA later decision from another owner.\n");
    fx.getProof.mockClear(); fx.ctx.agent.getResponseStreamWithRaw.mockClear();
    expect(await fx.run({ dry: true })).toMatchObject({ commitReceipt: true, dryRun: true });
    expect(readDreamReceipts().panes).toEqual({});
    expect(await fx.run()).toMatchObject({ recovered: true, commitReceipt: true });
    expect(readFileSync(fx.memPath, "utf8")).toBe(afterBlock + "\nA later decision from another owner.\n");
    expect(Object.keys(readDreamReceipts().panes)).toEqual(["source:2"]);
    expect(fx.getProof).not.toHaveBeenCalled();
    expect(fx.ctx.agent.getResponseStreamWithRaw).not.toHaveBeenCalled();
  });
  it("can repeat post-cursor recovery idempotently before the sentinel is written", async () => {
    const fx = fixture({ memoryFormat: 2 });
    await fx.run();
    const receipts = readFileSync(defaultDreamReceiptPath(), "utf8");
    const memory = readFileSync(fx.memPath, "utf8");
    expect(await fx.run()).toMatchObject({ commitReceipt: true, recovered: true });
    expect(readFileSync(defaultDreamReceiptPath(), "utf8")).toBe(receipts);
    expect(readFileSync(fx.memPath, "utf8")).toBe(memory);
  });
  it("refuses a changed committed block or product even with the durable intent present", async () => {
    const fx = fixture({ memoryFormat: 2 }); await fx.run();
    const memory = readFileSync(fx.memPath, "utf8");
    writeFileSync(fx.memPath, memory.replace("Nightly fleet summary", "Edited summary"));
    await expect(fx.run()).rejects.toThrow("memory-changed");
    writeFileSync(fx.memPath, memory);
    writeFileSync(fx.input.outputPath, fx.output.replace("Verified work", "A different claim"));
    await expect(fx.run()).rejects.toThrow("intent-invalid");
  });
  it.each([undefined, 2])("previews and commits format %s using the original prompt and only real-work cursors", async (memoryFormat) => {
    const fx = fixture({ memoryFormat });
    expect(await fx.run({ dry: true })).toMatchObject({ dryRun: true, included: 2, receipts: 1 });
    expect(fx.commit).not.toHaveBeenCalled();
    expect(readFileSync(fx.memPath, "utf8")).toBe(fx.memoryBefore);
    expect(await fx.run()).toMatchObject({ recovered: true, included: 2, receipts: 1 });
    expect(readFileSync(fx.memPath, "utf8")).toContain(fx.memoryBefore.trim());
    const snapshot = join(fx.root, "workspace", "memory", "dream", `2026-09-08-${fx.input.runId}.md`);
    expect(readFileSync(snapshot, "utf8")).toContain(fx.output.trim());
    expect(readFileSync(fx.memPath, "utf8")).toContain(`dream/2026-09-08-${fx.input.runId}.md`);
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
  it("rejects proof from a different original session without advancing cursors", async () => {
    const fx = fixture();
    fx.getProof.mockResolvedValue({ sessionId: "replacement", ownerTexts: [] });
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
