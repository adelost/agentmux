// WHAT: Exercises normal Dream with file care on the existing transport seam.
// WHY: Digest acceptance must survive failed care without losing concurrent memory writes.
import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cmdDream } from "../cli/dream.mjs";
import { writeDreamOwnerInput, readDreamOwnerResult } from "../core/dream-owner.mjs";
import { buildClaudeLaunchCommand } from "../core/agent-launch-command.mjs";

const roots = [], saved = { HOME: process.env.HOME, AMUX_JANITOR_ENABLED: process.env.AMUX_JANITOR_ENABLED, AMUX_DREAM_SOURCE: process.env.AMUX_DREAM_SOURCE };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
const prefix = "> summary: Local memory\n> why: Preserve source facts\n\n";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dream-care-runtime-")); roots.push(root);
  process.env.HOME = root; process.env.AMUX_JANITOR_ENABLED = "false"; process.env.AMUX_DREAM_SOURCE = "conversation-log";
  const workspace = join(root, "source"), paneDir = join(root, "pane");
  mkdirSync(join(workspace, "memory/references"), { recursive: true }); mkdirSync(paneDir);
  writeFileSync(join(workspace, "MEMORY.md"), prefix + "# Memory\n");
  writeFileSync(join(workspace, "memory/references/source.md"), prefix + "# Source\n\n- Stable technical fact.\n");
  const owner = { agent: "dream", pane: 0, engine: "claude", paneDir };
  const fx = { root, workspace, owner, document: null, input: null, sends: 0 };
  fx.deps = { owner, agents: [], now: new Date("2026-10-24T16:13:28Z"),
    runtimeConfig: {}, receiptPath: join(root, "receipts.json"), readReceipts: () => ({ schemaVersion: 1, panes: {} }),
    memoryCare: { root: join(root, "care"), reference: "memory/references/source.md" }, verifyCareRuntime: async () => true,
    collectSources: () => ({ sources: [{ agent: "source", pane: 0, engine: "claude", turns: 1,
      activityCursor: "2026-10-24T16:00:00Z", entries: [{ timestamp: "2026-10-24T16:00:00Z", userPrompt: "Ship the assigned fix", items: [{ type: "text", content: "Delivered with evidence." }] }] }], unreadable: [], skipped: [] }),
    getStatus: async () => "idle", getContext: () => ({ model: "claude-opus-5-5", effort: "max" }),
    compactClaude: async () => ({ ok: true, sessionId: "native-session", compactBoundary: true }),
    getProof: async () => ({ sessionId: "native-session" }), mirrorPrompt: async () => ({}),
    notifyUser: async () => ({ sent: false, outcome: "not-sent" }), nightlyCompact: async () => {}, recordReceipts: () => {},
    writeInput: doc => { fx.document = doc; fx.input = writeDreamOwnerInput(doc, { rootDir: join(root, "input") }); return fx.input; },
    send: async () => { fx.sends++; return { delivered: true }; },
  };
  fx.run = () => cmdDream({ configPath: "unused", agent: { ensureReady: async () => {} } }, { workspace, quiet: true, deferSentinel: true }, fx.deps);
  return fx;
}

for (const failCare of [false, true]) it(`normal conversation-log Dream preserves digest with care failure=${failCare}`, async () => {
  const fx = fixture();
  fx.deps.waitForResult = async ({ outputPath, dateKey, runId, sourceSha256 }) => {
    expect(fx.document.memoryCare).toBeDefined();
    const care = fx.document.memoryCare;
    expect(outputPath.startsWith(join(fx.root, "care"))).toBe(true);
    const file = `memory/references/care-${dateKey}.md`;
    writeFileSync(join(care.worktree, file), prefix + "# Current technical knowledge\n\n- Stable technical fact.\n" + (failCare ? "\n`memory/references/missing.md`\n" : ""));
    appendFileSync(join(care.worktree, "MEMORY.md"), `\n- Current technical knowledge: \`${file}\`\n`);
    appendFileSync(join(fx.workspace, "MEMORY.md"), "\n- Another owner's concurrent fact.\n");
    writeFileSync(join(fx.workspace, "memory/references/other.md"), prefix + "Other owner's reference.\n");
    writeFileSync(outputPath, `> Kuraterad av dream:0 efter verifierad kompaktering · run \`${runId}\` · source \`${sourceSha256}\`.\n- The assigned fix was delivered.\n`);
    return readDreamOwnerResult(outputPath, dateKey, runId, fx.owner, sourceSha256);
  };
  const result = await fx.run();
  expect(fx.sends).toBe(1);
  expect(readFileSync(result.path, "utf8")).toContain("amux-dream-summary:2026-10-24");
  expect(readFileSync(join(fx.workspace, "MEMORY.md"), "utf8")).toContain("Another owner's concurrent fact.");
  expect(existsSync(join(fx.workspace, "memory/references/care-2026-10-24.md"))).toBe(!failCare);
  expect(result.memoryCare.state).toBe(failCare ? "refused" : "published");
  expect(readFileSync(fx.input.outputPath, "utf8")).toContain("The assigned fix was delivered.");
});

it("a fixed native policy replaces bypass only in its declared curator workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "dream-static-policy-")); roots.push(root);
  writeFileSync(join(root, ".amux-native-policy.json"), JSON.stringify({ version: 1, engine: "claude", root, settingsPath: join(root, "policy.json"), settingsSha256: createHash("sha256").update("{}").digest("hex") }));
  writeFileSync(join(root, "policy.json"), "{}");
  const scoped = buildClaudeLaunchCommand({ cwd: root });
  expect(scoped).not.toContain("--dangerously-skip-permissions");
  expect(scoped).toContain("--permission-mode dontAsk");
  expect(scoped).toContain("--settings");
  expect(buildClaudeLaunchCommand()).toContain("--dangerously-skip-permissions");
});
