import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installReleaseSkills } from "./release-skills.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-release-skills-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  const home = join(root, "home");
  const source = join(packageRoot, "skills", "example");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "release skill\n");
  const links = [".codex", ".claude"].map((provider) => {
    const parent = join(home, provider, "skills");
    mkdirSync(parent, { recursive: true });
    const link = join(parent, "example");
    symlinkSync(source, link);
    return link;
  });
  return { packageRoot, home, source, links };
}

describe("release skill isolation", () => {
  it("migrates provider links so a skill edit cannot change installed release bytes", () => {
    const ctx = fixture();
    installReleaseSkills(ctx);
    writeFileSync(join(ctx.links[0], "SKILL.md"), "operator edit\n");
    expect(readFileSync(join(ctx.source, "SKILL.md"), "utf8")).toBe("release skill\n");
    expect(readFileSync(join(ctx.links[1], "SKILL.md"), "utf8")).toBe("operator edit\n");
    expect(realpathSync(ctx.links[0])).toBe(join(ctx.home, ".agentmux", "skills", "example"));
  });

  it("keeps updates idempotent and preserves local edits before refreshing the shared copy", () => {
    const ctx = fixture();
    installReleaseSkills(ctx);
    expect(installReleaseSkills(ctx).backups).toEqual([]);
    writeFileSync(join(ctx.links[0], "SKILL.md"), "local edit\n");
    writeFileSync(join(ctx.source, "SKILL.md"), "new release\n");
    const result = installReleaseSkills(ctx);
    expect(result.backups).toHaveLength(1);
    expect(readFileSync(join(result.backups[0], "SKILL.md"), "utf8")).toBe("local edit\n");
    expect(readFileSync(join(ctx.links[0], "SKILL.md"), "utf8")).toBe("new release\n");
  });

  it("preserves independently installed provider skills", () => {
    const ctx = fixture();
    rmSync(ctx.links[0]);
    mkdirSync(ctx.links[0]);
    writeFileSync(join(ctx.links[0], "SKILL.md"), "personal skill\n");
    const result = installReleaseSkills(ctx);
    expect(result.preserved).toContain(ctx.links[0]);
    expect(readFileSync(join(ctx.links[0], "SKILL.md"), "utf8")).toBe("personal skill\n");
  });
});
