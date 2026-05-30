import { feature, unit, expect } from "bdd-vitest";
import { evaluateContract, extractSymbols, overlapRatio } from "./contract-lint.mjs";

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
});
