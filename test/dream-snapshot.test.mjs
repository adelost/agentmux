import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitDreamProduct } from "../cli/dream.mjs";
import { readDreamSuccess } from "../core/dream-health.mjs";

const roots = [], dateKey = "2026-09-05", runId = "41310b1d-8a21-4e8c-8a57-196ecc5a2cf5";
const now = new Date("2026-09-05T04:30:00Z");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dream-snapshot-")); roots.push(home);
  const workspace = join(home, "workspace"), memPath = join(workspace, "memory", `${dateKey}.md`);
  const base = join(home, ".agentmux", "dream-input", `${dateKey}-${runId}`);
  mkdirSync(join(workspace, "memory"), { recursive: true }); mkdirSync(join(home, ".agentmux", "dream-input"), { recursive: true });
  const input = JSON.stringify({ dateKey, createdAt: "2026-09-05T02:10:00Z", owner: { agent: "fake", pane: 0 } });
  const sha = createHash("sha256").update(input).digest("hex");
  const content = `> Kuraterad av fake:0 efter verifierad kompaktering · run \`${runId}\` · source \`${sha}\`.\n- Original nattlig sammanfattning.`;
  writeFileSync(`${base}.json`, input); writeFileSync(`${base}.summary.md`, content);
  const memoryBefore = `# ${dateKey}\n<!-- amux-dream-run:${dateKey} 04:10 (1 panes ok / 0 failed) -->\n\nMin egen anteckning.\n`;
  writeFileSync(memPath, memoryBefore);
  const recordReceipts = vi.fn();
  const commit = () => commitDreamProduct({ memPath, memoryBefore, dateKey,
    product: { content }, included: [{}], omitted: [], receipts: {}, now, recordReceipts });
  return { home, workspace, memPath, memoryBefore, content, commit, recordReceipts,
    snapshot: join(workspace, "memory", "dream", `${dateKey}-${runId}.md`),
    health: () => readDreamSuccess(workspace, dateKey, { home, now }) };
}
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

describe("separate verified Dream snapshot and editable daily notes", () => {
  it("keeps the verified result unchanged when later daily notes are added", () => {
    const fx = fixture(); fx.commit();
    const daily = readFileSync(fx.memPath, "utf8");
    expect(daily).not.toContain("Original nattlig sammanfattning");
    expect(daily).toContain(`dream/${dateKey}-${runId}.md`);
    expect(daily).toContain("Min egen anteckning.");
    expect(readFileSync(fx.snapshot, "utf8")).toContain(fx.content);
    expect(statSync(fx.snapshot).mode & 0o222).toBe(0);
    writeFileSync(fx.memPath, daily + "\n## Senare beslut\nNu är funktionen faktiskt klar.\n");
    expect(fx.health()).toMatchObject({ ok: true, runId, snapshotPath: fx.snapshot });
    expect(fx.recordReceipts).toHaveBeenCalledOnce();
  });
  it("rejects an altered snapshot even when the original artifact and daily reference remain", () => {
    const fx = fixture(); fx.commit();
    chmodSync(fx.snapshot, 0o600); writeFileSync(fx.snapshot, "Unverified replacement");
    expect(fx.health()).toMatchObject({ ok: false, reason: "committed snapshot mismatch" });
  });
  it("does not overwrite an existing different snapshot or advance receipts", () => {
    const fx = fixture(); mkdirSync(join(fx.workspace, "memory", "dream"));
    writeFileSync(fx.snapshot, "Do not erase me");
    expect(fx.commit).toThrow("snapshot already exists with different bytes");
    expect(readFileSync(fx.memPath, "utf8")).toBe(fx.memoryBefore);
    expect(readFileSync(fx.snapshot, "utf8")).toBe("Do not erase me");
    expect(fx.recordReceipts).not.toHaveBeenCalled();
  });
  it("preserves a concurrent manual edit before the controller commit", () => {
    const fx = fixture(); writeFileSync(fx.memPath, fx.memoryBefore + "Ny anteckning\n");
    expect(fx.commit).toThrow("touched-memory");
    expect(fx.recordReceipts).not.toHaveBeenCalled();
  });
});
