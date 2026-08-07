import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveKimiHome,
  ensureKimiWorkspaceTrusted,
  kimiWorkDirKey,
  normalizeKimiWorkDir,
  slugifyKimiWorkDirName,
} from "./kimi-workspace-trust.mjs";

// Golden pairs captured from this host's live ~/.kimi-code/workspace-trust/
// (2026-08-07). If these stop matching, upstream changed the key derivation
// and the pre-seed silently stops working — that is exactly when this test
// must scream.
const LIVE_PAIRS = [
  ["/home/adelost/lsrc/swoop-sim/.agents/10", "wd_10_144cb76a0d22"],
  ["/home/adelost/lsrc/.agents/10", "wd_10_72fc3c304e98"],
  ["/home/adelost/lsrc/skydive-altimeter/.agents/7", "wd_7_647934e9df7f"],
  ["/home/adelost/lsrc/ai-dsl/.agents/7", "wd_7_8de7b70ec9d9"],
  ["/home/adelost/.openclaw/workspace/.agents/8", "wd_8_9a142d9be521"],
];

feature("kimi workdir key derivation mirrors kimi-code 0.34.0", () => {
  unit("matches the five live trust-doc filenames", {
    given: ["live pairs", () => LIVE_PAIRS],
    when: ["deriving keys", (pairs) => pairs.map(([dir]) => kimiWorkDirKey(dir))],
    then: ["all match", (keys) => {
      keys.forEach((key, i) => expect(key).toBe(LIVE_PAIRS[i][1]));
    }],
  });

  unit("slugify handles hostile basenames like upstream", {
    given: ["names", () => null],
    when: ["slugging", () => [
      slugifyKimiWorkDirName("My Project!"),
      slugifyKimiWorkDirName(".."),
      slugifyKimiWorkDirName(""),
      slugifyKimiWorkDirName("--"),
    ]],
    then: ["expected slugs", (slugs) => {
      expect(slugs).toEqual(["my-project", "workspace", "workspace", "workspace"]);
    }],
  });

  unit("normalize resolves relative paths without touching the filesystem", {
    given: ["relative", () => "some/dir"],
    when: ["normalizing", (dir) => normalizeKimiWorkDir(dir)],
    then: ["absolute", (out) => expect(out.startsWith("/")).toBe(true)],
  });
});

feature("ensureKimiWorkspaceTrusted", () => {
  const withStore = (run) => {
    const home = mkdtempSync(join(tmpdir(), "kimi-trust-test-"));
    try { return run(home); } finally { rmSync(home, { recursive: true, force: true }); }
  };

  unit("seeds a doc with the exact upstream shape", {
    given: ["empty home", () => mkdtempSync(join(tmpdir(), "kimi-trust-"))],
    when: ["ensuring", (home) => {
      const result = ensureKimiWorkspaceTrusted({ kimiHome: home, workDir: "/tmp/x-pane", now: 123 });
      let written = null;
      try { written = readFileSync(result.path, "utf-8"); } catch {}
      const out = { result, written };
      rmSync(home, { recursive: true, force: true });
      return out;
    }],
    then: ["doc on disk, compact JSON, no trailing newline", ({ result, written }) => {
      expect(result.status).toBe("seeded");
      expect(written).toBe(JSON.stringify({ root: "/tmp/x-pane", trustedAt: 123 }));
    }],
  });

  unit("is idempotent and preserves the original trustedAt", {
    given: ["seeded home", () => {
      const home = mkdtempSync(join(tmpdir(), "kimi-trust-"));
      ensureKimiWorkspaceTrusted({ kimiHome: home, workDir: "/tmp/x-pane", now: 111 });
      return home;
    }],
    when: ["ensuring again", (home) => {
      const second = ensureKimiWorkspaceTrusted({ kimiHome: home, workDir: "/tmp/x-pane", now: 999 });
      const content = readFileSync(second.path, "utf-8");
      const out = { second, content };
      rmSync(home, { recursive: true, force: true });
      return out;
    }],
    then: ["present, trustedAt untouched", ({ second, content }) => {
      expect(second.status).toBe("present");
      expect(JSON.parse(content).trustedAt).toBe(111);
    }],
  });

  unit("rewrites a corrupt doc instead of trusting it", {
    given: ["corrupt doc", () => {
      const home = mkdtempSync(join(tmpdir(), "kimi-trust-"));
      const first = ensureKimiWorkspaceTrusted({ kimiHome: home, workDir: "/tmp/x-pane", now: 1 });
      writeFileSync(first.path, "{not json");
      return { home, path: first.path };
    }],
    when: ["ensuring", ({ home, path }) => {
      const result = ensureKimiWorkspaceTrusted({ kimiHome: home, workDir: "/tmp/x-pane", now: 5 });
      const content = readFileSync(path, "utf-8");
      rmSync(home, { recursive: true, force: true });
      return { result, content };
    }],
    then: ["reseeded with valid JSON", ({ result, content }) => {
      expect(result.status).toBe("seeded");
      expect(JSON.parse(content).trustedAt).toBe(5);
    }],
  });

  unit("never throws on a read-only home", {
    given: ["broken home", () => {
      const home = mkdtempSync(join(tmpdir(), "kimi-trust-"));
      const blocked = join(home, "workspace-trust");
      writeFileSync(blocked, "a file occupies the store dir path");
      return home;
    }],
    when: ["ensuring", (home) => {
      const result = ensureKimiWorkspaceTrusted({ kimiHome: home, workDir: "/tmp/x-pane" });
      rmSync(home, { recursive: true, force: true });
      return result;
    }],
    then: ["status error, launch may proceed", (result) => {
      expect(result.status).toBe("error");
      expect(result.error.length).toBeGreaterThan(0);
    }],
  });
});

feature("effectiveKimiHome", () => {
  unit("profile home wins, then env, then default", {
    given: ["inputs", () => null],
    when: ["resolving", () => [
      effectiveKimiHome({ profileHome: "/p", env: { KIMI_CODE_HOME: "/e" } }),
      effectiveKimiHome({ env: { KIMI_CODE_HOME: "/e" } }),
      effectiveKimiHome({ env: {} }),
    ]],
    then: ["order", (homes) => {
      expect(homes[0]).toBe("/p");
      expect(homes[1]).toBe("/e");
      expect(homes[2].endsWith("/.kimi-code")).toBe(true);
    }],
  });
});
