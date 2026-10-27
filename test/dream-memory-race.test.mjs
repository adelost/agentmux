import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDreamOwnerInput } from "../core/dream-owner.mjs";
import { snapshotDreamMemory } from "../core/dream-memory-effects.mjs";
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
  const input = writeDreamOwnerInput({ dateKey, workspace }, { rootDir: join(root, "input") });
  const product = `> Kuraterad av dream:0 efter verifierad kompaktering · run \`${input.runId}\` · source \`${input.sha256}\`.\n- Verified result.\n`;
  writeFileSync(input.outputPath, product);
  return { root, workspace, memory, file, input, owner, dateKey, product };
}

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
