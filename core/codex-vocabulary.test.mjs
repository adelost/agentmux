// The Codex composer vocabulary is a copy of Codex's own source; these tests
// pin the copy to exact literals and prove the tripwire that catches drift.

import { feature, unit, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_VOCABULARY, codexVocabularyStrings, describeCodexVocabularyDrift, describeNonEmptyComposer,
} from "./codex-vocabulary.mjs";
import {
  locateInstalledCodex, probeCodexVocabulary, scanFileForStrings,
} from "./codex-vocabulary-probe.mjs";

const CHUNK = 8 * 1024 * 1024;

const probeOf = (overrides = {}) => ({
  installedVersion: "0.152.1", verifiedVersion: "0.152.1", checked: 6, missing: [], ...overrides,
});

const fakeInstall = (version) => ({
  version, binaryPath: "/fake/codex", launcher: "/fake/bin/codex.js", packageRoot: "/fake",
});

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "amux-codex-vocab-"));
  try { return run(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

feature("Codex composer vocabulary", () => {
  unit("the pinned text is exactly what Codex 0.152.1 paints into an empty composer", {
    then: ["placeholders and version are the chatwidget.rs literals", () => {
      expect(CODEX_VOCABULARY.verifiedCodexVersion).toBe("0.152.1");
      expect([...CODEX_VOCABULARY.placeholders]).toEqual([
        "Ask Codex to do anything",
        "Ask a follow-up question",
      ]);
      expect(codexVocabularyStrings()).toEqual([
        "Ask Codex to do anything",
        "Ask a follow-up question",
        " to queue message",
        " to queue",
        " to edit previous message",
        "No previous message to edit.",
      ]);
    }],
  });

  unit("the 0.144 rotating placeholders are gone on purpose", {
    then: ["no retired string survives in the pinned copy", () => {
      for (const retired of ["Explain this codebase", "Summarize recent commits", "Will this algorithm scale well?"]) {
        expect(codexVocabularyStrings()).not.toContain(retired);
      }
    }],
  });
});

feature("Codex binary scan", () => {
  unit("a needle straddling the chunk boundary is still found", {
    when: ["scanning a file where the placeholder starts 5 bytes before the first chunk ends", () => withTempDir((dir) => {
      const needle = "Ask Codex to do anything";
      const body = Buffer.alloc(CHUNK + 64, 0x78);
      body.write(needle, CHUNK - 5, "utf8");
      const path = join(dir, "codex");
      writeFileSync(path, body);
      return scanFileForStrings(path, [needle, "Explain this codebase"]);
    })],
    then: ["the present needle is found and the absent one reported missing", (result) => {
      expect(result).toEqual({ found: ["Ask Codex to do anything"], missing: ["Explain this codebase"] });
    }],
  });

  unit("UTF-8 needles are matched as bytes", {
    when: ["scanning a small file with a · in it", () => withTempDir((dir) => {
      const path = join(dir, "codex");
      writeFileSync(path, "prefix GPS-BASED · CAN OVERREAD suffix", "utf8");
      return scanFileForStrings(path, [" · ", "· CAN"]);
    })],
    then: ["both are found", (result) => expect(result.missing).toEqual([])],
  });
});

feature("Codex install discovery", () => {
  unit("no codex on PATH is an explicit error, never a silent skip", {
    when: ["locating with an empty PATH", () => withTempDir((dir) => locateInstalledCodex({ env: { PATH: dir } }))],
    then: ["the reason is named", (result) => expect(result).toEqual({ error: "codex is not on PATH" })],
  });

  unit("the npm layout resolves launcher, version and native binary", {
    when: ["locating through a symlinked launcher like nvm installs", () => withTempDir((dir) => {
      const pkg = join(dir, "lib", "node_modules", "@openai", "codex");
      const native = join(pkg, "node_modules", "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      mkdirSync(native, { recursive: true });
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\n");
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.152.1" }));
      writeFileSync(join(native, "codex"), "ELF Ask Codex to do anything");
      symlinkSync(join(pkg, "bin", "codex.js"), join(dir, "bin", "codex"));
      const result = locateInstalledCodex({ env: { PATH: join(dir, "bin") } });
      return { result, native: join(native, "codex") };
    })],
    then: ["version and binary path are the installed ones", ({ result, native }) => {
      expect(result.error).toBeUndefined();
      expect(result.version).toBe("0.152.1");
      expect(result.binaryPath).toBe(native);
    }],
  });

  unit("a launcher without a native binary is an error", {
    when: ["locating a package whose vendor directory is missing", () => withTempDir((dir) => {
      const pkg = join(dir, "pkg");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      writeFileSync(join(pkg, "bin", "codex"), "");
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.152.1" }));
      return locateInstalledCodex({ env: { PATH: join(pkg, "bin") } });
    })],
    then: ["the missing binary is named", (result) => {
      expect(result.error).toMatch(/^no native codex binary under /);
    }],
  });
});

feature("Codex vocabulary probe", () => {
  unit("an unlocatable Codex yields an error probe with the pinned version", {
    when: ["probing with a failing locator", () => probeCodexVocabulary({
      locate: () => ({ error: "codex is not on PATH" }), cache: false,
    })],
    then: ["the probe carries the error and no false facts", (probe) => {
      expect(probe).toEqual({
        error: "codex is not on PATH", installedVersion: null, verifiedVersion: "0.152.1", checked: 0, missing: [],
      });
    }],
  });

  unit("missing strings are reported per needle", {
    when: ["the binary lacks one placeholder", () => probeCodexVocabulary({
      locate: () => fakeInstall("0.153.0"),
      identity: () => "id-1",
      scan: (_path, needles) => ({
        found: needles.filter((n) => n !== "Ask Codex to do anything"),
        missing: ["Ask Codex to do anything"],
      }),
      cache: false,
    })],
    then: ["the probe names it against the installed version", (probe) => {
      expect(probe).toMatchObject({
        installedVersion: "0.153.0", verifiedVersion: "0.152.1", checked: 6, missing: ["Ask Codex to do anything"],
      });
    }],
  });

  unit("the 250 MB scan runs once per binary identity", {
    when: ["probing three times across one binary replacement", () => {
      let scans = 0;
      const scan = () => { scans++; return { found: [], missing: [] }; };
      let id = "size:1";
      const probe = () => probeCodexVocabulary({
        locate: () => fakeInstall("0.152.1"), identity: () => id, scan, cache: true,
      });
      probe(); probe();
      id = "size:2";
      probe();
      return scans;
    }],
    then: ["two scans: one per identity", (scans) => expect(scans).toBe(2)],
  });
});

feature("Naming Codex vocabulary drift", () => {
  unit("a verified match is silent", {
    then: ["null", () => expect(describeCodexVocabularyDrift(probeOf())).toBeNull()],
  });

  unit("missing strings are named with the version they were verified for", {
    when: ["describing a probe with one missing placeholder", () => describeCodexVocabularyDrift(probeOf({
      installedVersion: "0.153.0", missing: ["Ask Codex to do anything"],
    }))],
    then: ["the sentence carries both versions and the literal", (text) => {
      expect(text).toBe('Codex 0.153.0 no longer contains 1/6 known composer strings ("Ask Codex to do anything"); the vocabulary was verified for 0.152.1');
    }],
  });

  unit("a newer Codex with every string present is still flagged as unverified", {
    when: ["describing a version-only drift", () => describeCodexVocabularyDrift(probeOf({ installedVersion: "0.153.0" }))],
    then: ["the sentence says verified-for, not broken", (text) => {
      expect(text).toBe("Codex 0.153.0 is installed but the composer vocabulary was verified for 0.152.1 (all 6 strings still present)");
    }],
  });

  unit("a probe error is surfaced, not swallowed", {
    when: ["describing an error probe", () => describeCodexVocabularyDrift(probeOf({ error: "codex is not on PATH" }))],
    then: ["the reason is in the sentence", (text) => {
      expect(text).toBe("Codex composer vocabulary is unverified: codex is not on PATH");
    }],
  });
});

feature("Describing a non-empty composer", () => {
  unit("a driver without a probe gets the plain sentence", {
    when: ["describing with a bare driver", () => describeNonEmptyComposer({}, "hello world")],
    then: ["no drift clause is invented", (text) =>
      expect(text).toBe("composer is not empty (starts with: hello world)")],
  });

  unit("drift is appended with the pointer to doctor", {
    when: ["describing with a drifting probe", () => describeNonEmptyComposer(
      { codexVocabularyDrift: async () => "Codex 0.153.0 is installed but the composer vocabulary was verified for 0.152.1 (all 6 strings still present)" },
      "Ask Codex to build anything",
    )],
    then: ["the sentence names the drift and the likely cause", (text) => {
      expect(text).toBe(
        "composer is not empty (starts with: Ask Codex to build anything); "
        + "Codex 0.153.0 is installed but the composer vocabulary was verified for 0.152.1 (all 6 strings still present); "
        + "an unrecognised empty-composer placeholder is the likely cause, see amux doctor",
      );
    }],
  });

  unit("a probe that throws is reported, never swallowed into a clean-looking refusal", {
    when: ["describing with a broken probe", () => describeNonEmptyComposer(
      { codexVocabularyDrift: async () => { throw new Error("EACCES"); } }, "x",
    )],
    then: ["the failure is in the sentence", (text) =>
      expect(text).toContain("Codex composer vocabulary probe failed: EACCES")],
  });

  unit("the head is overridable for the different-draft path and the text is capped", {
    when: ["describing a long draft with a custom head", () => describeNonEmptyComposer(
      { codexVocabularyDrift: async () => null }, "y".repeat(100), { head: "composer contains a different draft" },
    )],
    then: ["sixty characters of draft follow the custom head", (text) =>
      expect(text).toBe(`composer contains a different draft (starts with: ${"y".repeat(60)})`)],
  });
});
