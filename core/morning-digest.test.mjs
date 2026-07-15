import { unit, feature, expect } from "bdd-vitest";
import { composeMorningDigest, digestProjects, boardDecisionItem } from "./morning-digest.mjs";

feature("morning digest composition", () => {
  unit("an empty queue composes to null so a silent day sends nothing", {
    when: ["composing with no inputs", () => composeMorningDigest({})],
    then: ["null", (result) => expect(result).toBeNull()],
  });

  unit("collects todos, board decisions and open asks into one bounded message", {
    when: ["composing a full morning", () => composeMorningDigest({
      todoSummary: "2 aktiva: betala fakturan; boka service",
      boardDecisions: [
        { project: "source", id: "SRC-0030", title: "Scoping: close-mekanismen" },
        { project: "source", id: "SRC-0038", title: "Standing-order-registret" },
      ],
      openAsks: [
        { key: "ai:2", promptPreview: "Färg A eller B?", ageMs: 3 * 3_600_000 },
      ],
    })],
    then: ["one message with all three sections", (result) => {
      expect(result).toContain("God morgon! Din kö:");
      expect(result).toContain("📋 Todos: 2 aktiva");
      expect(result).toContain("🎫 Väntar på ditt svar på boarden (2):");
      expect(result).toContain("SRC-0030 [source] Scoping: close-mekanismen");
      expect(result).toContain("🙋 Öppna frågor från panes (1):");
      expect(result).toContain("ai:2 (3h): Färg A eller B?");
    }],
  });

  unit("caps each section and reports the remainder honestly", {
    when: ["composing with nine decisions", () => composeMorningDigest({
      boardDecisions: Array.from({ length: 9 }, (_, index) => ({
        project: "source", id: `SRC-${index}`, title: `Beslut ${index}` })),
    })],
    then: ["five listed plus an honest tail", (result) => {
      expect(result).toContain("(9):");
      expect(result).toContain("SRC-4");
      expect(result).not.toContain("SRC-5 ");
      expect(result).toContain("… +4 till");
    }],
  });

  unit("board read-failures page loudly instead of reading as an empty queue", {
    when: ["composing with only a failure", () => composeMorningDigest({
      boardFailures: ["skydive"],
    })],
    then: ["the failure IS the message", (result) => {
      expect(result).toContain("⚠️ Kunde inte läsa board: skydive");
      expect(result).toContain("INTE verifierad");
    }],
  });
});

feature("digest board inputs", () => {
  unit("fleets.conf rows with a project column become unique digest projects", {
    when: ["parsing a conf with comments, missing columns and duplicates", () => digestProjects(
      `# comment\nskydive 2 /repo/a,/repo/b skydive\nlsrc 2 /repo/c source\nnoproj 2 /repo/d\nlsrc2 2 /repo/e source\n`)],
    then: ["two unique projects", (result) => {
      expect(result.map((item) => item.project)).toEqual(["skydive", "source"]);
    }],
  });

  unit("decision items collapse whitespace and bound the title", {
    when: ["shaping a messy ticket", () => boardDecisionItem("source",
      { id: "SRC-0011", title: `  En\n  titel   med ${"x".repeat(100)}` })],
    then: ["single-line 70-char title", (item) => {
      expect(item.id).toBe("SRC-0011");
      expect(item.title.length).toBeLessThanOrEqual(70);
      expect(item.title).not.toContain("\n");
    }],
  });
});
