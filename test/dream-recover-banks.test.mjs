import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cmdDream } from "../cli/dream.mjs";
import { writeDreamOwnerInput } from "../core/dream-owner.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const roots = [], saved = { home: process.env.HOME, janitor: process.env.AMUX_JANITOR_ENABLED };
afterEach(() => {
  process.env.HOME = saved.home;
  if (saved.janitor === undefined) delete process.env.AMUX_JANITOR_ENABLED; else process.env.AMUX_JANITOR_ENABLED = saved.janitor;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A finished night: the curator's file exists, nothing is published, and no compact or journal evidence is recorded. */
function finishedNight() {
  const root = mkdtempSync(join(tmpdir(), "dream-recover-bank-"));
  roots.push(root); process.env.HOME = root; process.env.AMUX_JANITOR_ENABLED = "false";
  const workspace = join(root, "workspace"), dateKey = "2026-09-08";
  mkdirSync(join(workspace, "memory"), { recursive: true });
  const memoryBefore = `# ${dateKey}\n\nManual note.\n`;
  writeFileSync(join(workspace, "memory", `${dateKey}.md`), memoryBefore);
  writeFileSync(join(workspace, "MEMORY.md"), "- [old](memory/old.md)\n");
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "test@example.com"); git(workspace, "config", "user.name", "Test");
  git(workspace, "add", "."); git(workspace, "commit", "-q", "-m", "base");
  // The curator has added its index line since the last commit.
  writeFileSync(join(workspace, "MEMORY.md"), "- [old](memory/old.md)\n- [care](memory/references/care-2026-09-08.md)\n");
  const input = writeDreamOwnerInput({ schemaVersion: 1, memoryFormat: 3, dateKey, createdAt: "2026-09-08T00:00:00Z", workspace,
    memoryBeforeSha256: createHash("sha256").update(memoryBefore).digest("hex"), memoryGuard: { blocks: [] },
    owner: { agent: "sandman", pane: 0, engine: "claude" },
    payload: { panes: [{ pane: "source:2", turns: [{ user: "Fix the current bug", at: "2026-09-07T20:00:00Z" }] }] },
    omitted: [], unreadable: [] });
  writeFileSync(input.outputPath,
    `> Kuraterad av sandman:0 efter verifierad kompaktering · run \`${input.runId}\` · source \`${input.sha256}\`.\n- Natten sammanfattad.\n`);
  return { workspace, input, run: (extra = {}) => cmdDream({ configPath: join(root, "none.yaml"), agent: {} },
    { recover: input.path, "source-sha256": input.sha256, workspace, ...extra }, {}) };
}

describe("amux dream --recover", () => {
  it("publishes a finished night that has no compact or journal evidence, then commits the memory it changed", async () => {
    const night = finishedNight();
    const result = await night.run();
    expect(result.recovered).toBe(true);
    const files = git(night.workspace, "show", "--name-only", "--format=%s", "HEAD").split("\n");
    expect(files[0]).toMatch(/^chore\(memory\): bank/);
    expect(files).toContain("MEMORY.md");
    expect(files.some(file => file.startsWith("memory/dream/"))).toBe(true);
    expect(git(night.workspace, "status", "--porcelain")).toBe("");
  });

  it("commits what an earlier recovery left uncommitted", async () => {
    const night = finishedNight();
    await night.run({ dry: false });
    writeFileSync(join(night.workspace, "MEMORY.md"), "- [old](memory/old.md)\n- [care](memory/references/care-2026-09-08.md)\n- [more](memory/x.md)\n");
    const again = await night.run();
    expect(again.alreadyCommitted).toBe(true);
    expect(git(night.workspace, "status", "--porcelain")).toBe("");
  });
});
