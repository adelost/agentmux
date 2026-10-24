import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDreamOwnerInput, readDreamOwnerResult } from "../core/dream-owner.mjs";
import { snapshotDreamMemory, verifyDreamMemoryEffects } from "../core/dream-memory-effects.mjs";
import { notifyDreamFailure } from "../core/dream-failure-notice.mjs";
import { writeDreamAtomic } from "../core/dream-commit.mjs";
import { cmdDream } from "../cli/dream.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dream-effect-guard-")); roots.push(root);
  const workspace = join(root, "workspace"), memory = join(workspace, "memory");
  mkdirSync(memory, { recursive: true });
  const file = join(memory, "fact.md"); writeFileSync(file, "Existing fact.\n");
  const owner = { agent: "dream", pane: 0 }, dateKey = "2026-10-24";
  const input = writeDreamOwnerInput({ dateKey, workspace, memoryGuard: { effects: true } }, { rootDir: join(root, "input") });
  const document = JSON.parse(readFileSync(input.path));
  const product = `> Kuraterad av dream:0 efter verifierad kompaktering · run \`${input.runId}\` · source \`${input.sha256}\`.\n- Verified result.\n`;
  writeFileSync(input.outputPath, product);
  return { root, workspace, memory, file, input, owner, dateKey, product,
    verify: () => verifyDreamMemoryEffects({ inputPath: input.path, inputSha256: input.sha256, descriptor: document.memoryGuard.effects, workspace }) };
}

it("permits only the isolated ordinary result and refuses changed, created and removed memory", () => {
  for (const mutate of [fx => writeFileSync(fx.file, "changed"), fx => writeFileSync(join(fx.memory, "new.md"), "new"), fx => unlinkSync(fx.file),
    fx => { writeFileSync(fx.file, "changed"); writeFileSync(fx.file, "Existing fact.\n"); }]) {
    const fx = fixture(); expect(fx.verify().files).toBeGreaterThan(0);
    mutate(fx); expect(fx.verify).toThrow("dream-curator-touched-memory");
  }
});

it("refuses writes to private memory and controller repair receipts outside the day file", () => {
  const fx = fixture();
  writeFileSync(fx.input.outputPath.replace(".summary.md", ".memory-repair.json"), "{}");
  expect(fx.verify).toThrow("dream-curator-touched-memory");
  const second = fixture();
  mkdirSync(join(second.workspace, ".agents", "7", "memory"), { recursive: true });
  expect(second.verify).toThrow("dream-memory-scope-changed");
});

it("protects existing private memory and missing memory indexes", () => {
  const fx = fixture(), privateMemory = join(fx.workspace, ".agents", "5", "memory");
  mkdirSync(privateMemory, { recursive: true }); writeFileSync(join(privateMemory, "fact.md"), "fact");
  const input = writeDreamOwnerInput({ dateKey: fx.dateKey, workspace: fx.workspace, memoryGuard: { effects: true } }, { rootDir: join(fx.root, "second-input") });
  writeFileSync(input.outputPath, "result");
  const descriptor = JSON.parse(readFileSync(input.path)).memoryGuard.effects;
  const verify = () => verifyDreamMemoryEffects({ inputPath: input.path, inputSha256: input.sha256, descriptor, workspace: fx.workspace });
  expect(verify()).toBeTruthy(); writeFileSync(join(privateMemory, "fact.md"), "changed"); expect(verify).toThrow("touched-memory");
  writeFileSync(join(fx.workspace, "MEMORY.md"), "New index"); expect(fx.verify).toThrow();
});

it("does not let links, hardlinked results, or a reduced manifest open a write path", () => {
  const fx = fixture();
  unlinkSync(fx.input.outputPath); symlinkSync(fx.file, fx.input.outputPath);
  expect(fx.verify).toThrow();
  expect(readDreamOwnerResult(fx.input.outputPath, fx.dateKey, fx.input.runId, fx.owner, fx.input.sha256).ok).toBe(false);
  unlinkSync(fx.input.outputPath); linkSync(fx.file, fx.input.outputPath); expect(fx.verify).toThrow();
  const linked = fixture(); symlinkSync(join(linked.root, "input"), join(linked.memory, "escape")); expect(linked.verify).toThrow("link-outside-scope");
  const reduced = fixture(); unlinkSync(reduced.input.path.replace(".json", ".memory-before.json")); writeFileSync(reduced.input.path.replace(".json", ".memory-before.json"), JSON.stringify({ version: 1, roots: [], entries: {} }));
  expect(reduced.verify).toThrow("manifest-changed");
});

it("allows a stable memory alias only inside the protected scope", () => {
  const fx = fixture(); symlinkSync(fx.file, join(fx.memory, "alias.md"));
  const before = snapshotDreamMemory([fx.memory]);
  expect(before.entries[join(fx.memory, "alias.md")].kind).toBe("link");
  expect(snapshotDreamMemory([fx.memory])).toEqual(before);
});

it("refuses a linked controller destination before touching its target", () => {
  const fx = fixture(), alias = join(fx.root, "linked-memory");
  symlinkSync(fx.memory, alias);
  expect(() => writeDreamAtomic(join(alias, "fact.md"), "changed")).toThrow("dream-controller-path-not-isolated");
  expect(readFileSync(fx.file, "utf8")).toBe("Existing fact.\n");
});

it("notifies once even for a failure before curator setup", async () => {
  const fx = fixture(), previousHome = process.env.HOME; let calls = 0;
  process.env.HOME = fx.root;
  try {
    const deps = { notifyUser: async () => { calls++; return { sent: true, messageId: "failure-notice" }; } };
    await expect(cmdDream({}, { since: "invalid" }, deps)).rejects.toThrow("invalid --since");
    await expect(cmdDream({}, { since: "invalid" }, deps)).rejects.toThrow("invalid --since");
    expect(calls).toBe(1);
  } finally { process.env.HOME = previousHome; }
});

it("sends one durable human failure notice and preserves a lost response as unknown", async () => {
  for (const losesResponse of [false, true]) {
    const fx = fixture(); let calls = 0;
    const notify = async (_text, options) => { calls++; expect(options.strictSingleAttempt).toBe(true); if (losesResponse) throw Error("lost response"); return { sent: true, messageId: "human-receipt" }; };
    const options = { dateKey: fx.dateKey, reason: "curator failed", notify, home: fx.root };
    const first = await notifyDreamFailure(options), second = await notifyDreamFailure(options);
    expect(first.outcome).toBe(losesResponse ? "unknown" : "sent"); expect(second).toEqual(first); expect(calls).toBe(1);
  }
});
