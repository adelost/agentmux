// WHAT: Exercises normal Dream with file care on the existing transport seam.
// WHY: Digest acceptance must survive failed care without losing concurrent memory writes.
import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { exec, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { cmdDream } from "../cli/dream.mjs";
import { writeDreamOwnerInput, readDreamOwnerResult } from "../core/dream-owner.mjs";
import { buildClaudeLaunchCommand } from "../core/agent-launch-command.mjs";
import { configureDreamCare, runDreamCareCommand } from "../core/dream-care-policy.mjs";
import { createTmuxAdapter } from "../core/tmux.mjs";
import { readClaudeScreenQuality } from "../core/claude-statusline.mjs";
import { prepareDreamCare, freezeDreamCare } from "../core/dream-care-workspace.mjs";
import { publishDreamCare } from "../core/dream-care-publish.mjs";

const roots = [], saved = { HOME: process.env.HOME, AMUX_JANITOR_ENABLED: process.env.AMUX_JANITOR_ENABLED, AMUX_DREAM_SOURCE: process.env.AMUX_DREAM_SOURCE };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }));
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
    appendFileSync(join(fx.workspace, "memory", `${dateKey}.md`), "\n## Another owner's note\n\nPreserve this concurrent note.\n");
    writeFileSync(join(fx.workspace, "memory/references/other.md"), prefix + "Other owner's reference.\n");
    writeFileSync(outputPath, `> Kuraterad av dream:0 efter verifierad kompaktering · run \`${runId}\` · source \`${sourceSha256}\`.\n- The assigned fix was delivered.\n`);
    return readDreamOwnerResult(outputPath, dateKey, runId, fx.owner, sourceSha256);
  };
  const result = await fx.run();
  expect(fx.sends).toBe(1);
  expect(readFileSync(result.path, "utf8")).toContain("amux-dream-summary:2026-10-24");
  expect(readFileSync(result.path, "utf8")).toContain("Preserve this concurrent note.");
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

it("reads the existing statusline fallback's live model and effort before a Dream turn", () => {
  expect(readClaudeScreenQuality("❯\n  Opus 5.5 · 8% · thinking: max\n⏵⏵ don't ask on")).toMatchObject({ model: "Opus 5.5", effort: "max" });
});

it("repeated same setup preserves the fixed policy and refuses widening it", () => {
  const fx = fixture(), options = { root: join(fx.root, "policy"), reference: "memory/references/source.md" };
  const first = configureDreamCare([fx.owner], options);
  expect(configureDreamCare([fx.owner], options)).toEqual(first);
  expect(() => configureDreamCare([fx.owner], { ...options, root: join(fx.root, "wider") })).toThrow("conflict");
  expect(buildClaudeLaunchCommand({ cwd: fx.owner.paneDir })).toContain(first[0].settingsPath);
});

it("restricted native launch preserves empty and JSON argv through real tmux", async () => {
  const fx = fixture(), socket = join(fx.root, "tmux.sock"), output = join(fx.root, "argv.json");
  configureDreamCare([fx.owner], { root: join(fx.root, "policy") });
  const script = join(fx.root, "argv.cjs");
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`);
  execFileSync("tmux", ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "care", "-e", "HISTFILE=/dev/null", "bash --noprofile --norc"]);
  try {
    const tmux = createTmuxAdapter({ socket, exec: promisify(exec) });
    await runDreamCareCommand(tmux, "care:.0", fx.owner.paneDir, `node ${script} --setting-sources '' --mcp-config '{"mcpServers":{}}'`);
    for (let tries = 0; tries < 100 && !existsSync(output); tries++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(["--setting-sources", "", "--mcp-config", '{"mcpServers":{}}']);
  } finally { execFileSync("tmux", ["-S", socket, "kill-server"]); }
});

function publicationFixture() {
  const fx = fixture(), care = prepareDreamCare(fx.workspace, fx.deps.memoryCare);
  const file = "memory/references/care-source.md", suffix = `\n- Current reference: \`${file}\`\n`;
  writeFileSync(join(care.worktree, file), prefix + "# Current reference\n\n- Stable technical fact.\n");
  appendFileSync(join(care.worktree, "MEMORY.md"), suffix);
  const input = writeDreamOwnerInput({ dateKey: "2026-10-24", workspace: fx.workspace, memoryCare: care }, { rootDir: join(fx.root, "input") });
  expect(freezeDreamCare(input).state).toBe("ready");
  return { ...fx, care, input, file, suffix, receipt: input.path.replace(/\.json$/u, ".care.json") };
}

it("publishes once, preserving another owner's concurrent append", () => {
  const fx = publicationFixture();
  appendFileSync(join(fx.workspace, "MEMORY.md"), "\nOther owner's fact.\n");
  expect(publishDreamCare(fx.workspace, fx.input).state).toBe("published");
  const bytes = readFileSync(join(fx.workspace, "MEMORY.md"), "utf8");
  expect(publishDreamCare(fx.workspace, fx.input).state).toBe("published");
  expect(readFileSync(join(fx.workspace, "MEMORY.md"), "utf8")).toBe(bytes);
  expect(bytes).toContain("Other owner's fact.");
  expect(bytes.split(fx.suffix)).toHaveLength(2);
});

it("refuses to publish a frozen run into another workspace", () => {
  const fx = publicationFixture();
  expect(() => publishDreamCare(join(fx.root, "other-workspace"), fx.input)).toThrow("workspace-mismatch");
  expect(existsSync(join(fx.root, "other-workspace"))).toBe(false);
});

it("refuses a changed source reference without replacing its new facts", () => {
  const fx = publicationFixture(), source = join(fx.workspace, "memory/references/source.md");
  appendFileSync(source, "\nNewer source fact.\n");
  expect(publishDreamCare(fx.workspace, fx.input)).toMatchObject({ state: "refused", reason: "dream-care-source-changed" });
  expect(readFileSync(source, "utf8")).toContain("Newer source fact.");
  expect(existsSync(join(fx.workspace, fx.file))).toBe(false);
});

it("refuses an occupied reference path without overwriting it or appending the index", () => {
  const fx = publicationFixture(), file = join(fx.workspace, fx.file);
  writeFileSync(file, "Other owner's reference.\n");
  expect(publishDreamCare(fx.workspace, fx.input).state).toBe("refused");
  expect(readFileSync(file, "utf8")).toBe("Other owner's reference.\n");
  expect(readFileSync(join(fx.workspace, "MEMORY.md"), "utf8")).not.toContain(fx.suffix);
});

it("does not blindly retry an append with an unknown prior outcome", () => {
  const fx = publicationFixture(), receipt = JSON.parse(readFileSync(fx.receipt, "utf8"));
  receipt.state = "appending"; writeFileSync(fx.receipt, JSON.stringify(receipt));
  expect(publishDreamCare(fx.workspace, fx.input)).toMatchObject({ state: "unknown", reason: "index-append-outcome-unknown" });
  expect(publishDreamCare(fx.workspace, fx.input).state).toBe("unknown");
  expect(readFileSync(join(fx.workspace, "MEMORY.md"), "utf8")).not.toContain(fx.suffix);
});
