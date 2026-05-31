import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { evaluateContract, extractSymbols, formatLintReport, lintRoot, lintRoots, overlapRatio, writeBaseline } from "./contract-lint.mjs";

// Real WHAT/WHY rewrites from ai-dsl + skydive-altimeter. The linter must pass
// every one with zero error-level findings — they are the gold voice.
const GOOD = [
  ["SimpleTracker", "Assigns stable IDs to boxes with greedy IoU matching.", "Keeps fallback video workers stable when a backend lacks instance IDs."],
  ["OperationSpec", "Describes the pool function, request model, and handler for one operation.", "Keeps FastAPI routes from embedding Modal dispatch details."],
  ["WarmupRule", "Maps one warmup request to the pool that will serve matching clicks.", "Prevents green warmups from targeting containers that never handle the request."],
  ["NoopOperationContext", "Stubs progress, cancellation, and event hooks for on-demand handlers.", "Keeps single-result pool calls independent from the streaming job runtime."],
  ["mediaPathAliases", "Expands one media identifier into comparable local, Modal, and URL aliases.", "Keeps source matching independent from deployment path shapes."],
  ["mediaPathsMatch", "Compares media identifiers after normalization and alias expansion.", "Keeps job ownership checks from duplicating path and proxy-cache rules."],
  ["CompassEngine", "Filters compass and rotation-vector samples into a stable heading.", "Keeps map rotation and compass UI from depending on raw sensor quirks."],
  ["AltimeterState", "Carries live altitude, pressure, vertical-speed, and sensor-health values.", "Separates safety math from display smoothing and diagnostics."],
  ["AltimeterEngine", "Turns barometer pressure into relative altitude and vertical speed.", "Keeps sensors, HUD, and tests on one altitude pipeline."],
  ["FlightSettingsStore", "Defines persistence for flight-planning settings.", "Keeps the calculator independent from Android storage."],
  ["AltitudeReferenceCalculator", "Calculates active and restorable altitude references from pressure history.", "Keeps recovery math testable across forecast and METAR sources."],
];

// Real failures the linter must catch.
const BAD = [
  ["exists+echo", "Assigns stable IDs to boxes.", "It exists to assign stable IDs when tracking is needed."],
  ["echo restate", "Describes one operation.", "Used by operations to describe operations."],
  ["truthful filler", "Provides context to handlers.", "This keeps context truthful."],
];

const errorCodes = (doc, name) =>
  evaluateContract(doc, { name, kind: "class" }).filter((f) => f.sev === "error").map((f) => f.code);

feature("contract-lint contract floor", () => {
  unit("gold-voice rewrites pass with zero errors", {
    given: ["the real WHAT/WHY rewrites", () => GOOD],
    when: ["evaluating each", (good) => good
      .map(([name, what, why]) => ({ name, errors: errorCodes(`WHAT: ${what}\nWHY: ${why}`, name) }))
      .filter((r) => r.errors.length > 0)],
    then: ["none has error findings", (failed) => expect(failed).toEqual([])],
  });

  unit("bad contracts all fail", {
    given: ["the known-bad contracts", () => BAD],
    when: ["evaluating each", (bad) => bad
      .map(([name, what, why]) => ({ name, errors: errorCodes(`WHAT: ${what}\nWHY: ${why}`, name) }))
      .filter((r) => r.errors.length === 0)],
    then: ["none passed silently", (passed) => expect(passed).toEqual([])],
  });

  unit("missing WHAT tag flags CONTRACT010", {
    given: ["a why-only doc", () => "WHY: Keeps X from Y."],
    when: ["evaluating", (doc) => errorCodes(doc, "T")],
    then: ["CONTRACT010 present", (codes) => expect(codes).toContain("CONTRACT010")],
  });

  unit("missing WHY tag flags CONTRACT011", {
    given: ["a what-only doc", () => "WHAT: Filters samples."],
    when: ["evaluating", (doc) => errorCodes(doc, "T")],
    then: ["CONTRACT011 present", (codes) => expect(codes).toContain("CONTRACT011")],
  });

  unit("banned phrase flags CONTRACT020", {
    given: ["a doc with 'It exists as'", () => "WHAT: Stubs hooks.\nWHY: It exists as the lightweight fallback for workers."],
    when: ["evaluating", (doc) => errorCodes(doc, "T")],
    then: ["CONTRACT020 present", (codes) => expect(codes).toContain("CONTRACT020")],
  });

  unit("WHY without boundary marker flags CONTRACT030", {
    given: ["a why that rewords what", () => "WHAT: Tracks boxes.\nWHY: Tracks boxes when detections arrive."],
    when: ["evaluating", (doc) => errorCodes(doc, "T")],
    then: ["CONTRACT030 present", (codes) => expect(codes).toContain("CONTRACT030")],
  });

  unit("boundary marker keeps 'simple' legal", {
    given: ["a real boundary using the word simple", () => "WHAT: Stores persisted user preferences.\nWHY: Keeps migrations simple and settings inspectable."],
    when: ["evaluating", (doc) => errorCodes(doc, "PowerSettings")],
    then: ["no error findings", (codes) => expect(codes).toEqual([])],
  });

  unit("DTO tag satisfies the contract", {
    given: ["a pure transport shape", () => "DTO: Pixel coordinate in segmentation request payloads."],
    when: ["evaluating", (doc) => errorCodes(doc, "Point")],
    then: ["no error findings", (codes) => expect(codes).toEqual([])],
  });

  unit("DTO tag is rejected for domain state symbols", {
    given: ["a state symbol using DTO", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-contract-lint-"));
      writeFileSync(join(root, "AltimeterState.kt"), "/**\n * DTO: Live altitude values.\n */\ndata class AltimeterState(val relativeAltitudeM: Float = 0f)\n");
      return root;
    }],
    when: ["linting", (root) => lintRoot(root)],
    then: ["CONTRACT042 is reported", (result, root) => {
      try {
        expect(result.findings.map((f) => f.code)).toContain("CONTRACT042");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("action debt tag satisfies missing WHAT/WHY but remains visible debt", {
    given: ["a remove-tagged legacy symbol", () => "REMOVE: Unused legacy SAM2 path; no registered caller after SAM3 migration."],
    when: ["evaluating", (doc) => evaluateContract(doc, { name: "LegacySam2", kind: "class" })],
    then: ["it reports debt, not missing WHAT/WHY", (findings) => {
      expect(findings.map((f) => f.code)).toEqual(["CONTRACT050"]);
      expect(findings[0].sev).toBe("debt");
      expect(findings[0].msg).toContain("REMOVE:");
    }],
  });

  unit("generic DEBT is allowed only when it names a concrete action", {
    given: ["a refactor debt note", () => "DEBT: Refactor into VideoIndex; duplicate search state makes ownership unclear."],
    when: ["evaluating", (doc) => evaluateContract(doc, { name: "SearchState", kind: "class" })],
    then: ["it records debt without warning", (findings) => {
      expect(findings.map((f) => f.code)).toEqual(["CONTRACT050"]);
      expect(findings[0].sev).toBe("debt");
    }],
  });

  unit("generic DEBT without an action is warned", {
    given: ["a vague debt note", () => "DEBT: unclear old code."],
    when: ["evaluating", (doc) => evaluateContract(doc, { name: "Mystery", kind: "class" })],
    then: ["it records debt and asks for a real action", (findings) => {
      expect(findings.map((f) => f.code)).toEqual(["CONTRACT050", "CONTRACT052"]);
    }],
  });

  unit("empty debt tag is not enough", {
    given: ["an empty merge tag", () => "MERGE:"],
    when: ["evaluating", (doc) => evaluateContract(doc, { name: "DuplicateHit", kind: "class" })],
    then: ["it reports the empty debt tag", (findings) => {
      expect(findings.map((f) => f.code)).toEqual(["CONTRACT051"]);
      expect(findings[0].sev).toBe("error");
    }],
  });

  unit("FLAG is not a contract state", {
    given: ["a vague flag tag", () => "FLAG: maybe delete later."],
    when: ["evaluating", (doc) => errorCodes(doc, "MaybeDead")],
    then: ["missing WHAT/WHY still fails", (codes) => {
      expect(codes).toContain("CONTRACT010");
      expect(codes).toContain("CONTRACT011");
    }],
  });

  unit("empty doc flags CONTRACT001", {
    given: ["no doc at all", () => ""],
    when: ["evaluating", (doc) => errorCodes(doc, "Bare")],
    then: ["CONTRACT001 present", (codes) => expect(codes).toContain("CONTRACT001")],
  });

  // Skydive false-positive regressions: mid-sentence "used to" means "utilized to",
  // and "caller is responsible for" names a real boundary — neither is filler.
  unit("mid-sentence 'used to' is not banned", {
    given: ["a legit utilized-to phrase", () => "WHAT: Holds the wall-clock used to compute drift.\nWHY: Keeps drift math off the render path."],
    when: ["evaluating", (doc) => errorCodes(doc, "T")],
    then: ["no banned-phrase finding", (codes) => {
      expect(codes.includes("CONTRACT020")).toBe(false);
      expect(codes.includes("CONTRACT021")).toBe(false);
    }],
  });

  unit("'caller is responsible for' is not banned", {
    given: ["a caller-contract WHY", () => "WHAT: Loads PMTiles for a region.\nWHY: Keeps failures explicit so the caller is responsible for translating them."],
    when: ["evaluating", (doc) => errorCodes(doc, "T")],
    then: ["no banned-phrase finding", (codes) => expect(codes.includes("CONTRACT021")).toBe(false)],
  });

  unit("'truthful boundary' domain wording is not banned", {
    given: ["domain use of truthful", () => "WHAT: Draws the dashed coverage ring.\nWHY: Keeps the ring from reading as a truthful boundary it cannot guarantee."],
    when: ["evaluating", (doc) => errorCodes(doc, "T")],
    then: ["no banned-phrase finding", (codes) => expect(codes.includes("CONTRACT020")).toBe(false)],
  });

  unit("leading 'Used to' opener still fails", {
    given: ["a lazy opener", () => "WHAT: Stores rows.\nWHY: Used to group settings rows."],
    when: ["evaluating", (doc) => errorCodes(doc, "T")],
    then: ["CONTRACT021 present", (codes) => expect(codes).toContain("CONTRACT021")],
  });

  // Three.js 'createAxesHelper': "axes helper for X" uses helper as a domain noun,
  // not lazy self-description. Only the "Helper for X" opener is filler.
  unit("mid-sentence domain 'helper for' is not banned", {
    given: ["a Three.js axes-helper doc", () => "WHAT: Creates an axes helper for debugging the scene.\nWHY: Keeps debug gizmos out of the production render."],
    when: ["evaluating", (doc) => errorCodes(doc, "createAxesHelper")],
    then: ["no banned-phrase finding", (codes) => {
      expect(codes.includes("CONTRACT020")).toBe(false);
      expect(codes.includes("CONTRACT021")).toBe(false);
    }],
  });

  unit("leading 'Helper for' opener still fails", {
    given: ["a lazy helper opener", () => "WHAT: Builds the parser.\nWHY: Helper for parsing config files."],
    when: ["evaluating", (doc) => errorCodes(doc, "T")],
    then: ["CONTRACT021 present", (codes) => expect(codes).toContain("CONTRACT021")],
  });
});

feature("contract-lint helpers", () => {
  unit("echo overlap detects reworded WHY", {
    given: ["a reworded pair", () => ["Describes one operation", "Used by operations to describe operations"]],
    when: ["measuring overlap", ([what, why]) => overlapRatio(what, why)],
    then: ["overlap is high", (ratio) => expect(ratio >= 0.5).toBe(true)],
  });

  unit("real boundary WHY shares few content words", {
    given: ["a boundary pair", () => ["Filters compass samples into a stable heading", "Keeps map rotation from raw sensor quirks"]],
    when: ["measuring overlap", ([what, why]) => overlapRatio(what, why)],
    then: ["overlap is low", (ratio) => expect(ratio < 0.3).toBe(true)],
  });

  unit("extracts a Python class docstring", {
    given: ["a documented class", () => 'class Foo:\n    """WHAT: Does a thing.\n\n    WHY: Keeps callers from knowing the thing.\n    """\n    pass\n'],
    when: ["extracting", (src) => extractSymbols(src, ".py")],
    then: ["one symbol with the doc", (syms) => {
      expect(syms.length).toBe(1);
      expect(syms[0].name).toBe("Foo");
      expect(syms[0].doc.includes("WHAT:")).toBe(true);
    }],
  });

  unit("extracts a Kotlin KDoc", {
    given: ["a documented class", () => "/**\n * WHAT: Filters samples into a heading.\n * WHY: Keeps UI from raw sensor quirks.\n */\nclass CompassEngine {\n}\n"],
    when: ["extracting", (src) => extractSymbols(src, ".kt")],
    then: ["one symbol with the doc", (syms) => {
      expect(syms.length).toBe(1);
      expect(syms[0].name).toBe("CompassEngine");
      expect(syms[0].doc.includes("WHY:")).toBe(true);
    }],
  });

  unit("baseline filters existing located findings", {
    given: ["one missing contract and a baseline", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-contract-baseline-"));
      writeFileSync(join(root, "demo.py"), "class Demo:\n    pass\n");
      const baselinePath = join(root, ".amux-lint-baseline.json");
      writeBaseline(baselinePath, [lintRoot(root)]);
      return { root, baselinePath };
    }],
    when: ["linting with baseline", ({ root, baselinePath }) => lintRoots([root], { baselinePath })[0]],
    then: ["active findings are empty", (result, { root }) => {
      try {
        expect(result.findings.length).toBe(1);
        expect(result.activeFindings).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("baseline survives line shifts (fingerprint excludes line number)", {
    given: ["a baselined 2-class file, then a new class inserted above both", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-contract-shift-"));
      const f = join(root, "demo.py");
      writeFileSync(f, "class Alpha:\n    pass\n\n\nclass Beta:\n    pass\n");
      const baselinePath = join(root, ".amux-lint-baseline.json");
      writeBaseline(baselinePath, [lintRoot(root)]);
      writeFileSync(f, "class Gamma:\n    pass\n\n\nclass Alpha:\n    pass\n\n\nclass Beta:\n    pass\n");
      return { root, baselinePath };
    }],
    when: ["linting with the pre-shift baseline", ({ root, baselinePath }) => lintRoots([root], { baselinePath })[0]],
    then: ["only the new class is active; shifted Alpha/Beta stay suppressed", (result, { root }) => {
      try {
        const msgs = result.activeFindings.map((f) => f.msg);
        expect(msgs.length > 0).toBe(true);
        expect(msgs.every((m) => m.includes("Gamma"))).toBe(true);
        expect(msgs.some((m) => m.includes("Alpha") || m.includes("Beta"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("one baseline spans multiple roots", {
    given: ["two roots each with an undocumented class under one combined baseline", () => {
      const a = mkdtempSync(join(tmpdir(), "amux-contract-mr-a-"));
      const b = mkdtempSync(join(tmpdir(), "amux-contract-mr-b-"));
      writeFileSync(join(a, "x.py"), "class Ax:\n    pass\n");
      writeFileSync(join(b, "y.py"), "class By:\n    pass\n");
      const baselinePath = join(a, ".amux-lint-baseline.json");
      writeBaseline(baselinePath, [lintRoot(a), lintRoot(b)]);
      return { a, b, baselinePath };
    }],
    when: ["linting both roots with the combined baseline", ({ a, b, baselinePath }) => lintRoots([a, b], { baselinePath })],
    then: ["both roots are fully suppressed by the one baseline", (results, { a, b }) => {
      try {
        expect(results.length).toBe(2);
        expect(results[0].activeFindings).toEqual([]);
        expect(results[1].activeFindings).toEqual([]);
      } finally {
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
      }
    }],
  });
});

feature("contract-lint scope + guidance", () => {
  // Kotlin extraction must mirror Python's top-level scope: methods, nested types,
  // companion objects, and private/internal decls are NOT documented boundaries.
  unit("extracts only the top-level public Kotlin class", {
    given: ["a class with a nested enum, a method, a private fn, and a companion", () =>
      "/**\n * WHAT: Turns pressure into altitude.\n * WHY: Keeps sensors and HUD on one pipeline.\n */\n"
      + "class AltimeterEngine {\n    enum class Trend { UP, DOWN }\n    fun onPressure(p: Float) {}\n"
      + "    private fun emit() {}\n    companion object {\n        fun pressureToAltitude(p: Float) = 0f\n    }\n}\n"],
    when: ["extracting", (src) => extractSymbols(src, ".kt").map((s) => s.name)],
    then: ["only the top-level class survives", (names) => expect(names).toEqual(["AltimeterEngine"])],
  });

  unit("skips a top-level private Kotlin function", {
    given: ["a private and a public top-level fun", () => "private fun helper() {}\nfun publicOne() {}\n"],
    when: ["extracting", (src) => extractSymbols(src, ".kt").map((s) => s.name)],
    then: ["only the public function survives", (names) => expect(names).toEqual(["publicOne"])],
  });

  unit("missing WHY does not also flag CONTRACT030", {
    given: ["a what-only doc", () => "WHAT: Filters samples."],
    when: ["evaluating", (doc) => evaluateContract(doc, { name: "T" }).map((f) => f.code)],
    then: ["CONTRACT011 yes, CONTRACT030 no (no double-flag)", (codes) => {
      expect(codes).toContain("CONTRACT011");
      expect(codes.includes("CONTRACT030")).toBe(false);
    }],
  });

  unit("findings carry a Try suggestion an agent can act on", {
    given: ["an undocumented class file", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-contract-tip-"));
      writeFileSync(join(root, "x.kt"), "class Bare\n");
      return root;
    }],
    when: ["linting", (root) => lintRoot(root)],
    then: ["at least one finding has a suggestion", (result, root) => {
      try {
        expect(result.findings.some((f) => f.suggestion)).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("report separates debt from ordinary findings", {
    given: ["one debt class and one undocumented class", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-contract-debt-report-"));
      writeFileSync(join(root, "x.py"), 'class Old:\n    """REFACTOR: Move into VideoIndex; duplicate ownership with search state."""\n    pass\n\nclass Bare:\n    pass\n');
      return root;
    }],
    when: ["formatting the lint report", (root) => formatLintReport([lintRoot(root)])],
    then: ["debt count and debt section are visible", (report, root) => {
      try {
        expect(report).toContain("debt: 1");
        expect(report).toContain("Debt:");
        expect(report).toContain("CONTRACT050");
        expect(report).toContain("Findings:");
        expect(report).toContain("CONTRACT001");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });
});
